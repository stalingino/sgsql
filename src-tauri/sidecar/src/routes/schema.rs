use axum::extract::{Path, Query};
use axum::response::Response;
use serde_json::{json, Map, Value};
use std::collections::HashMap;

use super::{error_response, json_response, with_connection_status};
use crate::db::{self, DbClient};
use crate::error::SidecarError;
use crate::pool;
use crate::trace;

fn s_of(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

/// Quote an identifier per dialect.
pub fn quote_ident(db_type: &str, name: &str) -> String {
    if db_type == "mysql" {
        format!("`{name}`")
    } else {
        format!("\"{name}\"")
    }
}

fn pg_qident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn pg_qliteral(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn backtick(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

// ---------------------------------------------------------------------------
// GET /schema/:connId/:action — dispatcher
// ---------------------------------------------------------------------------

struct SchemaParams {
    db: Option<String>,
    schema: Option<String>,
    table: Option<String>,
    limit: i64,
    offset: i64,
    order_by: Option<String>,
    where_clause: Option<String>,
}

pub async fn handle_schema_request(
    Path((connection_id, action)): Path<(String, String)>,
    Query(raw): Query<HashMap<String, String>>,
) -> Response {
    println!("[sidecar] schema request: /schema/{connection_id}/{action}");

    let Some(record) = pool::get_record(&connection_id) else {
        return error_response("Connection not found. Call /connections/open first.", 404);
    };
    let trace_db = record.profile.database.clone();

    let params = SchemaParams {
        db: raw.get("db").cloned(),
        schema: raw.get("schema").cloned(),
        table: raw.get("table").cloned(),
        limit: raw.get("limit").and_then(|v| v.parse().ok()).unwrap_or(50),
        offset: raw.get("offset").and_then(|v| v.parse().ok()).unwrap_or(0),
        order_by: raw.get("orderBy").cloned(),
        where_clause: raw.get("where").cloned(),
    };

    let attempt = async {
        let (entry, reconnected) = pool::ensure_connection_alive(&connection_id, false).await?;
        let result = dispatch(&entry.client, &connection_id, &trace_db, &action, &params).await?;
        pool::mark_connection_used(&connection_id);
        Ok::<Value, SidecarError>(with_connection_status(result, &connection_id, reconnected))
    }
    .await;

    match attempt {
        Ok(value) => json_response(200, value),
        Err(error) if error.is_connection_error() => {
            println!("[sidecar] connection error in schema/{action}, attempting reconnect for {connection_id}...");
            let retry = async {
                let entry = pool::reconnect(&connection_id).await?;
                let result = dispatch(&entry.client, &connection_id, &trace_db, &action, &params).await?;
                pool::mark_connection_used(&connection_id);
                Ok::<Value, SidecarError>(with_connection_status(result, &connection_id, true))
            }
            .await;
            match retry {
                Ok(value) => json_response(200, value),
                Err(retry_error) => {
                    let message = retry_error.friendly();
                    eprintln!("[sidecar] reconnect+retry failed for schema/{action}: {message}");
                    error_response(&message, 500)
                }
            }
        }
        Err(error) => {
            let message = error.to_string();
            eprintln!("[sidecar] schema/{action} error: {message}");
            error_response(&message, 500)
        }
    }
}

async fn dispatch(
    client: &DbClient,
    conn_id: &str,
    trace_db: &str,
    action: &str,
    p: &SchemaParams,
) -> Result<Value, SidecarError> {
    let need_table = || {
        p.table
            .clone()
            .filter(|t| !t.is_empty())
            .ok_or_else(|| SidecarError::msg("Missing ?table= param"))
    };
    match action {
        "databases" => get_databases(client, conn_id, trace_db).await,
        "catalog" => get_catalog(client, conn_id, trace_db, p.db.as_deref()).await,
        "schemas" => get_schemas(client, conn_id, trace_db).await,
        "tables" => get_tables(client, conn_id, trace_db, p.db.as_deref(), p.schema.as_deref()).await,
        "columns" => get_columns(client, conn_id, trace_db, p.db.as_deref(), p.schema.as_deref(), &need_table()?).await,
        "indexes" => get_indexes(client, conn_id, trace_db, p.db.as_deref(), p.schema.as_deref(), &need_table()?).await,
        "fks" => get_foreign_keys(client, conn_id, trace_db, p.db.as_deref(), p.schema.as_deref(), &need_table()?).await,
        "ddl" => get_table_ddl(client, conn_id, trace_db, p.db.as_deref(), p.schema.as_deref(), &need_table()?).await,
        "artifacts" => get_table_artifacts(client, conn_id, trace_db, &need_table()?).await,
        "rows" => {
            get_rows(
                client,
                conn_id,
                trace_db,
                p.db.as_deref(),
                p.schema.as_deref(),
                &need_table()?,
                p.limit,
                p.offset,
                p.order_by.as_deref(),
                p.where_clause.as_deref(),
            )
            .await
        }
        other => Err(SidecarError::msg(format!("Unknown schema action: {other}"))),
    }
}

// ---------------------------------------------------------------------------
// Introspection: Databases
// ---------------------------------------------------------------------------

async fn database_names(client: &DbClient, conn_id: &str, trace_db: &str) -> Result<Vec<String>, SidecarError> {
    match client {
        DbClient::Postgres { .. } => {
            let rows = db::pg_fetch(
                client,
                conn_id,
                trace_db,
                "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname",
                &[],
            )
            .await?;
            Ok(rows.iter().map(|r| s_of(r, "datname")).collect())
        }
        DbClient::MySql { .. } => {
            let rows = db::fetch_raw_objects(client, conn_id, trace_db, "SHOW DATABASES").await?;
            Ok(rows.iter().map(|r| s_of(r, "Database")).collect())
        }
        // SQLite has no concept of multiple databases.
        DbClient::Sqlite { .. } => Ok(vec!["main".to_string()]),
    }
}

async fn get_databases(client: &DbClient, conn_id: &str, trace_db: &str) -> Result<Value, SidecarError> {
    Ok(json!({ "databases": database_names(client, conn_id, trace_db).await? }))
}

// ---------------------------------------------------------------------------
// Search catalog: all searchable relations without one request per database
// ---------------------------------------------------------------------------

async fn get_catalog(
    client: &DbClient,
    conn_id: &str,
    trace_db: &str,
    current_db: Option<&str>,
) -> Result<Value, SidecarError> {
    let databases = database_names(client, conn_id, trace_db).await?;
    let tables: Vec<Value> = match client {
        DbClient::Postgres { .. } => {
            let rows = db::pg_fetch(
                client,
                conn_id,
                trace_db,
                "SELECT table_catalog, table_schema, table_name, table_type \
                 FROM information_schema.tables \
                 WHERE table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast') \
                 ORDER BY table_schema, table_name",
                &[],
            )
            .await?;
            rows.iter()
                .map(|row| {
                    let catalog = s_of(row, "table_catalog");
                    let db = current_db
                        .filter(|d| !d.is_empty())
                        .map(str::to_string)
                        .or_else(|| if catalog.is_empty() { None } else { Some(catalog) })
                        .or_else(|| databases.first().cloned())
                        .unwrap_or_default();
                    json!({
                        "db": db,
                        "schema": s_of(row, "table_schema"),
                        "name": s_of(row, "table_name"),
                        "type": s_of(row, "table_type"),
                    })
                })
                .collect()
        }
        DbClient::MySql { .. } => {
            let rows = db::mysql_fetch(
                client,
                conn_id,
                trace_db,
                "SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES ORDER BY TABLE_SCHEMA, TABLE_NAME",
                &[],
            )
            .await?;
            rows.iter()
                .map(|row| {
                    json!({
                        "db": s_of(row, "TABLE_SCHEMA"),
                        "schema": "",
                        "name": s_of(row, "TABLE_NAME"),
                        "type": s_of(row, "TABLE_TYPE"),
                    })
                })
                .collect()
        }
        DbClient::Sqlite { .. } => {
            let rows = db::sqlite_fetch(
                client,
                conn_id,
                trace_db,
                "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
                &[],
            )
            .await?;
            rows.iter()
                .map(|row| {
                    json!({
                        "db": current_db.filter(|d| !d.is_empty()).unwrap_or("main"),
                        "schema": "main",
                        "name": s_of(row, "name"),
                        "type": if s_of(row, "type") == "view" { "VIEW" } else { "BASE TABLE" },
                    })
                })
                .collect()
        }
    };
    Ok(json!({ "databases": databases, "tables": tables }))
}

// ---------------------------------------------------------------------------
// Introspection: Schemas
// ---------------------------------------------------------------------------

async fn get_schemas(client: &DbClient, conn_id: &str, trace_db: &str) -> Result<Value, SidecarError> {
    match client {
        DbClient::Postgres { .. } => {
            let rows = db::pg_fetch(
                client,
                conn_id,
                trace_db,
                "SELECT schema_name FROM information_schema.schemata \
                 WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast') \
                 ORDER BY schema_name",
                &[],
            )
            .await?;
            let schemas: Vec<String> = rows.iter().map(|r| s_of(r, "schema_name")).collect();
            Ok(json!({ "schemas": schemas }))
        }
        // MySQL doesn't have schemas separate from databases.
        DbClient::MySql { .. } => Ok(json!({ "schemas": [] })),
        // SQLite doesn't have schemas.
        DbClient::Sqlite { .. } => Ok(json!({ "schemas": ["main"] })),
    }
}

// ---------------------------------------------------------------------------
// Introspection: Tables
// ---------------------------------------------------------------------------

async fn get_tables(
    client: &DbClient,
    conn_id: &str,
    trace_db: &str,
    db_name: Option<&str>,
    schema: Option<&str>,
) -> Result<Value, SidecarError> {
    match client {
        DbClient::Postgres { .. } => {
            let s = schema.filter(|s| !s.is_empty()).unwrap_or("public");
            let rows = db::pg_fetch(
                client,
                conn_id,
                trace_db,
                "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
                &[s],
            )
            .await?;
            let tables: Vec<Value> = rows
                .iter()
                .map(|r| json!({ "name": s_of(r, "table_name"), "type": s_of(r, "table_type") }))
                .collect();
            Ok(json!({ "tables": tables }))
        }
        DbClient::MySql { .. } => {
            let d = db_name.filter(|d| !d.is_empty()).unwrap_or("information_schema");
            let rows = db::mysql_fetch(
                client,
                conn_id,
                trace_db,
                "SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
                &[d],
            )
            .await?;
            let tables: Vec<Value> = rows
                .iter()
                .map(|r| json!({ "name": s_of(r, "TABLE_NAME"), "type": s_of(r, "TABLE_TYPE") }))
                .collect();
            Ok(json!({ "tables": tables }))
        }
        DbClient::Sqlite { .. } => {
            let rows = db::sqlite_fetch(
                client,
                conn_id,
                trace_db,
                "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
                &[],
            )
            .await?;
            let tables: Vec<Value> = rows
                .iter()
                .map(|r| {
                    json!({
                        "name": s_of(r, "name"),
                        "type": if s_of(r, "type") == "table" { "BASE TABLE" } else { "VIEW" },
                    })
                })
                .collect();
            Ok(json!({ "tables": tables }))
        }
    }
}

// ---------------------------------------------------------------------------
// Introspection: Columns
// ---------------------------------------------------------------------------

async fn get_columns(
    client: &DbClient,
    conn_id: &str,
    trace_db: &str,
    db_name: Option<&str>,
    schema: Option<&str>,
    table: &str,
) -> Result<Value, SidecarError> {
    match client {
        DbClient::Postgres { .. } => {
            let s = schema.filter(|s| !s.is_empty()).unwrap_or("public");
            let sql = "SELECT \
                c.column_name, c.data_type, c.udt_name, \
                pg_catalog.format_type(a.atttypid, a.atttypmod) AS formatted_type, \
                ARRAY(SELECT enumlabel FROM pg_enum WHERE enumtypid = a.atttypid ORDER BY enumsortorder) AS enum_values, \
                c.is_nullable, c.column_default, \
                col_description(cls.oid, a.attnum) AS comment, \
                c.collation_name, \
                CASE WHEN c.is_identity = 'YES' THEN 'GENERATED ' || c.identity_generation || ' AS IDENTITY' ELSE '' END AS identity_clause, \
                CASE WHEN c.is_generated <> 'NEVER' THEN 'GENERATED ALWAYS AS (' || c.generation_expression || ') STORED' ELSE '' END AS generation_clause, \
                c.ordinal_position, \
                CASE WHEN pk.column_name IS NOT NULL THEN 'PRI' WHEN uq.column_name IS NOT NULL THEN 'UNI' ELSE '' END AS column_key \
              FROM information_schema.columns c \
              JOIN pg_namespace ns ON ns.nspname = c.table_schema \
              JOIN pg_class cls ON cls.relnamespace = ns.oid AND cls.relname = c.table_name \
              JOIN pg_attribute a ON a.attrelid = cls.oid AND a.attname = c.column_name AND a.attnum > 0 \
              LEFT JOIN ( \
                SELECT kcu.column_name \
                FROM information_schema.table_constraints tc \
                JOIN information_schema.key_column_usage kcu \
                  ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema \
                WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1 AND tc.table_name = $2 \
              ) pk ON pk.column_name = c.column_name \
              LEFT JOIN ( \
                SELECT max(kcu.column_name) AS column_name \
                FROM information_schema.table_constraints tc \
                JOIN information_schema.key_column_usage kcu \
                  ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema \
                WHERE tc.constraint_type = 'UNIQUE' AND tc.table_schema = $3 AND tc.table_name = $4 \
                GROUP BY tc.constraint_name HAVING COUNT(*) = 1 \
              ) uq ON uq.column_name = c.column_name \
              WHERE c.table_schema = $5 AND c.table_name = $6 \
              ORDER BY c.ordinal_position";
            let rows = db::pg_fetch(client, conn_id, trace_db, sql, &[s, table, s, table, s, table]).await?;
            Ok(json!({ "columns": rows }))
        }
        DbClient::MySql { .. } => {
            let d = db_name.filter(|d| !d.is_empty()).unwrap_or("information_schema");
            let rows = db::mysql_fetch(
                client,
                conn_id,
                trace_db,
                "SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, ORDINAL_POSITION, COLUMN_KEY, EXTRA, COLLATION_NAME, GENERATION_EXPRESSION, COLUMN_COMMENT \
                 FROM information_schema.COLUMNS \
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
                 ORDER BY ORDINAL_POSITION",
                &[d, table],
            )
            .await?;
            let columns: Vec<Value> = rows
                .iter()
                .map(|r| {
                    let collation = s_of(r, "COLLATION_NAME");
                    let generation = s_of(r, "GENERATION_EXPRESSION");
                    let extra_parts: Vec<String> = [
                        if collation.is_empty() { String::new() } else { format!("COLLATE {collation}") },
                        if generation.is_empty() {
                            s_of(r, "EXTRA")
                        } else {
                            format!("GENERATED ALWAYS AS ({generation}) STORED")
                        },
                    ]
                    .into_iter()
                    .filter(|p| !p.is_empty())
                    .collect();
                    json!({
                        "column_name": r.get("COLUMN_NAME").cloned().unwrap_or(Value::Null),
                        "data_type": r.get("DATA_TYPE").cloned().unwrap_or(Value::Null),
                        "column_type": r.get("COLUMN_TYPE").cloned().unwrap_or(Value::Null),
                        "is_nullable": r.get("IS_NULLABLE").cloned().unwrap_or(Value::Null),
                        "column_default": r.get("COLUMN_DEFAULT").cloned().unwrap_or(Value::Null),
                        "ordinal_position": r.get("ORDINAL_POSITION").cloned().unwrap_or(Value::Null),
                        "column_key": r.get("COLUMN_KEY").cloned().unwrap_or(Value::Null),
                        "extra": extra_parts.join(" "),
                        "collation_name": r.get("COLLATION_NAME").cloned().unwrap_or(Value::Null),
                        "generation_expression": r.get("GENERATION_EXPRESSION").cloned().unwrap_or(Value::Null),
                        "column_comment": r.get("COLUMN_COMMENT").cloned().unwrap_or(Value::Null),
                    })
                })
                .collect();
            Ok(json!({ "columns": columns }))
        }
        DbClient::Sqlite { .. } => {
            let rows = db::fetch_raw_objects(client, conn_id, trace_db, &format!("PRAGMA table_info(\"{table}\")")).await?;
            let columns: Vec<Value> = rows
                .iter()
                .map(|r| {
                    let notnull = r.get("notnull").and_then(Value::as_i64).unwrap_or(0);
                    let cid = r.get("cid").and_then(Value::as_i64).unwrap_or(0);
                    let pk = r.get("pk").and_then(Value::as_i64).unwrap_or(0);
                    json!({
                        "column_name": r.get("name").cloned().unwrap_or(Value::Null),
                        "data_type": r.get("type").cloned().unwrap_or(Value::Null),
                        "is_nullable": if notnull == 0 { "YES" } else { "NO" },
                        "column_default": r.get("dflt_value").cloned().unwrap_or(Value::Null),
                        "ordinal_position": cid + 1,
                        "column_key": if pk == 1 { "PRI" } else { "" },
                    })
                })
                .collect();
            Ok(json!({ "columns": columns }))
        }
    }
}

// ---------------------------------------------------------------------------
// Introspection: Indexes
// ---------------------------------------------------------------------------

async fn get_indexes(
    client: &DbClient,
    conn_id: &str,
    trace_db: &str,
    db_name: Option<&str>,
    schema: Option<&str>,
    table: &str,
) -> Result<Value, SidecarError> {
    match client {
        DbClient::Postgres { .. } => {
            let s = schema.filter(|s| !s.is_empty()).unwrap_or("public");
            let sql = "SELECT idx.relname AS indexname, pg_get_indexdef(idx.oid) AS indexdef, \
                ix.indisprimary AS primary, am.amname AS method, \
                pg_get_expr(ix.indexprs, ix.indrelid) AS expression_sql, \
                pg_get_expr(ix.indpred, ix.indrelid) AS predicate, \
                ARRAY(SELECT att.attname FROM unnest(ix.indkey) WITH ORDINALITY AS key(attnum, ord) JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = key.attnum WHERE key.attnum > 0 AND key.ord <= ix.indnkeyatts ORDER BY key.ord) AS columns, \
                ARRAY(SELECT att.attname FROM unnest(ix.indkey) WITH ORDINALITY AS key(attnum, ord) JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = key.attnum WHERE key.attnum > 0 AND key.ord > ix.indnkeyatts ORDER BY key.ord) AS include_columns \
              FROM pg_class rel \
              JOIN pg_namespace ns ON ns.oid = rel.relnamespace \
              JOIN pg_index ix ON ix.indrelid = rel.oid \
              JOIN pg_class idx ON idx.oid = ix.indexrelid \
              JOIN pg_am am ON am.oid = idx.relam \
              WHERE ns.nspname = $1 AND rel.relname = $2";
            let rows = db::pg_fetch(client, conn_id, trace_db, sql, &[s, table]).await?;
            Ok(json!({ "indexes": rows }))
        }
        DbClient::MySql { .. } => {
            let d = db_name.filter(|d| !d.is_empty()).unwrap_or("information_schema");
            let sql = format!("SHOW INDEX FROM {} FROM {}", backtick(table), backtick(d));
            let rows = db::fetch_raw_objects(client, conn_id, trace_db, &sql).await?;
            Ok(json!({ "indexes": rows }))
        }
        DbClient::Sqlite { .. } => {
            let index_list =
                db::fetch_raw_objects(client, conn_id, trace_db, &format!("PRAGMA index_list(\"{table}\")")).await?;
            let mut indexes: Vec<Value> = Vec::new();
            for idx in &index_list {
                let name = s_of(idx, "name");
                let cols =
                    db::fetch_raw_objects(client, conn_id, trace_db, &format!("PRAGMA index_info(\"{name}\")")).await?;
                let definition_rows = db::sqlite_fetch(
                    client,
                    conn_id,
                    trace_db,
                    "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
                    &[&name],
                )
                .await?;
                let mut map = Map::new();
                map.insert("name".into(), json!(name));
                map.insert("unique".into(), json!(idx.get("unique").and_then(Value::as_i64) == Some(1)));
                map.insert("primary".into(), json!(s_of(idx, "origin") == "pk"));
                map.insert(
                    "columns".into(),
                    Value::Array(cols.iter().map(|c| c.get("name").cloned().unwrap_or(Value::Null)).collect()),
                );
                if let Some(sql_value) = definition_rows.first().and_then(|r| r.get("sql")) {
                    if !sql_value.is_null() {
                        map.insert("definition".into(), sql_value.clone());
                    }
                }
                indexes.push(Value::Object(map));
            }
            Ok(json!({ "indexes": indexes }))
        }
    }
}

// ---------------------------------------------------------------------------
// Introspection: Foreign Keys
// ---------------------------------------------------------------------------

async fn get_foreign_keys(
    client: &DbClient,
    conn_id: &str,
    trace_db: &str,
    db_name: Option<&str>,
    schema: Option<&str>,
    table: &str,
) -> Result<Value, SidecarError> {
    match client {
        DbClient::Postgres { .. } => {
            let s = schema.filter(|s| !s.is_empty()).unwrap_or("public");
            let sql = "SELECT \
                tc.constraint_name, kcu.column_name, \
                ref.table_schema AS foreign_table_schema, \
                ref.table_name AS foreign_table_name, \
                ref.column_name AS foreign_column_name, \
                rc.update_rule AS on_update, rc.delete_rule AS on_delete, \
                kcu.ordinal_position \
              FROM information_schema.table_constraints AS tc \
              JOIN information_schema.key_column_usage AS kcu \
                ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema \
              JOIN information_schema.referential_constraints rc \
                ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema \
              JOIN information_schema.key_column_usage ref \
                ON ref.constraint_schema = rc.unique_constraint_schema \
                AND ref.constraint_name = rc.unique_constraint_name \
                AND ref.ordinal_position = kcu.position_in_unique_constraint \
              WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1 AND tc.table_name = $2 \
              ORDER BY tc.constraint_name, kcu.ordinal_position";
            let rows = db::pg_fetch(client, conn_id, trace_db, sql, &[s, table]).await?;
            Ok(json!({ "foreignKeys": rows }))
        }
        DbClient::MySql { .. } => {
            let d = db_name.filter(|d| !d.is_empty()).unwrap_or("information_schema");
            let rows = db::mysql_fetch(
                client,
                conn_id,
                trace_db,
                "SELECT kcu.CONSTRAINT_NAME, kcu.COLUMN_NAME, kcu.REFERENCED_TABLE_SCHEMA, kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME, rc.UPDATE_RULE, rc.DELETE_RULE, kcu.ORDINAL_POSITION \
                 FROM information_schema.KEY_COLUMN_USAGE AS kcu \
                 JOIN information_schema.REFERENTIAL_CONSTRAINTS rc \
                   ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME \
                 WHERE kcu.TABLE_SCHEMA = ? AND kcu.TABLE_NAME = ? AND kcu.REFERENCED_TABLE_NAME IS NOT NULL \
                 ORDER BY kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION",
                &[d, table],
            )
            .await?;
            let fks: Vec<Value> = rows
                .iter()
                .map(|r| {
                    json!({
                        "constraint_name": r.get("CONSTRAINT_NAME").cloned().unwrap_or(Value::Null),
                        "column_name": r.get("COLUMN_NAME").cloned().unwrap_or(Value::Null),
                        "foreign_table_schema": r.get("REFERENCED_TABLE_SCHEMA").cloned().unwrap_or(Value::Null),
                        "foreign_table_name": r.get("REFERENCED_TABLE_NAME").cloned().unwrap_or(Value::Null),
                        "foreign_column_name": r.get("REFERENCED_COLUMN_NAME").cloned().unwrap_or(Value::Null),
                        "on_update": r.get("UPDATE_RULE").cloned().unwrap_or(Value::Null),
                        "on_delete": r.get("DELETE_RULE").cloned().unwrap_or(Value::Null),
                    })
                })
                .collect();
            Ok(json!({ "foreignKeys": fks }))
        }
        DbClient::Sqlite { .. } => {
            let rows =
                db::fetch_raw_objects(client, conn_id, trace_db, &format!("PRAGMA foreign_key_list(\"{table}\")")).await?;
            let fks: Vec<Value> = rows
                .iter()
                .map(|r| {
                    json!({
                        "id": r.get("id").cloned().unwrap_or(Value::Null),
                        "column_name": r.get("from").cloned().unwrap_or(Value::Null),
                        "foreign_table_name": r.get("table").cloned().unwrap_or(Value::Null),
                        "foreign_column_name": r.get("to").cloned().unwrap_or(Value::Null),
                        "on_update": r.get("on_update").cloned().unwrap_or(Value::Null),
                        "on_delete": r.get("on_delete").cloned().unwrap_or(Value::Null),
                    })
                })
                .collect();
            Ok(json!({ "foreignKeys": fks }))
        }
    }
}

// ---------------------------------------------------------------------------
// Introspection: DDL
// ---------------------------------------------------------------------------

async fn get_table_artifacts(
    client: &DbClient,
    conn_id: &str,
    trace_db: &str,
    table: &str,
) -> Result<Value, SidecarError> {
    if !matches!(client, DbClient::Sqlite { .. }) {
        return Ok(json!({ "triggers": [] }));
    }
    let rows = db::sqlite_fetch(
        client,
        conn_id,
        trace_db,
        "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name",
        &[table],
    )
    .await?;
    let triggers: Vec<String> = rows.iter().map(|r| s_of(r, "sql")).collect();
    Ok(json!({ "triggers": triggers }))
}

async fn get_table_ddl(
    client: &DbClient,
    conn_id: &str,
    trace_db: &str,
    db_name: Option<&str>,
    schema: Option<&str>,
    table: &str,
) -> Result<Value, SidecarError> {
    match client {
        DbClient::Postgres { .. } => pg_table_ddl(client, conn_id, trace_db, schema, table).await,
        DbClient::MySql { .. } => {
            let d = db_name.filter(|d| !d.is_empty()).unwrap_or("information_schema");
            let sql = format!("SHOW CREATE TABLE {}.{}", backtick(d), backtick(table));
            let rows = db::fetch_raw_objects(client, conn_id, trace_db, &sql).await?;
            let row = rows.first();
            let ddl = row
                .and_then(|r| r.get("Create Table").and_then(Value::as_str))
                .or_else(|| row.and_then(|r| r.get("Create View").and_then(Value::as_str)))
                .unwrap_or("");
            Ok(json!({ "ddl": ddl }))
        }
        DbClient::Sqlite { .. } => {
            let rows = db::sqlite_fetch(
                client,
                conn_id,
                trace_db,
                "SELECT sql FROM sqlite_master WHERE name = ? AND type IN ('table', 'view')",
                &[table],
            )
            .await?;
            let ddl = rows
                .first()
                .and_then(|r| r.get("sql"))
                .and_then(Value::as_str)
                .map(|sql| format!("{sql};"))
                .unwrap_or_default();
            Ok(json!({ "ddl": ddl }))
        }
    }
}

async fn pg_table_ddl(
    client: &DbClient,
    conn_id: &str,
    trace_db: &str,
    schema: Option<&str>,
    table: &str,
) -> Result<Value, SidecarError> {
    let s = schema.filter(|s| !s.is_empty()).unwrap_or("public");

    let views = db::pg_fetch(
        client,
        conn_id,
        trace_db,
        "SELECT c.relkind, CASE WHEN c.relkind IN ('v', 'm') THEN pg_get_viewdef(c.oid, true) END AS definition \
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND c.relname = $2",
        &[s, table],
    )
    .await?;
    if let Some(view) = views.first() {
        let relkind = s_of(view, "relkind");
        if relkind == "v" || relkind == "m" {
            let kind = if relkind == "m" { "MATERIALIZED VIEW" } else { "VIEW" };
            let definition = s_of(view, "definition");
            return Ok(json!({
                "ddl": format!("CREATE {kind} {}.{} AS\n{definition};", pg_qident(s), pg_qident(table))
            }));
        }
    }

    let columns = db::pg_fetch(
        client,
        conn_id,
        trace_db,
        "SELECT a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, \
           a.attnotnull, pg_get_expr(d.adbin, d.adrelid) AS default_value \
         FROM pg_attribute a \
         JOIN pg_class c ON c.oid = a.attrelid \
         JOIN pg_namespace n ON n.oid = c.relnamespace \
         LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum \
         WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped \
         ORDER BY a.attnum",
        &[s, table],
    )
    .await?;
    let constraints = db::pg_fetch(
        client,
        conn_id,
        trace_db,
        "SELECT con.conname, pg_get_constraintdef(con.oid, true) AS definition \
         FROM pg_constraint con \
         JOIN pg_class c ON c.oid = con.conrelid \
         JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND c.relname = $2",
        &[s, table],
    )
    .await?;
    let indexes = db::pg_fetch(
        client,
        conn_id,
        trace_db,
        "SELECT pg_get_indexdef(i.indexrelid) AS definition \
         FROM pg_index i \
         JOIN pg_class rel ON rel.oid = i.indrelid \
         JOIN pg_namespace n ON n.oid = rel.relnamespace \
         LEFT JOIN pg_constraint con ON con.conindid = i.indexrelid \
         WHERE n.nspname = $1 AND rel.relname = $2 AND con.oid IS NULL",
        &[s, table],
    )
    .await?;
    let triggers = db::pg_fetch(
        client,
        conn_id,
        trace_db,
        "SELECT pg_get_triggerdef(t.oid, true) AS definition \
         FROM pg_trigger t JOIN pg_class rel ON rel.oid = t.tgrelid JOIN pg_namespace n ON n.oid = rel.relnamespace \
         WHERE n.nspname = $1 AND rel.relname = $2 AND NOT t.tgisinternal",
        &[s, table],
    )
    .await?;
    let comments = db::pg_fetch(
        client,
        conn_id,
        trace_db,
        "SELECT a.attname, col_description(rel.oid, a.attnum) AS comment \
         FROM pg_class rel JOIN pg_namespace n ON n.oid = rel.relnamespace \
         LEFT JOIN pg_attribute a ON a.attrelid = rel.oid AND a.attnum > 0 AND NOT a.attisdropped \
         WHERE n.nspname = $1 AND rel.relname = $2",
        &[s, table],
    )
    .await?;
    let table_meta_rows = db::pg_fetch(
        client,
        conn_id,
        trace_db,
        "SELECT obj_description(rel.oid, 'pg_class') AS comment, \
           CASE WHEN rel.relkind = 'p' THEN pg_get_partkeydef(rel.oid) END AS partition_key, \
           rel.reloptions, ts.spcname AS tablespace \
         FROM pg_class rel JOIN pg_namespace n ON n.oid = rel.relnamespace \
         LEFT JOIN pg_tablespace ts ON ts.oid = rel.reltablespace \
         WHERE n.nspname = $1 AND rel.relname = $2",
        &[s, table],
    )
    .await?;
    let grants = db::pg_fetch(
        client,
        conn_id,
        trace_db,
        "SELECT grantee, string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privileges \
         FROM information_schema.role_table_grants \
         WHERE table_schema = $1 AND table_name = $2 \
         GROUP BY grantee",
        &[s, table],
    )
    .await?;

    let mut lines: Vec<String> = Vec::new();
    for column in &columns {
        let name = s_of(column, "attname");
        let col_type = s_of(column, "type");
        let default_value = column.get("default_value").and_then(Value::as_str);
        let not_null = column.get("attnotnull").and_then(Value::as_bool).unwrap_or(false);
        lines.push(format!(
            "  {} {}{}{}",
            pg_qident(&name),
            col_type,
            default_value.map(|d| format!(" DEFAULT {d}")).unwrap_or_default(),
            if not_null { " NOT NULL" } else { "" },
        ));
    }
    for constraint in &constraints {
        lines.push(format!(
            "  CONSTRAINT {} {}",
            pg_qident(&s_of(constraint, "conname")),
            s_of(constraint, "definition"),
        ));
    }

    let qualified = format!("{}.{}", pg_qident(s), pg_qident(table));
    let table_meta = table_meta_rows.first();
    let partition_key = table_meta.and_then(|m| m.get("partition_key")).and_then(Value::as_str);
    let reloptions: Vec<String> = table_meta
        .and_then(|m| m.get("reloptions"))
        .and_then(Value::as_array)
        .map(|opts| opts.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    let tablespace = table_meta.and_then(|m| m.get("tablespace")).and_then(Value::as_str);
    let table_comment = table_meta.and_then(|m| m.get("comment")).and_then(Value::as_str);
    let suffix = format!(
        "{}{}{}",
        partition_key.map(|k| format!(" PARTITION BY {k}")).unwrap_or_default(),
        if reloptions.is_empty() { String::new() } else { format!(" WITH ({})", reloptions.join(", ")) },
        tablespace.map(|t| format!(" TABLESPACE {}", pg_qident(t))).unwrap_or_default(),
    );

    let mut extras: Vec<String> = Vec::new();
    for row in &indexes {
        extras.push(format!("{};", s_of(row, "definition")));
    }
    for row in &triggers {
        extras.push(format!("{};", s_of(row, "definition")));
    }
    if let Some(comment) = table_comment {
        extras.push(format!("COMMENT ON TABLE {qualified} IS {};", pg_qliteral(comment)));
    }
    for row in &comments {
        if let Some(comment) = row.get("comment").and_then(Value::as_str) {
            extras.push(format!(
                "COMMENT ON COLUMN {qualified}.{} IS {};",
                pg_qident(&s_of(row, "attname")),
                pg_qliteral(comment),
            ));
        }
    }
    for row in &grants {
        extras.push(format!(
            "GRANT {} ON TABLE {qualified} TO {};",
            s_of(row, "privileges"),
            pg_qident(&s_of(row, "grantee")),
        ));
    }

    let ddl = format!(
        "CREATE TABLE {qualified} (\n{}\n){suffix};{}",
        lines.join(",\n"),
        if extras.is_empty() { String::new() } else { format!("\n\n{}", extras.join("\n")) },
    );
    Ok(json!({ "ddl": ddl }))
}

// ---------------------------------------------------------------------------
// Query: Table rows
// ---------------------------------------------------------------------------

/// Build an ORDER BY clause, validating the column exists (case-insensitive)
/// to avoid SQL injection through the orderBy parameter.
pub fn build_order_clause(db_type: &str, columns: &[String], order_str: Option<&str>) -> String {
    let Some(order_str) = order_str.map(str::trim).filter(|s| !s.is_empty()) else {
        return String::new();
    };
    let mut parts = order_str.split_whitespace();
    let col = parts.next().unwrap_or("");
    let dir = parts.next().unwrap_or("").to_uppercase();
    let safe_dir = match dir.as_str() {
        "DESC" => "DESC",
        "ASC" => "ASC",
        _ => "",
    };
    let Some(found) = columns.iter().find(|c| c.to_lowercase() == col.to_lowercase()) else {
        return String::new();
    };
    if safe_dir.is_empty() {
        format!(" ORDER BY {}", quote_ident(db_type, found))
    } else {
        format!(" ORDER BY {} {safe_dir}", quote_ident(db_type, found))
    }
}

#[allow(clippy::too_many_arguments)]
async fn get_rows(
    client: &DbClient,
    conn_id: &str,
    trace_db: &str,
    db_name: Option<&str>,
    schema: Option<&str>,
    table: &str,
    limit: i64,
    offset: i64,
    order_by: Option<&str>,
    where_clause: Option<&str>,
) -> Result<Value, SidecarError> {
    let safe_limit = limit.clamp(1, 1000);
    let where_sql = where_clause
        .filter(|w| !w.is_empty())
        .map(|w| format!(" WHERE {w}"))
        .unwrap_or_default();

    match client {
        DbClient::Postgres { pool, .. } => {
            let s = schema.filter(|s| !s.is_empty()).unwrap_or("public");
            let qualified = format!("\"{s}\".\"{table}\"");

            // Discover columns first to validate orderBy.
            let col_sql = format!("SELECT * FROM {qualified} LIMIT 0");
            let t = trace::start(conn_id, trace_db, &col_sql);
            let describe = {
                use sqlx::Executor;
                pool.describe(&col_sql).await
            };
            let all_cols: Vec<String> = match describe {
                Ok(described) => {
                    t.success(Some(0));
                    described.columns().iter().map(|c| sqlx::Column::name(c).to_string()).collect()
                }
                Err(cause) => {
                    let err = SidecarError::from(cause);
                    t.failure(&err.to_string());
                    return Err(err);
                }
            };

            let order_clause = build_order_clause("postgres", &all_cols, order_by);
            let query = format!("SELECT * FROM {qualified}{where_sql}{order_clause} LIMIT {safe_limit} OFFSET {offset}");

            let estimate_rows = db::pg_fetch(
                client,
                conn_id,
                trace_db,
                "SELECT reltuples::bigint AS estimate FROM pg_class WHERE oid = $1::regclass",
                &[&format!("{s}.{table}")],
            )
            .await?;
            let total_estimate = estimate_rows
                .first()
                .and_then(|r| r.get("estimate"))
                .and_then(Value::as_i64)
                .unwrap_or(0);

            let output = db::fetch_raw(client, conn_id, trace_db, &query).await?;
            let columns = if output.columns.is_empty() { all_cols } else { output.columns };
            Ok(json!({
                "columns": columns,
                "rows": output.rows,
                "totalEstimate": total_estimate,
                "query": query,
            }))
        }
        DbClient::MySql { .. } => {
            let d = db_name.filter(|d| !d.is_empty()).unwrap_or("information_schema");
            let col_rows = db::mysql_fetch(
                client,
                conn_id,
                trace_db,
                "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
                &[d, table],
            )
            .await?;
            let all_cols: Vec<String> = col_rows.iter().map(|r| s_of(r, "COLUMN_NAME")).collect();
            let order_clause = build_order_clause("mysql", &all_cols, order_by);
            let query = format!(
                "SELECT * FROM `{d}`.`{table}`{where_sql}{order_clause} LIMIT {safe_limit} OFFSET {offset}"
            );

            let count_rows = db::mysql_fetch(
                client,
                conn_id,
                trace_db,
                "SELECT TABLE_ROWS AS estimate FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
                &[d, table],
            )
            .await?;
            let total_estimate = count_rows
                .first()
                .and_then(|r| r.get("estimate"))
                .and_then(Value::as_i64)
                .unwrap_or(0);

            let output = db::fetch_raw(client, conn_id, trace_db, &query).await?;
            let columns = if output.columns.is_empty() { all_cols } else { output.columns };
            Ok(json!({
                "columns": columns,
                "rows": output.rows,
                "totalEstimate": total_estimate,
                "query": query,
            }))
        }
        DbClient::Sqlite { .. } => {
            let pragma_rows =
                db::fetch_raw_objects(client, conn_id, trace_db, &format!("PRAGMA table_info(\"{table}\")")).await?;
            let all_cols: Vec<String> = pragma_rows.iter().map(|r| s_of(r, "name")).collect();
            let order_clause = build_order_clause("sqlite", &all_cols, order_by);
            let query = format!("SELECT * FROM \"{table}\"{where_sql}{order_clause} LIMIT {safe_limit} OFFSET {offset}");

            let count = db::fetch_raw(client, conn_id, trace_db, &format!("SELECT COUNT(*) AS cnt FROM \"{table}\""))
                .await?
                .rows
                .first()
                .and_then(|row| row.first())
                .and_then(Value::as_i64)
                .unwrap_or(0);

            let output = db::fetch_raw(client, conn_id, trace_db, &query).await?;
            let columns = if output.columns.is_empty() { all_cols } else { output.columns };
            Ok(json!({
                "columns": columns,
                "rows": output.rows,
                "totalEstimate": count,
                "query": query,
            }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn order_clause_requires_known_column() {
        let cols = vec!["id".to_string(), "Name".to_string()];
        assert_eq!(build_order_clause("postgres", &cols, Some("id desc")), " ORDER BY \"id\" DESC");
        assert_eq!(build_order_clause("mysql", &cols, Some("name")), " ORDER BY `Name`");
        assert_eq!(build_order_clause("postgres", &cols, Some("evil; DROP TABLE x")), "");
        assert_eq!(build_order_clause("postgres", &cols, None), "");
        assert_eq!(build_order_clause("postgres", &cols, Some("id SIDEWAYS")), " ORDER BY \"id\"");
    }

    #[test]
    fn identifier_quoting_per_dialect() {
        assert_eq!(quote_ident("mysql", "col"), "`col`");
        assert_eq!(quote_ident("postgres", "col"), "\"col\"");
        assert_eq!(quote_ident("sqlite", "col"), "\"col\"");
    }

    #[test]
    fn pg_identifiers_escape_quotes() {
        assert_eq!(pg_qident("we\"ird"), "\"we\"\"ird\"");
        assert_eq!(pg_qliteral("it's"), "'it''s'");
    }
}
