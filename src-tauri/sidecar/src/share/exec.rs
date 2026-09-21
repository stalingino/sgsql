//! Execution path for agent shares: one dedicated database connection per
//! share (so agent traffic never blocks the app's own pooled connection),
//! configured read-only and with a statement timeout at the session level,
//! plus a row cap on results.

use std::time::{Duration, Instant};

use futures::StreamExt;
use serde_json::{json, Map, Value};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Connection, Executor};

use super::guard::{self, GuardError, Kind};
use super::types::{AllowedTable, DbType, Share, TableKey};
use crate::db::DbClient;
use crate::error::SidecarError;
use crate::pool;
use crate::routes::schema;
use crate::trace;
use crate::value;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

pub enum ShareConn {
    Postgres(sqlx::PgConnection),
    MySql(sqlx::MySqlConnection),
    Sqlite(sqlx::SqliteConnection),
}

#[derive(Debug)]
pub enum ToolError {
    /// The guard rejected the statement or table reference.
    Rejected(String),
    Timeout,
    Db(String),
    ConnectionGone,
}

impl ToolError {
    pub fn message(&self) -> String {
        match self {
            ToolError::Rejected(message) | ToolError::Db(message) => message.clone(),
            ToolError::Timeout => "The statement exceeded the share's timeout and was cancelled.".to_string(),
            ToolError::ConnectionGone => {
                "The shared connection is no longer open in SGSql.".to_string()
            }
        }
    }

    pub fn is_rejection(&self) -> bool {
        matches!(self, ToolError::Rejected(_))
    }
}

impl From<GuardError> for ToolError {
    fn from(error: GuardError) -> Self {
        ToolError::Rejected(error.to_string())
    }
}

impl From<SidecarError> for ToolError {
    fn from(error: SidecarError) -> Self {
        ToolError::Db(error.friendly())
    }
}

pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
    pub truncated: bool,
    pub affected_rows: Option<u64>,
    pub duration_ms: f64,
}

impl QueryResult {
    pub fn to_json(&self, max_rows: usize) -> Value {
        match self.affected_rows {
            Some(affected) => json!({ "affectedRows": affected, "durationMs": self.duration_ms }),
            None => json!({
                "columns": self.columns,
                "rows": self.rows,
                "rowCount": self.rows.len(),
                "truncated": self.truncated,
                "maxRows": max_rows,
                "durationMs": self.duration_ms,
            }),
        }
    }
}

fn trace_db(share: &Share) -> String {
    format!("agent:{}", share.database)
}

async fn connect(share: &Share) -> Result<ShareConn, SidecarError> {
    let record = pool::get_record(&share.connection_id).ok_or_else(|| SidecarError::msg("Connection not found"))?;
    let profile = &record.profile;
    let host = record.entry.connect_host.clone();
    let port = record.entry.connect_port;
    let timeout_ms = share.timeout_ms;

    match share.db_type {
        DbType::Postgres => {
            let options = pool::pg_connect_options(profile, &host, port);
            let mut conn = tokio::time::timeout(CONNECT_TIMEOUT, sqlx::PgConnection::connect_with(&options))
                .await
                .map_err(|_| SidecarError::msg("connect timeout"))??;
            conn.execute(format!("SET statement_timeout = {timeout_ms}").as_str()).await?;
            if share.read_only {
                conn.execute("SET default_transaction_read_only = on").await?;
            }
            Ok(ShareConn::Postgres(conn))
        }
        DbType::MySql => {
            let options = pool::mysql_connect_options(profile, &host, port);
            let mut conn = tokio::time::timeout(CONNECT_TIMEOUT, sqlx::MySqlConnection::connect_with(&options))
                .await
                .map_err(|_| SidecarError::msg("connect timeout"))??;
            conn.execute(format!("USE `{}`", share.database.replace('`', "``")).as_str()).await?;
            // MySQL >= 5.7.8 (milliseconds); MariaDB uses max_statement_time (seconds).
            if conn.execute(format!("SET SESSION max_execution_time = {timeout_ms}").as_str()).await.is_err() {
                let _ = conn
                    .execute(format!("SET SESSION max_statement_time = {}", timeout_ms as f64 / 1000.0).as_str())
                    .await;
            }
            if share.read_only && conn.execute("SET SESSION transaction_read_only = ON").await.is_err() {
                conn.execute("SET SESSION tx_read_only = 1").await?;
            }
            Ok(ShareConn::MySql(conn))
        }
        DbType::Sqlite => {
            let options = SqliteConnectOptions::new()
                .filename(&profile.database)
                .read_only(share.read_only)
                .foreign_keys(false)
                .busy_timeout(Duration::from_millis(timeout_ms));
            let mut conn = sqlx::SqliteConnection::connect_with(&options).await?;
            if share.read_only {
                conn.execute("PRAGMA query_only = 1").await?;
            }
            Ok(ShareConn::Sqlite(conn))
        }
    }
}

