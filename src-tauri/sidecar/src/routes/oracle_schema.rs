//! Oracle introspection for the `/schema/:connId/:action` endpoints.
//!
//! Oracle maps onto the Postgres-style tree: the connection's service is the
//! single "database" and each (non-Oracle-maintained) user is a schema. An
//! empty schema binds as NULL, and `NVL(:1, CURRENT_SCHEMA)` then falls back
//! to the session's own schema. Aliases are quoted lowercase so the JSON keys
//! match what the other dialects return.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde_json::{json, Value};

use super::schema::{build_order_clause, s_of};
use crate::db::{self, DbClient};
use crate::error::SidecarError;

const OWNER: &str = "NVL(:1, SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA'))";

fn owner_bind(schema: Option<&str>) -> &str {
    schema.unwrap_or("")
}

pub fn qident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn qliteral(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

async fn fetch(client: &DbClient, conn_id: &str, trace_db: &str, sql: &str, binds: &[&str]) -> Result<Vec<Value>, SidecarError> {
    db::oracle_fetch(client, conn_id, trace_db, sql, binds).await
}

fn int_of(row: &Value, key: &str) -> Option<i64> {
    match row.get(key) {
        Some(Value::Number(n)) => n.as_i64(),
        Some(Value::String(s)) => s.parse().ok(),
        _ => None,
    }
}

/// The session's current schema, for callers that need the name itself.
async fn current_schema(client: &DbClient, conn_id: &str, trace_db: &str, schema: Option<&str>) -> Result<String, SidecarError> {
    if let Some(schema) = schema.filter(|s| !s.is_empty()) {
        return Ok(schema.to_string());
    }
    let rows = fetch(client, conn_id, trace_db, "SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') AS \"s\" FROM dual", &[]).await?;
    Ok(rows.first().map(|row| s_of(row, "s")).unwrap_or_default())
}

// ---------------------------------------------------------------------------
// Databases, schemas, catalog, tables, objects
// ---------------------------------------------------------------------------

pub async fn database_names(client: &DbClient, conn_id: &str, trace_db: &str) -> Result<Vec<String>, SidecarError> {
    // A full connect descriptor makes a poor label; ask the server instead.
    if !trace_db.is_empty() && !trace_db.starts_with('(') {
        return Ok(vec![trace_db.to_string()]);
    }
    let rows = fetch(client, conn_id, trace_db, "SELECT SYS_CONTEXT('USERENV', 'SERVICE_NAME') AS \"s\" FROM dual", &[]).await?;
    Ok(rows.iter().map(|row| s_of(row, "s")).collect())
}

/// The session's own schema comes first; the app selects the first schema.
pub async fn schemas(client: &DbClient, conn_id: &str, trace_db: &str) -> Result<Value, SidecarError> {
    let rows = fetch(
        client,
        conn_id,
        trace_db,
        "SELECT username AS \"name\" FROM all_users \
         WHERE oracle_maintained = 'N' OR username = SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') \
         ORDER BY CASE WHEN username = SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') THEN 0 ELSE 1 END, username",
        &[],
    )
    .await?;
    let schemas: Vec<String> = rows.iter().map(|row| s_of(row, "name")).collect();
    Ok(json!({ "schemas": schemas }))
}

pub async fn catalog(client: &DbClient, conn_id: &str, trace_db: &str, databases: &[String], current_db: Option<&str>) -> Result<Vec<Value>, SidecarError> {
    let rows = fetch(
        client,
        conn_id,
        trace_db,
        "SELECT o.owner AS \"schema\", o.object_name AS \"name\", \
            CASE o.object_type WHEN 'VIEW' THEN 'VIEW' ELSE 'BASE TABLE' END AS \"type\" \
         FROM all_objects o JOIN all_users u ON u.username = o.owner \
         WHERE o.object_type IN ('TABLE', 'VIEW') AND o.secondary = 'N' AND o.object_name NOT LIKE 'BIN$%' \
           AND (u.oracle_maintained = 'N' OR o.owner = SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA')) \
         ORDER BY o.owner, o.object_name",
        &[],
    )
    .await?;
    let db = current_db.filter(|d| !d.is_empty()).map(str::to_string).or_else(|| databases.first().cloned()).unwrap_or_default();
    Ok(rows
        .iter()
        .map(|row| json!({ "db": db, "schema": s_of(row, "schema"), "name": s_of(row, "name"), "type": s_of(row, "type") }))
        .collect())
}

pub async fn tables(client: &DbClient, conn_id: &str, trace_db: &str, schema: Option<&str>) -> Result<Value, SidecarError> {
    let owner = owner_bind(schema);
    let sql = format!(
        "SELECT table_name AS \"name\", 'BASE TABLE' AS \"type\" FROM all_tables \
         WHERE owner = {OWNER} AND nested = 'NO' AND secondary = 'N' AND dropped = 'NO' \
           AND (iot_type IS NULL OR iot_type = 'IOT') \
         UNION ALL \
         SELECT view_name, 'VIEW' FROM all_views WHERE owner = {} \
         ORDER BY 1",
        OWNER.replace(":1", ":2"),
    );
    let rows = fetch(client, conn_id, trace_db, &sql, &[owner, owner]).await?;
    let tables: Vec<Value> = rows.iter().map(|r| json!({ "name": s_of(r, "name"), "type": s_of(r, "type") })).collect();
    Ok(json!({ "tables": tables }))
}

/// Tables, views and stored code. Procedures and packages are listed with the
/// functions; `identity` carries the real object type for DBMS_METADATA.
pub async fn objects(client: &DbClient, conn_id: &str, trace_db: &str, schema: Option<&str>) -> Result<Vec<Value>, SidecarError> {
    let owner = owner_bind(schema);
    let sql = format!(
        "SELECT o.object_name AS \"name\", \
            CASE o.object_type WHEN 'TABLE' THEN 'TABLE' WHEN 'VIEW' THEN 'VIEW' ELSE 'FUNCTION' END AS \"object_type\", \
            o.object_type AS \"identity\", \
            CASE WHEN o.object_type IN ('FUNCTION', 'PROCEDURE') THEN \
              (SELECT LISTAGG(a.argument_name || ' ' || a.data_type, ', ') WITHIN GROUP (ORDER BY a.position) \
               FROM all_arguments a \
               WHERE a.owner = o.owner AND a.object_name = o.object_name AND a.package_name IS NULL \
                 AND a.position > 0 AND a.data_level = 0) \
            WHEN o.object_type = 'PACKAGE' THEN 'package' END AS \"signature\" \
         FROM all_objects o \
         WHERE o.owner = {OWNER} AND o.secondary = 'N' AND o.object_name NOT LIKE 'BIN$%' \
           AND o.object_type IN ('TABLE', 'VIEW', 'FUNCTION', 'PROCEDURE', 'PACKAGE') \
         ORDER BY 2, 1, 4"
    );
    let rows = fetch(client, conn_id, trace_db, &sql, &[owner]).await?;
    Ok(rows
        .iter()
        .map(|row| {
            json!({
                "name": s_of(row, "name"),
                "type": s_of(row, "object_type"),
                "identity": s_of(row, "identity"),
                "signature": s_of(row, "signature"),
            })
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Columns, indexes, foreign keys
// ---------------------------------------------------------------------------

/// The declared type as it would be written in DDL.
fn formatted_type(row: &Value) -> String {
    let data_type = s_of(row, "data_type");
    let precision = int_of(row, "data_precision");
    let scale = int_of(row, "data_scale");
    let char_length = int_of(row, "char_length").unwrap_or(0);
    match data_type.as_str() {
        "NUMBER" => match (precision, scale) {
            (None, None) => "NUMBER".into(),
            (None, Some(scale)) => format!("NUMBER(*,{scale})"),
            (Some(p), None | Some(0)) => format!("NUMBER({p})"),
            (Some(p), Some(s)) => format!("NUMBER({p},{s})"),
        },
        "FLOAT" => precision.map_or("FLOAT".into(), |p| format!("FLOAT({p})")),
        "VARCHAR2" | "CHAR" => {
            let unit = if s_of(row, "char_used") == "C" { " CHAR" } else { "" };
            format!("{data_type}({char_length}{unit})")
        }
        "NVARCHAR2" | "NCHAR" => format!("{data_type}({char_length})"),
        "RAW" => format!("RAW({})", int_of(row, "data_length").unwrap_or(0)),
        _ => data_type,
    }
}

pub async fn columns(client: &DbClient, conn_id: &str, trace_db: &str, schema: Option<&str>, table: &str) -> Result<Value, SidecarError> {
    let owner = owner_bind(schema);
    // DATA_DEFAULT is a LONG, so it is selected as-is and trimmed here.
    let sql = format!(
        "SELECT c.column_name AS \"column_name\", c.data_type AS \"data_type\", c.data_precision AS \"data_precision\", \
            c.data_scale AS \"data_scale\", c.char_length AS \"char_length\", c.char_used AS \"char_used\", \
            c.data_length AS \"data_length\", c.nullable AS \"nullable\", c.data_default AS \"data_default\", \
            c.column_id AS \"ordinal_position\", c.virtual_column AS \"virtual_column\", \
            i.generation_type AS \"generation_type\", cm.comments AS \"comment\" \
         FROM all_tab_cols c \
         LEFT JOIN all_tab_identity_cols i ON i.owner = c.owner AND i.table_name = c.table_name AND i.column_name = c.column_name \
         LEFT JOIN all_col_comments cm ON cm.owner = c.owner AND cm.table_name = c.table_name AND cm.column_name = c.column_name \
         WHERE c.owner = {OWNER} AND c.table_name = :2 AND c.hidden_column = 'NO' \
         ORDER BY c.column_id"
    );
    let rows = fetch(client, conn_id, trace_db, &sql, &[owner, table]).await?;
    let keys = fetch(
        client,
        conn_id,
        trace_db,
        &format!(
            "SELECT cc.column_name AS \"column_name\", k.constraint_type AS \"kind\", \
                (SELECT COUNT(*) FROM all_cons_columns x WHERE x.owner = k.owner AND x.constraint_name = k.constraint_name) AS \"width\" \
             FROM all_constraints k \
             JOIN all_cons_columns cc ON cc.owner = k.owner AND cc.constraint_name = k.constraint_name \
             WHERE k.owner = {OWNER} AND k.table_name = :2 AND k.constraint_type IN ('P', 'U')"
        ),
        &[owner, table],
    )
    .await?;
    let mut primary: HashSet<String> = HashSet::new();
    let mut unique: HashSet<String> = HashSet::new();
    for key in &keys {
        let column = s_of(key, "column_name");
        match s_of(key, "kind").as_str() {
            "P" => {
                primary.insert(column);
            }
            _ if int_of(key, "width") == Some(1) => {
                unique.insert(column);
            }
            _ => {}
        }
    }

    let columns: Vec<Value> = rows
        .iter()
        .map(|row| {
            let name = s_of(row, "column_name");
            let default = s_of(row, "data_default").trim().to_string();
            let is_virtual = s_of(row, "virtual_column") == "YES";
            let generation = s_of(row, "generation_type");
            let extra = if !generation.is_empty() {
                format!("GENERATED {generation} AS IDENTITY")
            } else if is_virtual {
                format!("GENERATED ALWAYS AS ({default}) VIRTUAL")
            } else {
                String::new()
            };
            // Identity and virtual columns keep their expression in DATA_DEFAULT.
            let column_default = if extra.is_empty() && !default.is_empty() { Value::from(default) } else { Value::Null };
            let key = if primary.contains(&name) { "PRI" } else if unique.contains(&name) { "UNI" } else { "" };
            json!({
                "column_name": name,
                "data_type": s_of(row, "data_type"),
                "formatted_type": formatted_type(row),
                "is_nullable": if s_of(row, "nullable") == "N" { "NO" } else { "YES" },
                "column_default": column_default,
                "ordinal_position": row.get("ordinal_position").cloned().unwrap_or(Value::Null),
                "column_key": key,
                "extra": extra,
                "comment": s_of(row, "comment"),
            })
        })
        .collect();
    Ok(json!({ "columns": columns }))
}

pub async fn indexes(client: &DbClient, conn_id: &str, trace_db: &str, schema: Option<&str>, table: &str) -> Result<Value, SidecarError> {
    let owner = owner_bind(schema);
    let rows = fetch(
        client,
        conn_id,
        trace_db,
        &format!(
            "SELECT i.owner AS \"index_owner\", i.table_owner AS \"table_owner\", i.index_name AS \"name\", \
                i.uniqueness AS \"uniqueness\", i.index_type AS \"index_type\", \
                ic.column_name AS \"column_name\", ic.column_position AS \"position\", ic.descend AS \"descend\", \
                (SELECT MAX(k.constraint_type) FROM all_constraints k \
                 WHERE k.owner = i.table_owner AND k.table_name = i.table_name AND k.index_name = i.index_name \
                   AND k.constraint_type = 'P') AS \"pk\" \
             FROM all_indexes i \
             JOIN all_ind_columns ic ON ic.index_owner = i.owner AND ic.index_name = i.index_name \
             WHERE i.table_owner = {OWNER} AND i.table_name = :2 AND i.index_type <> 'LOB' \
             ORDER BY i.index_name, ic.column_position"
        ),
        &[owner, table],
    )
    .await?;
    // Function-based index keys: ALL_IND_COLUMNS names a hidden SYS_NC column,
    // the expression itself is a LONG in ALL_IND_EXPRESSIONS.
    let expressions = fetch(
        client,
        conn_id,
        trace_db,
        &format!(
            "SELECT index_name AS \"name\", column_position AS \"position\", column_expression AS \"expression\" \
             FROM all_ind_expressions WHERE table_owner = {OWNER} AND table_name = :2"
        ),
        &[owner, table],
    )
    .await?;
    let expression_at: HashMap<(String, i64), String> = expressions
        .iter()
        .map(|row| ((s_of(row, "name"), int_of(row, "position").unwrap_or(0)), s_of(row, "expression")))
        .collect();

    struct Index {
        owner: String,
        table_owner: String,
        unique: bool,
        primary: bool,
        method: String,
        columns: Vec<String>,
        keys: Vec<String>,
        expression: bool,
    }
    let mut grouped: BTreeMap<String, Index> = BTreeMap::new();
    for row in &rows {
        let name = s_of(row, "name");
        let index = grouped.entry(name.clone()).or_insert_with(|| Index {
            owner: s_of(row, "index_owner"),
            table_owner: s_of(row, "table_owner"),
            unique: s_of(row, "uniqueness") == "UNIQUE",
            primary: s_of(row, "pk") == "P",
            method: s_of(row, "index_type"),
            columns: Vec::new(),
            keys: Vec::new(),
            expression: false,
        });
        let position = int_of(row, "position").unwrap_or(0);
        let descending = if s_of(row, "descend") == "DESC" { " DESC" } else { "" };
        // A DESC key is stored as a hidden expression that is just the quoted
        // column name; only real expressions make an index function-based.
        let plain_column = |expression: &str| {
            expression.len() > 2 && expression.starts_with('"') && expression.ends_with('"') && !expression[1..expression.len() - 1].contains('"')
        };
        match expression_at.get(&(name, position)).filter(|expression| !plain_column(expression)) {
            Some(expression) => {
                index.expression = true;
                index.keys.push(format!("{expression}{descending}"));
            }
            None => {
                let column = match expression_at.get(&(s_of(row, "name"), position)) {
                    Some(expression) => expression.trim_matches('"').to_string(),
                    None => s_of(row, "column_name"),
                };
                index.keys.push(format!("{}{descending}", qident(&column)));
                index.columns.push(column);
            }
        }
    }

    let indexes: Vec<Value> = grouped
        .into_iter()
        .map(|(name, index)| {
            let bitmap = if index.method.starts_with("BITMAP") { "BITMAP " } else { "" };
            let definition = format!(
                "CREATE {}{bitmap}INDEX {}.{} ON {}.{} ({})",
                if index.unique { "UNIQUE " } else { "" },
                qident(&index.owner),
                qident(&name),
                qident(&index.table_owner),
                qident(table),
                index.keys.join(", "),
            );
            json!({
                "name": name,
                "unique": index.unique,
                "primary": index.primary,
                "columns": index.columns,
                "definition": definition,
                "method": index.method,
                "expression_sql": if index.expression { Value::from(index.keys.join(", ")) } else { Value::Null },
            })
        })
        .collect();
    Ok(json!({ "indexes": indexes }))
}

pub async fn foreign_keys(client: &DbClient, conn_id: &str, trace_db: &str, schema: Option<&str>, table: &str) -> Result<Value, SidecarError> {
    let owner = owner_bind(schema);
    let rows = fetch(
        client,
        conn_id,
        trace_db,
        &format!(
            "SELECT c.constraint_name AS \"constraint_name\", cc.column_name AS \"column_name\", \
                r.owner AS \"foreign_table_schema\", r.table_name AS \"foreign_table_name\", \
                rc.column_name AS \"foreign_column_name\", 'NO ACTION' AS \"on_update\", \
                c.delete_rule AS \"on_delete\", cc.position AS \"ordinal_position\" \
             FROM all_constraints c \
             JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name \
             JOIN all_constraints r ON r.owner = c.r_owner AND r.constraint_name = c.r_constraint_name \
             JOIN all_cons_columns rc ON rc.owner = r.owner AND rc.constraint_name = r.constraint_name AND rc.position = cc.position \
             WHERE c.constraint_type = 'R' AND c.owner = {OWNER} AND c.table_name = :2 \
             ORDER BY c.constraint_name, cc.position"
        ),
        &[owner, table],
    )
    .await?;
    Ok(json!({ "foreignKeys": rows }))
}

// ---------------------------------------------------------------------------
// DDL (DBMS_METADATA)
// ---------------------------------------------------------------------------

/// Leave storage and segment clauses out; end each statement with `;`.
const METADATA_TRANSFORMS: &str = "BEGIN \
    DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'SEGMENT_ATTRIBUTES', FALSE); \
    DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'STORAGE', FALSE); \
    DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'SQLTERMINATOR', TRUE); \
    DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'PRETTY', TRUE); \
    END;";

/// DDL for one object plus optional dependent DDL, run on one session so the
/// transforms apply. Dependent kinds with nothing to show (ORA-31608) are
/// skipped.
async fn metadata_ddl(
    client: &DbClient,
    conn_id: &str,
    trace_db: &str,
    object_type: &str,
    name: &str,
    owner: &str,
    extra_objects: Vec<(String, String)>,
    dependents: &[&str],
) -> Result<String, SidecarError> {
    let DbClient::Oracle(session) = client else {
        return Err(SidecarError::msg("Unexpected connection type"));
    };
    let sql = format!("SELECT DBMS_METADATA.GET_DDL({}, {}, {}) FROM dual", qliteral(object_type), qliteral(name), qliteral(owner));
    let dependents: Vec<String> = dependents
        .iter()
        .map(|kind| format!("SELECT DBMS_METADATA.GET_DEPENDENT_DDL({}, {}, {}) FROM dual", qliteral(kind), qliteral(name), qliteral(owner)))
        .collect();
    let extras: Vec<String> = extra_objects
        .iter()
        .map(|(kind, object)| format!("SELECT DBMS_METADATA.GET_DDL({}, {}, {}) FROM dual", qliteral(kind), qliteral(object), qliteral(owner)))
        .collect();
    let trace_sql = sql.clone();
    let text = db::traced_result(conn_id, trace_db, &trace_sql, |_: &String| Some(1), async {
        session
            .run(move |conn| {
                let read = |sql: &str| -> Result<String, oracledb::Error> {
                    Ok(conn.query_row(sql, &[])?.get::<Option<String>>(0)?.unwrap_or_default().trim().to_string())
                };
                conn.execute(METADATA_TRANSFORMS, &[])?;
                let mut parts = vec![read(&sql)?];
                for extra in extras.iter().chain(dependents.iter()) {
                    match read(extra) {
                        Ok(text) if !text.is_empty() => parts.push(text),
                        Ok(_) => {}
                        Err(error) if error.to_string().contains("ORA-31608") => {}
                        Err(error) => return Err(error),
                    }
                }
                Ok(parts.join("\n\n"))
            })
            .await
    })
    .await?;
    Ok(text)
}

pub async fn table_ddl(client: &DbClient, conn_id: &str, trace_db: &str, schema: Option<&str>, table: &str) -> Result<Value, SidecarError> {
    let owner = current_schema(client, conn_id, trace_db, schema).await?;
    let kinds = fetch(
        client,
        conn_id,
        trace_db,
        "SELECT object_type AS \"kind\" FROM all_objects \
         WHERE owner = :1 AND object_name = :2 AND object_type IN ('TABLE', 'VIEW', 'MATERIALIZED VIEW') \
         ORDER BY CASE object_type WHEN 'MATERIALIZED VIEW' THEN 0 ELSE 1 END",
        &[&owner, table],
    )
    .await?;
    let kind = kinds.first().map(|row| s_of(row, "kind")).unwrap_or_else(|| "TABLE".to_string());
    if kind != "TABLE" {
        let ddl = metadata_ddl(client, conn_id, trace_db, &kind.replace(' ', "_"), table, &owner, Vec::new(), &["COMMENT"]).await?;
        return Ok(json!({ "ddl": ddl }));
    }
    // Indexes that back a PRIMARY KEY / UNIQUE constraint are already part of
    // the table DDL.
    let index_rows = fetch(
        client,
        conn_id,
        trace_db,
        "SELECT i.index_name AS \"name\" FROM all_indexes i \
         WHERE i.table_owner = :1 AND i.table_name = :2 AND i.index_type <> 'LOB' AND i.owner = i.table_owner \
           AND NOT EXISTS (SELECT 1 FROM all_constraints c WHERE c.owner = i.table_owner AND c.table_name = i.table_name \
                           AND c.index_name = i.index_name AND c.constraint_type IN ('P', 'U')) \
         ORDER BY i.index_name",
        &[&owner, table],
    )
    .await?;
    let extra: Vec<(String, String)> = index_rows.iter().map(|row| ("INDEX".to_string(), s_of(row, "name"))).collect();
    let ddl = metadata_ddl(client, conn_id, trace_db, "TABLE", table, &owner, extra, &["COMMENT", "TRIGGER"]).await?;
    Ok(json!({ "ddl": ddl }))
}

/// Functions, procedures and packages; `identity` is the Oracle object type.
pub async fn object_ddl(client: &DbClient, conn_id: &str, trace_db: &str, schema: Option<&str>, name: &str, identity: Option<&str>) -> Result<Value, SidecarError> {
    let owner = current_schema(client, conn_id, trace_db, schema).await?;
    let object_type = match identity.unwrap_or("FUNCTION") {
        kind @ ("FUNCTION" | "PROCEDURE" | "PACKAGE") => kind,
        other => return Err(SidecarError::msg(format!("Unsupported Oracle object type: {other}"))),
    };
    let ddl = metadata_ddl(client, conn_id, trace_db, object_type, name, &owner, Vec::new(), &[]).await?;
    Ok(json!({ "ddl": ddl }))
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
pub async fn rows(
    client: &DbClient,
    conn_id: &str,
    trace_db: &str,
    schema: Option<&str>,
    table: &str,
    limit: i64,
    offset: i64,
    order_by: Option<&str>,
    where_sql: &str,
) -> Result<Value, SidecarError> {
    let owner = current_schema(client, conn_id, trace_db, schema).await?;
    let column_rows = fetch(
        client,
        conn_id,
        trace_db,
        "SELECT column_name AS \"name\" FROM all_tab_cols \
         WHERE owner = :1 AND table_name = :2 AND hidden_column = 'NO' ORDER BY column_id",
        &[&owner, table],
    )
    .await?;
    let all_cols: Vec<String> = column_rows.iter().map(|row| s_of(row, "name")).collect();
    let order_clause = build_order_clause("oracle", &all_cols, order_by);
    // OFFSET/FETCH needs Oracle 12c or later.
    let query = format!(
        "SELECT * FROM {}.{}{where_sql}{order_clause} OFFSET {} ROWS FETCH NEXT {limit} ROWS ONLY",
        qident(&owner),
        qident(table),
        offset.max(0),
    );
    let estimate = fetch(
        client,
        conn_id,
        trace_db,
        "SELECT num_rows AS \"estimate\" FROM all_tables WHERE owner = :1 AND table_name = :2",
        &[&owner, table],
    )
    .await?
    .first()
    .and_then(|row| int_of(row, "estimate"))
    .unwrap_or(0);
    let output = db::fetch_raw(client, conn_id, trace_db, &query).await?;
    let columns = if output.columns.is_empty() { all_cols } else { output.columns };
    Ok(json!({
        "columns": columns,
        "rows": output.rows,
        "totalEstimate": estimate,
        "query": query,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn declared_types_round_trip_to_ddl_form() {
        let t = |v: Value| formatted_type(&v);
        assert_eq!(t(json!({"data_type": "NUMBER", "data_precision": 10, "data_scale": 0})), "NUMBER(10)");
        assert_eq!(t(json!({"data_type": "NUMBER", "data_precision": 12, "data_scale": 2})), "NUMBER(12,2)");
        assert_eq!(t(json!({"data_type": "NUMBER"})), "NUMBER");
        assert_eq!(t(json!({"data_type": "NUMBER", "data_scale": 0})), "NUMBER(*,0)");
        assert_eq!(t(json!({"data_type": "VARCHAR2", "char_length": 50, "char_used": "B"})), "VARCHAR2(50)");
        assert_eq!(t(json!({"data_type": "VARCHAR2", "char_length": 50, "char_used": "C"})), "VARCHAR2(50 CHAR)");
        assert_eq!(t(json!({"data_type": "NVARCHAR2", "char_length": 20, "char_used": "C"})), "NVARCHAR2(20)");
        assert_eq!(t(json!({"data_type": "RAW", "data_length": 16})), "RAW(16)");
        assert_eq!(t(json!({"data_type": "TIMESTAMP(6) WITH TIME ZONE"})), "TIMESTAMP(6) WITH TIME ZONE");
    }

    #[test]
    fn identifiers_and_literals_escape_quotes() {
        assert_eq!(qident("we\"ird"), "\"we\"\"ird\"");
        assert_eq!(qliteral("it's"), "'it''s'");
    }
}
