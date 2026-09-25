//! Execution path for agent shares: one dedicated database connection per
//! share (so agent traffic never blocks the app's own pooled connection),
//! configured read-only and with a statement timeout at the session level,
//! plus a row cap on results.

use std::time::{Duration, Instant};

use futures::StreamExt;
use serde_json::{json, Map, Value};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Connection, Either, Executor};

use super::guard::{self, GuardError, Verdict};
use super::types::{AllowedTable, DbType, Share, TableKey};
use crate::db::DbClient;
use crate::error::SidecarError;
use crate::pool;
use crate::routes::schema;
use crate::trace;
use crate::value;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// Most statements one `transaction` call may run.
pub const MAX_BATCH_STATEMENTS: usize = 100;

pub enum ShareConn {
    Postgres(sqlx::PgConnection),
    MySql(sqlx::MySqlConnection),
    Sqlite(sqlx::SqliteConnection),
}

#[derive(Debug)]
pub enum ToolError {
    /// The guard rejected the statement or table reference.
    Rejected(String),
    /// Cancelled client-side after the share's timeout (milliseconds).
    Timeout(u64),
    Db(String),
    ConnectionGone,
}

impl ToolError {
    pub fn message(&self) -> String {
        match self {
            ToolError::Rejected(message) | ToolError::Db(message) => message.clone(),
            ToolError::Timeout(ms) => format!("The statement was cancelled.{}", timeout_hint(*ms)),
            ToolError::ConnectionGone => {
                "The shared connection is no longer open in SGSql.".to_string()
            }
        }
    }

    pub fn is_rejection(&self) -> bool {
        matches!(self, ToolError::Rejected(_))
    }

    /// Prefix the message with the failing statement's position in a batch.
    fn in_batch(self, index: usize, total: usize, outcome: &str) -> ToolError {
        let message = format!("Statement {} of {total} failed: {} {outcome}", index + 1, self.message());
        match self {
            ToolError::Rejected(_) => ToolError::Rejected(message),
            _ => ToolError::Db(message),
        }
    }
}

fn timeout_hint(timeout_ms: u64) -> String {
    format!(
        " This share cancels each statement after {}s. Narrow the query with selective WHERE conditions on indexed columns, add a LIMIT, or run EXPLAIN to check the plan.",
        timeout_ms as f64 / 1000.0
    )
}

/// Server-side statement timeouts (MySQL max_execution_time, MariaDB
/// max_statement_time, Postgres statement_timeout).
fn is_server_timeout(message: &str) -> bool {
    let lower = message.to_lowercase();
    lower.contains("maximum statement execution time exceeded")
        || lower.contains("max_statement_time exceeded")
        || lower.contains("statement timeout")
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

#[derive(Debug)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
    pub truncated: bool,
    /// Set for writes; reads leave it `None`.
    pub affected_rows: Option<u64>,
    /// Generated key of an INSERT (MySQL AUTO_INCREMENT, SQLite rowid).
    pub last_insert_id: Option<i64>,
    pub duration_ms: f64,
}