/// Open the dedicated connection now so configuration errors surface to the
/// user creating the share rather than to the agent.
pub async fn ensure_open(share: &Share) -> Result<(), SidecarError> {
    let mut slot = share.conn.lock().await;
    if slot.is_none() {
        *slot = Some(connect(share).await?);
    }
    Ok(())
}

pub async fn close(share: &Share) {
    let conn = share.conn.lock().await.take();
    match conn {
        Some(ShareConn::Postgres(c)) => {
            let _ = c.close().await;
        }
        Some(ShareConn::MySql(c)) => {
            let _ = c.close().await;
        }
        Some(ShareConn::Sqlite(c)) => {
            let _ = c.close().await;
        }
        None => {}
    }
}

struct Fetched {
    columns: Vec<String>,
    rows: Vec<Vec<Value>>,
    truncated: bool,
}

macro_rules! fetch_capped {
    ($conn:expr, $sql:expr, $max:expr, $row_values:path) => {{
        let mut stream = $conn.fetch($sql);
        let mut columns: Vec<String> = Vec::new();
        let mut rows: Vec<Vec<Value>> = Vec::new();
        let mut truncated = false;
        while let Some(row) = stream.next().await {
            let row = row?;
            if columns.is_empty() {
                columns = value::column_names(&row);
            }
            if rows.len() >= $max {
                truncated = true;
                break;
            }
            rows.push($row_values(&row));
        }
        drop(stream);
        Ok::<Fetched, sqlx::Error>(Fetched { columns, rows, truncated })
    }};
}

async fn fetch_capped(conn: &mut ShareConn, sql: &str, max_rows: usize) -> Result<Fetched, sqlx::Error> {
    match conn {
        ShareConn::Postgres(c) => fetch_capped!(c, sql, max_rows, value::pg_row_values),
        ShareConn::MySql(c) => fetch_capped!(c, sql, max_rows, value::mysql_row_values),
        ShareConn::Sqlite(c) => fetch_capped!(c, sql, max_rows, value::sqlite_row_values),
    }
}

async fn execute(conn: &mut ShareConn, sql: &str) -> Result<u64, sqlx::Error> {
    Ok(match conn {
        ShareConn::Postgres(c) => c.execute(sql).await?.rows_affected(),
        ShareConn::MySql(c) => c.execute(sql).await?.rows_affected(),
        ShareConn::Sqlite(c) => c.execute(sql).await?.rows_affected(),
    })
}

enum Outcome {
    Rows(Fetched),
    Affected(u64),
}

async fn run_once(share: &Share, sql: &str, kind: Kind) -> Result<QueryResult, ToolError> {
    let mut slot = share.conn.lock().await;
    if slot.is_none() {
        *slot = Some(connect(share).await?);
    }
    let conn = slot.as_mut().expect("connection was just opened");

    let started = Instant::now();
    let t = trace::start(&share.connection_id, &trace_db(share), sql);
    let op = async {
        match kind {
            Kind::Read => fetch_capped(conn, sql, share.max_rows).await.map(Outcome::Rows),
            Kind::Write => execute(conn, sql).await.map(Outcome::Affected),
        }
    };
    let result = tokio::time::timeout(Duration::from_millis(share.timeout_ms + 1_000), op).await;
    let duration_ms = started.elapsed().as_secs_f64() * 1_000.0;

    match result {
        Ok(Ok(Outcome::Rows(fetched))) => {
            t.success(Some(fetched.rows.len() as u64));
            Ok(QueryResult {
                columns: fetched.columns,
                rows: fetched.rows,
                truncated: fetched.truncated,
                affected_rows: None,
                duration_ms,
            })
        }
        Ok(Ok(Outcome::Affected(n))) => {
            t.success(Some(n));
            Ok(QueryResult {
                columns: Vec::new(),
                rows: Vec::new(),
                truncated: false,
                affected_rows: Some(n),
                duration_ms,
            })
        }
        Ok(Err(cause)) => {
            let error = SidecarError::from(cause);
            t.failure(&error.to_string());
            if error.is_connection_error() {
                *slot = None;
            }
            Err(ToolError::Db(error.friendly()))
        }
        Err(_) => {
            // Dropping the connection closes the socket, which aborts the
            // server-side statement for Postgres and MySQL.
            t.failure("Statement timed out (agent share)");
            *slot = None;
            Err(ToolError::Timeout)
        }
    }
}

/// Guard, then execute one statement on the share's dedicated connection.
pub async fn run(share: &Share, sql: &str) -> Result<QueryResult, ToolError> {
    let verdict = guard::check(share, sql)?;
    if !pool::has_connection(&share.connection_id) {
        return Err(ToolError::ConnectionGone);
    }
    let first = run_once(share, sql, verdict.kind).await;
    if matches!(first, Err(ToolError::Db(_))) && share.conn.lock().await.is_none() {
        // The connection was dropped (server restart, tunnel reconnect): retry once.
        return run_once(share, sql, verdict.kind).await;
    }
    first
}

// ---------------------------------------------------------------------------
// Metadata tools, served through the app's pooled connection.
// ---------------------------------------------------------------------------

fn allowed_entry(share: &Share, key: &TableKey) -> Option<AllowedTable> {
    if share.full_database || share.all_databases {
        return Some(AllowedTable { schema: key.schema.clone(), name: key.name.clone(), kind: "table".into() });
    }
    share.tables.iter().find(|t| TableKey::new(&t.schema, &t.name) == *key).cloned()
}

fn s(value: &Value, key: &str) -> String {
    match value.get(key) {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

async fn pooled_client(share: &Share) -> Result<std::sync::Arc<pool::PoolEntry>, ToolError> {
    if !pool::has_connection(&share.connection_id) {
        return Err(ToolError::ConnectionGone);
    }
    let (entry, _) = pool::ensure_connection_alive(&share.connection_id, false).await?;
    Ok(entry)
}

fn introspection_scope<'a>(share: &Share, table: &'a AllowedTable) -> (Option<&'a str>, Option<&'a str>) {
    match share.db_type {
        DbType::Postgres => (None, Some(table.schema.as_str())),
        DbType::MySql => (Some(table.schema.as_str()), None),
        DbType::Sqlite => (None, None),
    }
}

fn normalize_columns(share: &Share, raw: &Value) -> (Vec<Value>, Vec<String>) {
    let mut columns = Vec::new();
    let mut primary_key = Vec::new();
    for column in raw.get("columns").and_then(Value::as_array).into_iter().flatten() {
        let name = s(column, "column_name");
        let data_type = match share.db_type {
            DbType::Postgres => {
                let formatted = s(column, "formatted_type");
                if formatted.is_empty() { s(column, "data_type") } else { formatted }
            }
            DbType::MySql => {
                let column_type = s(column, "column_type");
                if column_type.is_empty() { s(column, "data_type") } else { column_type }
            }
            DbType::Sqlite => s(column, "data_type"),
        };
        let comment = match share.db_type {
            DbType::MySql => s(column, "column_comment"),
            _ => s(column, "comment"),
        };
        if s(column, "column_key") == "PRI" {
            primary_key.push(name.clone());
        }
        let mut map = Map::new();
        map.insert("name".into(), Value::from(name));
        map.insert("type".into(), Value::from(data_type));
        map.insert("nullable".into(), Value::from(s(column, "is_nullable").eq_ignore_ascii_case("yes")));
        map.insert("default".into(), column.get("column_default").cloned().unwrap_or(Value::Null));
        if !comment.is_empty() {
            map.insert("comment".into(), Value::from(comment));
        }
        columns.push(Value::Object(map));
    }
    (columns, primary_key)
}

fn normalize_foreign_keys(share: &Share, raw: &Value) -> Vec<Value> {
    raw.get("foreignKeys")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|fk| {
            let ref_schema = s(fk, "foreign_table_schema");
            let ref_table = s(fk, "foreign_table_name");
            let key = if ref_schema.is_empty() {
                TableKey::new(&share.default_schema, &ref_table)
            } else {
                TableKey::new(&ref_schema, &ref_table)
            };
            // Only reveal relationships to tables the agent can see.
            if !share.allows(&key) {
                return None;
            }
            let mut map = Map::new();
            map.insert("column".into(), Value::from(s(fk, "column_name")));
            if !ref_schema.is_empty() && !ref_schema.eq_ignore_ascii_case(&share.default_schema) {
                map.insert("refSchema".into(), Value::from(ref_schema));
            }
            map.insert("refTable".into(), Value::from(ref_table));
            map.insert("refColumn".into(), Value::from(s(fk, "foreign_column_name")));
            Some(Value::Object(map))
        })
        .collect()
}