impl QueryResult {
    pub fn to_json(&self, max_rows: usize) -> Value {
        let mut map = Map::new();
        if let Some(affected) = self.affected_rows {
            map.insert("affectedRows".into(), json!(affected));
            if let Some(id) = self.last_insert_id {
                map.insert("lastInsertId".into(), json!(id));
            }
        }
        // Reads always report a result set; writes only when they returned rows.
        if self.affected_rows.is_none() || !self.columns.is_empty() {
            map.insert("columns".into(), json!(self.columns));
            map.insert("rows".into(), json!(self.rows));
            map.insert("rowCount".into(), json!(self.rows.len()));
            map.insert("truncated".into(), json!(self.truncated));
            map.insert("maxRows".into(), json!(max_rows));
        }
        map.insert("durationMs".into(), json!(self.duration_ms));
        Value::Object(map)
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

#[derive(Default)]
struct Executed {
    columns: Vec<String>,
    rows: Vec<Vec<Value>>,
    truncated: bool,
    rows_affected: u64,
    last_insert_id: Option<i64>,
}

/// Run one statement, keeping at most `$max` rows. Reads stop reading at the
/// cap; writes (`$drain`) consume the whole result so the statement finishes
/// and `rows_affected` is complete.
macro_rules! run_statement {
    ($conn:expr, $sql:expr, $max:expr, $drain:expr, $row_values:path, $insert_id:expr) => {{
        let mut stream = $conn.fetch_many($sql);
        let mut out = Executed::default();
        while let Some(item) = stream.next().await {
            match item? {
                Either::Left(done) => {
                    out.rows_affected += done.rows_affected();
                    out.last_insert_id = ($insert_id)(&done).or(out.last_insert_id);
                }
                Either::Right(row) => {
                    if out.columns.is_empty() {
                        out.columns = value::column_names(&row);
                    }
                    if out.rows.len() >= $max {
                        out.truncated = true;
                        if !$drain {
                            break;
                        }
                        continue;
                    }
                    out.rows.push($row_values(&row));
                }
            }
        }
        drop(stream);
        Ok::<Executed, sqlx::Error>(out)
    }};
}

async fn run_statement(conn: &mut ShareConn, sql: &str, max_rows: usize, drain: bool) -> Result<Executed, sqlx::Error> {
    match conn {
        ShareConn::Postgres(c) => {
            run_statement!(c, sql, max_rows, drain, value::pg_row_values, |_: &sqlx::postgres::PgQueryResult| None)
        }
        ShareConn::MySql(c) => run_statement!(c, sql, max_rows, drain, value::mysql_row_values, |done: &sqlx::mysql::MySqlQueryResult| {
            Some(done.last_insert_id() as i64).filter(|id| *id > 0)
        }),
        ShareConn::Sqlite(c) => run_statement!(c, sql, max_rows, drain, value::sqlite_row_values, |done: &sqlx::sqlite::SqliteQueryResult| {
            Some(done.last_insert_rowid()).filter(|id| *id > 0)
        }),
    }
}

/// Run one guarded statement on an open connection with tracing and the
/// share's timeout. On failure the flag says the connection is unusable and
/// must be dropped.
async fn exec_statement(share: &Share, conn: &mut ShareConn, sql: &str, verdict: &Verdict) -> Result<QueryResult, (ToolError, bool)> {
    let started = Instant::now();
    let t = trace::start(&share.connection_id, &trace_db(share), sql);
    let is_write = verdict.kind == guard::Kind::Write;
    let op = run_statement(conn, sql, share.max_rows, is_write);
    let result = tokio::time::timeout(Duration::from_millis(share.timeout_ms + 1_000), op).await;
    let duration_ms = started.elapsed().as_secs_f64() * 1_000.0;

    match result {
        Ok(Ok(executed)) => {
            t.success(Some(if is_write { executed.rows_affected } else { executed.rows.len() as u64 }));
            Ok(QueryResult {
                columns: if verdict.returns_rows { executed.columns } else { Vec::new() },
                rows: executed.rows,
                truncated: executed.truncated,
                affected_rows: is_write.then_some(executed.rows_affected),
                last_insert_id: executed.last_insert_id.filter(|_| verdict.is_insert && executed.rows_affected > 0),
                duration_ms,
            })
        }
        Ok(Err(cause)) => {
            let error = SidecarError::from(cause);
            t.failure(&error.to_string());
            let mut message = error.friendly();
            if is_server_timeout(&message) {
                message.push_str(&timeout_hint(share.timeout_ms));
            }
            Err((ToolError::Db(message), error.is_connection_error()))
        }
        Err(_) => {
            // Dropping the connection closes the socket, which aborts the
            // server-side statement for Postgres and MySQL.
            t.failure("Statement timed out (agent share)");
            Err((ToolError::Timeout(share.timeout_ms), true))
        }
    }
}

async fn run_once(share: &Share, sql: &str, verdict: &Verdict) -> Result<QueryResult, ToolError> {
    let mut slot = share.conn.lock().await;
    if slot.is_none() {
        *slot = Some(connect(share).await?);
    }
    let conn = slot.as_mut().expect("connection was just opened");
    match exec_statement(share, conn, sql, verdict).await {
        Ok(result) => Ok(result),
        Err((error, broken)) => {
            if broken {
                *slot = None;
            }
            Err(error)
        }
    }
}

/// Guard, then execute one statement on the share's dedicated connection.
pub async fn run(share: &Share, sql: &str) -> Result<QueryResult, ToolError> {
    let verdict = guard::check(share, sql)?;
    if !pool::has_connection(&share.connection_id) {
        return Err(ToolError::ConnectionGone);
    }
    let first = run_once(share, sql, &verdict).await;
    if matches!(first, Err(ToolError::Db(_))) && share.conn.lock().await.is_none() {
        // The connection was dropped (server restart, tunnel reconnect): retry once.
        return run_once(share, sql, &verdict).await;
    }
    first
}

/// BEGIN / COMMIT / ROLLBACK, traced like agent statements.
async fn control(share: &Share, conn: &mut ShareConn, sql: &str) -> Result<(), SidecarError> {
    let t = trace::start(&share.connection_id, &trace_db(share), sql);
    let op = async {
        match conn {
            ShareConn::Postgres(c) => c.execute(sql).await.map(|_| ()),
            ShareConn::MySql(c) => c.execute(sql).await.map(|_| ()),
            ShareConn::Sqlite(c) => c.execute(sql).await.map(|_| ()),
        }
    };
    let result = match tokio::time::timeout(Duration::from_millis(share.timeout_ms + 1_000), op).await {
        Ok(result) => result.map_err(SidecarError::from),
        Err(_) => Err(SidecarError::msg(format!("{sql} did not finish within the share's timeout"))),
    };
    match &result {
        Ok(()) => t.success(None),
        Err(error) => t.failure(&error.to_string()),
    }
    result
}

/// Guard every statement, then run them in order inside one transaction:
/// all of them are committed, or none are.
pub async fn run_batch(share: &Share, statements: &[String]) -> Result<Vec<QueryResult>, ToolError> {
    if share.read_only {
        return Err(ToolError::Rejected("This share is read-only; transactions are only available on read-write shares.".into()));
    }
    let total = statements.len();
    if total == 0 {
        return Err(ToolError::Rejected("Provide at least one statement.".into()));
    }
    if total > MAX_BATCH_STATEMENTS {
        return Err(ToolError::Rejected(format!("At most {MAX_BATCH_STATEMENTS} statements are allowed per transaction (got {total}).")));
    }
    let verdicts = statements
        .iter()
        .enumerate()
        .map(|(index, sql)| {
            guard::check(share, sql).map_err(|error| ToolError::from(error).in_batch(index, total, "Nothing was executed."))
        })
        .collect::<Result<Vec<_>, _>>()?;
    if !pool::has_connection(&share.connection_id) {
        return Err(ToolError::ConnectionGone);
    }

    let begin = match share.db_type {
        DbType::MySql => "START TRANSACTION",
        DbType::Postgres | DbType::Sqlite => "BEGIN",
    };
    let mut slot = share.conn.lock().await;
    // Nothing has run yet, so a stale idle connection can be replaced safely.
    for attempt in 0..2 {
        if slot.is_none() {
            *slot = Some(connect(share).await?);
        }
        match control(share, slot.as_mut().expect("connection was just opened"), begin).await {
            Ok(()) => break,
            Err(error) => {
                *slot = None;
                if attempt == 1 {
                    return Err(ToolError::Db(format!("Could not start a transaction: {}", error.friendly())));
                }
            }
        }
    }
    let conn = slot.as_mut().expect("transaction was started");

    let mut results = Vec::with_capacity(total);
    for (index, (sql, verdict)) in statements.iter().zip(&verdicts).enumerate() {
        match exec_statement(share, conn, sql, verdict).await {
            Ok(result) => results.push(result),
            Err((error, broken)) => {
                // A dropped connection aborts the open transaction server-side.
                let rolled_back = broken || control(share, conn, "ROLLBACK").await.is_ok();
                let outcome = if rolled_back {
                    "The transaction was rolled back; no changes were applied."
                } else {
                    "Rolling back failed; the connection was closed, which aborts the transaction."
                };
                if broken || !rolled_back {
                    *slot = None;
                }
                return Err(error.in_batch(index, total, outcome));
            }
        }
    }
    if let Err(error) = control(share, conn, "COMMIT").await {
        let broken = error.is_connection_error();
        let rolled_back = !broken && control(share, conn, "ROLLBACK").await.is_ok();
        if !rolled_back {
            *slot = None;
        }
        return Err(ToolError::Db(format!(
            "COMMIT failed: {}. {}",
            error.friendly(),
            if broken {
                "The connection was lost, so whether the changes were applied is unknown; check before retrying."
            } else {
                "The transaction was rolled back; no changes were applied."
            }
        )));
    }
    Ok(results)
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
    // Keys are lowercased for matching, but catalog lookups compare names
    // exactly on case-sensitive servers (MySQL on Linux): restore the case.
    if share.all_databases {
        entry.schema = mysql_database_name(share, client, &entry.schema).await?;
    } else if entry.schema.eq_ignore_ascii_case(&share.default_schema) {
        entry.schema = share.default_schema.clone();
    }
    // Resolve the canonical name and type only for the requested schema.
    // Unrestricted shares need no table snapshot at creation time.
    let (db_name, schema_name) = introspection_scope(share, &entry);
    let listing = schema::get_tables(client, &share.connection_id, &trace_db(share), db_name, schema_name).await?;
    let found = listing["tables"].as_array().and_then(|tables| tables.iter().find(|candidate| {
        s(candidate, "name").eq_ignore_ascii_case(&entry.name)
    }));
    let Some(found) = found else {
        let needle = entry.name.to_lowercase();
        let similar: Vec<String> = listing["tables"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|candidate| s(candidate, "name"))
            .filter(|name| name.to_lowercase().contains(&needle) || needle.contains(&name.to_lowercase()))
            .take(10)
            .collect();
        let hint = if similar.is_empty() { String::new() } else { format!(" Similar tables: {}.", similar.join(", ")) };
        return Err(ToolError::Rejected(format!(
            "Table \"{table}\" was not found in {} \"{}\".{hint}",
            if share.db_type == DbType::Postgres { "schema" } else { "database" },
            entry.schema
        )));
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
    #[tokio::test]
    async fn writes_report_insert_ids_and_transactions_are_all_or_nothing() {
        let path = std::env::temp_dir().join(format!("sgsql-mcp-{}.sqlite", uuid::Uuid::new_v4()));
        let connection_id = format!("mcp-test-{}", uuid::Uuid::new_v4());
        let profile: crate::types::ConnectionProfile = serde_json::from_value(json!({
            "id": connection_id, "name": "Test SQLite", "type": "sqlite", "database": path.to_str().unwrap()
        })).unwrap();
        let (pooled, _) = pool::open_connection(&profile).await.unwrap();
        let DbClient::Sqlite { pool: sqlite_pool } = &pooled.client else { unreachable!() };
        sqlx::query("CREATE TABLE forms (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)").execute(sqlite_pool).await.unwrap();
        sqlx::query("CREATE TABLE form_queries (form_id INTEGER NOT NULL, q TEXT)").execute(sqlite_pool).await.unwrap();

        let share = registry::create(CreateShareRequest {
            connection_id: profile.id.clone(),
            db: None,
            full_database: true,
            all_databases: false,
            tables: vec![],
            read_only: false,
            max_rows: 500,
            timeout_ms: 15_000,
        }, &profile).unwrap();

        let inserted = run(&share, "INSERT INTO forms (name) VALUES ('Form97')").await.unwrap();
        assert_eq!((inserted.affected_rows, inserted.last_insert_id), (Some(1), Some(1)));
        let returned = run(&share, "UPDATE forms SET name = 'Form98' RETURNING id, name").await.unwrap();
        assert_eq!(returned.affected_rows, Some(1));
        assert_eq!(returned.rows, vec![vec![json!(1), json!("Form98")]]);
        assert_eq!(returned.last_insert_id, None);

        let results = run_batch(&share, &[
            "INSERT INTO forms (name) VALUES ('Form99')".into(),
            "INSERT INTO form_queries (form_id, q) VALUES (last_insert_rowid(), 'q1')".into(),
            "SELECT form_id FROM form_queries".into(),
        ]).await.unwrap();
        assert_eq!(results[0].last_insert_id, Some(2));
        assert_eq!(results[2].rows, vec![vec![json!(2)]]);

        // The second statement violates UNIQUE: the first must be rolled back.
        let failed = run_batch(&share, &[
            "UPDATE forms SET name = 'Renamed' WHERE id = 2".into(),
            "INSERT INTO forms (name) VALUES ('Form98')".into(),
        ]).await.unwrap_err();
        assert!(failed.message().starts_with("Statement 2 of 2 failed"), "{}", failed.message());
        assert!(failed.message().contains("rolled back"));
        let names = run(&share, "SELECT name FROM forms ORDER BY id").await.unwrap();
        assert_eq!(names.rows, vec![vec![json!("Form98")], vec![json!("Form99")]]);

        // Rejected statements stop the batch before anything runs.
        let rejected = run_batch(&share, &["DELETE FROM forms".into(), "DROP TABLE forms".into()]).await.unwrap_err();
        assert!(rejected.is_rejection());
        assert!(rejected.message().contains("Nothing was executed"));
        assert_eq!(run(&share, "SELECT count(*) FROM forms").await.unwrap().rows, vec![vec![json!(2)]]);
        // The connection is usable (not stuck in a transaction) afterwards.
        assert!(run(&share, "DELETE FROM form_queries").await.is_ok());

        registry::remove(&share.id).await;
        pool::close_connection(&profile.id).await;
        std::fs::remove_file(path).unwrap();
    }
}