fn normalize_indexes(share: &Share, raw: &Value) -> Vec<Value> {
    let rows = raw.get("indexes").and_then(Value::as_array).cloned().unwrap_or_default();
    match share.db_type {
        DbType::MySql => {
            // SHOW INDEX returns one row per column; group by key name.
            let mut order: Vec<String> = Vec::new();
            let mut grouped: Map<String, Value> = Map::new();
            for row in &rows {
                let name = s(row, "Key_name");
                let entry = grouped.entry(name.clone()).or_insert_with(|| {
                    order.push(name.clone());
                    json!({
                        "name": name,
                        "columns": [],
                        "unique": s(row, "Non_unique") == "0",
                    })
                });
                if let Some(columns) = entry.get_mut("columns").and_then(Value::as_array_mut) {
                    columns.push(Value::from(s(row, "Column_name")));
                }
            }
            order.into_iter().filter_map(|name| grouped.remove(&name)).collect()
        }
        DbType::Postgres => rows
            .iter()
            .map(|row| {
                let definition = s(row, "indexdef");
                json!({
                    "name": s(row, "indexname"),
                    "columns": row.get("columns").cloned().unwrap_or(Value::Array(vec![])),
                    "unique": definition.to_uppercase().contains("UNIQUE INDEX")
                        || row.get("primary").and_then(Value::as_bool).unwrap_or(false),
                })
            })
            .collect(),
        DbType::Sqlite => rows
            .iter()
            .map(|row| {
                json!({
                    "name": s(row, "name"),
                    "columns": row.get("columns").cloned().unwrap_or(Value::Array(vec![])),
                    "unique": row.get("unique").and_then(Value::as_bool).unwrap_or(false),
                })
            })
            .collect(),
    }
}

async fn metadata_entry(share: &Share, table: &str, key: &TableKey, client: &DbClient) -> Result<AllowedTable, ToolError> {
    let mut entry = allowed_entry(share, key).ok_or(ToolError::Rejected(format!("Table \"{table}\" is not shared.")))?;
    if !share.full_database && !share.all_databases {
        return Ok(entry);
    }
    if share.all_databases {
        entry.schema = mysql_database_name(share, client, &entry.schema).await?;
    }
    // Resolve the canonical name and type only for the requested schema.
    // Unrestricted shares need no table snapshot at creation time.
    let (db_name, schema_name) = introspection_scope(share, &entry);
    let listing = schema::get_tables(client, &share.connection_id, &trace_db(share), db_name, schema_name).await?;
    let found = listing["tables"].as_array().and_then(|tables| tables.iter().find(|candidate| {
        s(candidate, "name").eq_ignore_ascii_case(&entry.name)
    }));
    let Some(found) = found else {
        return Err(ToolError::Rejected(format!("Table \"{table}\" was not found in the database.")));
    };
    entry.name = s(found, "name");
    entry.kind = if s(found, "type").to_uppercase().contains("VIEW") { "view" } else { "table" }.into();
    Ok(entry)
}

pub async fn describe_table(share: &Share, table: &str) -> Result<Value, ToolError> {
    let key = guard::resolve_table_ref(share, table)?;
    let pooled = pooled_client(share).await?;
    let client: &DbClient = &pooled.client;
    let conn_id = &share.connection_id;
    let db = trace_db(share);
    let entry = metadata_entry(share, table, &key, client).await?;
    let (db_name, schema_name) = introspection_scope(share, &entry);

    let columns_raw = schema::get_columns(client, conn_id, &db, db_name, schema_name, &entry.name).await?;
    let fks_raw = schema::get_foreign_keys(client, conn_id, &db, db_name, schema_name, &entry.name).await?;
    let indexes_raw = schema::get_indexes(client, conn_id, &db, db_name, schema_name, &entry.name)
        .await
        .unwrap_or_else(|_| json!({ "indexes": [] }));

    let (columns, primary_key) = normalize_columns(share, &columns_raw);
    if columns.is_empty() {
        return Err(ToolError::Rejected(format!("Table \"{table}\" was not found in the database.")));
    }
    Ok(json!({
        "table": entry.name,
        "schema": entry.schema,
        "type": entry.kind,
        "columns": columns,
        "primaryKey": primary_key,
        "foreignKeys": normalize_foreign_keys(share, &fks_raw),
        "indexes": normalize_indexes(share, &indexes_raw),
    }))
}

pub async fn table_ddl(share: &Share, table: &str) -> Result<String, ToolError> {
    let key = guard::resolve_table_ref(share, table)?;
    let pooled = pooled_client(share).await?;
    let entry = metadata_entry(share, table, &key, &pooled.client).await?;
    let (db_name, schema_name) = introspection_scope(share, &entry);
    let raw = schema::get_table_ddl(&pooled.client, &share.connection_id, &trace_db(share), db_name, schema_name, &entry.name)
        .await?;
    Ok(s(&raw, "ddl"))
}

async fn mysql_database_name(share: &Share, client: &DbClient, requested: &str) -> Result<String, ToolError> {
    let names = schema::database_names(client, &share.connection_id, &trace_db(share)).await?;
    names.iter().find(|name| *name == requested)
        .or_else(|| names.iter().find(|name| name.eq_ignore_ascii_case(requested)))
        .cloned()
        .ok_or_else(|| ToolError::Rejected(format!("Database \"{requested}\" is not accessible to this connection.")))
}

pub async fn list_databases(share: &Share) -> Result<Vec<String>, ToolError> {
    if !share.all_databases {
        return Err(ToolError::Rejected("Database listing is only available for all-databases shares.".into()));
    }
    let pooled = pooled_client(share).await?;
    Ok(schema::database_names(&pooled.client, &share.connection_id, &trace_db(share)).await?)
}

pub async fn list_tables(share: &Share, database: Option<&str>) -> Result<Vec<AllowedTable>, ToolError> {
    if database.is_some() && !share.all_databases {
        return Err(ToolError::Rejected("A database argument is only available for all-databases shares.".into()));
    }
    if !share.full_database && !share.all_databases {
        return Ok(share.tables.clone());
    }
    let pooled = pooled_client(share).await?;
    let mysql_db = if share.all_databases {
        mysql_database_name(share, &pooled.client, database.unwrap_or(&share.database)).await?
    } else {
        share.database.clone()
    };
    let listing = match share.db_type {
        DbType::Postgres => schema::get_catalog(&pooled.client, &share.connection_id, &trace_db(share), Some(&share.database)).await?,
        DbType::MySql => schema::get_tables(&pooled.client, &share.connection_id, &trace_db(share), Some(&mysql_db), None).await?,
        DbType::Sqlite => schema::get_tables(&pooled.client, &share.connection_id, &trace_db(share), None, None).await?,
    };
    Ok(listing["tables"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|table| AllowedTable {
            schema: match share.db_type {
                DbType::Postgres => s(table, "schema"),
                DbType::MySql => mysql_db.clone(),
                DbType::Sqlite => share.default_schema.clone(),
            },
            name: s(table, "name"),
            kind: if s(table, "type").to_uppercase().contains("VIEW") { "view" } else { "table" }.into(),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::share::registry;
    use crate::share::types::CreateShareRequest;

    #[tokio::test]
    async fn full_sqlite_share_discovers_tables_added_after_creation() {
        let path = std::env::temp_dir().join(format!("sgsql-mcp-{}.sqlite", uuid::Uuid::new_v4()));
        let connection_id = format!("mcp-test-{}", uuid::Uuid::new_v4());
        let profile: crate::types::ConnectionProfile = serde_json::from_value(json!({
            "id": connection_id, "name": "Test SQLite", "type": "sqlite", "database": path.to_str().unwrap()
        })).unwrap();
        let (pooled, _) = pool::open_connection(&profile).await.unwrap();
        let DbClient::Sqlite { pool: sqlite_pool } = &pooled.client else { unreachable!() };
        sqlx::query("CREATE TABLE first_table (id INTEGER PRIMARY KEY)").execute(sqlite_pool).await.unwrap();

        let share = registry::create(CreateShareRequest {
            connection_id: profile.id.clone(),
            db: None,
            full_database: true,
            all_databases: false,
            tables: vec![],
            read_only: true,
            max_rows: 500,
            timeout_ms: 15_000,
        }, &profile).unwrap();
        ensure_open(&share).await.unwrap();
        assert_eq!(list_tables(&share, None).await.unwrap().len(), 1);

        sqlx::query("CREATE TABLE second_table (id INTEGER PRIMARY KEY)").execute(sqlite_pool).await.unwrap();
        assert_eq!(list_tables(&share, None).await.unwrap().len(), 2);
        assert!(run(&share, "SELECT * FROM second_table").await.is_ok());
        assert_eq!(describe_table(&share, "second_table").await.unwrap()["table"], "second_table");
        assert!(table_ddl(&share, "second_table").await.unwrap().contains("CREATE TABLE"));

        registry::remove(&share.id).await;
        pool::close_connection(&profile.id).await;
        std::fs::remove_file(path).unwrap();
    }
}
