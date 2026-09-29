use axum::body::Bytes;
use axum::response::Response;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::pool::PoolConnection;
use sqlx::{MySql, Postgres, Sqlite};
use std::sync::Arc;
use std::time::Instant;

use super::{error_response, json_response, parse_body, with_connection_status};
use crate::db::{self, DbClient};
use crate::error::SidecarError;
use crate::pool::{self, PoolEntry};

#[derive(Deserialize)]
struct QueryBody {
    #[serde(rename = "connectionId")]
    connection_id: Option<String>,
    sql: Option<String>,
    db: Option<String>,
    #[serde(rename = "disableForeignKeys", default)]
    disable_foreign_keys: bool,
}

#[derive(Deserialize)]
struct QueryBatchBody {
    #[serde(rename = "connectionId")]
    connection_id: Option<String>,
    statements: Option<Vec<String>>,
    db: Option<String>,
    #[serde(default)]
    atomic: bool,
    #[serde(rename = "disableForeignKeys", default)]
    disable_foreign_keys: bool,
}

enum BatchConnection {
    Postgres(PoolConnection<Postgres>),
    MySql(PoolConnection<MySql>),
    Sqlite(PoolConnection<Sqlite>),
    Oracle(crate::oracle::OraclePinned),
}

/// Oracle cannot switch foreign-key enforcement off for a session.
const ORACLE_NO_FK_TOGGLE: &str =
    "Oracle cannot turn off foreign-key checks for a session. Disable the constraints with ALTER TABLE ... DISABLE CONSTRAINT instead.";

fn dollar_quote_end(chars: &[char], start: usize) -> Option<usize> {
    let mut tag_end = start + 1;
    if chars.get(tag_end) != Some(&'$') {
        let first = *chars.get(tag_end)?;
        if !(first.is_ascii_alphabetic() || first == '_') {
            return None;
        }
        tag_end += 1;
        while matches!(chars.get(tag_end), Some(value) if value.is_ascii_alphanumeric() || *value == '_')
        {
            tag_end += 1;
        }
        if chars.get(tag_end) != Some(&'$') {
            return None;
        }
    }

    let delimiter = &chars[start..=tag_end];
    let mut cursor = tag_end + 1;
    while cursor + delimiter.len() <= chars.len() {
        if &chars[cursor..cursor + delimiter.len()] == delimiter {
            return Some(cursor + delimiter.len());
        }
        cursor += 1;
    }
    Some(chars.len())
}

impl BatchConnection {
    async fn acquire(client: &DbClient) -> Result<Self, SidecarError> {
        Ok(match client {
            DbClient::Postgres { pool, .. } => Self::Postgres(pool.acquire().await.map_err(SidecarError::from)?),
            DbClient::MySql { pool, .. } => Self::MySql(pool.acquire().await.map_err(SidecarError::from)?),
            DbClient::Sqlite { pool } => Self::Sqlite(pool.acquire().await.map_err(SidecarError::from)?),
            DbClient::Oracle(session) => Self::Oracle(session.pin().await),
        })
    }

    /// Take the connection out of the pool for good; the pool opens a fresh
    /// one in its place.
    fn detach(self) {
        match self {
            Self::Postgres(conn) => drop(conn.detach()),
            Self::MySql(conn) => drop(conn.detach()),
            Self::Sqlite(conn) => drop(conn.detach()),
            // Never holds a changed session setting (see ORACLE_NO_FK_TOGGLE).
            Self::Oracle(pinned) => drop(pinned),
        }
    }

    async fn execute(
        &mut self,
        conn_id: &str,
        db_name: &str,
        sql: &str,
    ) -> Result<u64, SidecarError> {
        match self {
            Self::Postgres(conn) => {
                db::exec_pg_conn_traced(&mut *conn, conn_id, db_name, sql).await
            }
            Self::MySql(conn) => {
                db::exec_mysql_conn_traced(&mut *conn, conn_id, db_name, sql).await
            }
            Self::Sqlite(conn) => {
                db::exec_sqlite_conn_traced(&mut *conn, conn_id, db_name, sql).await
            }
            Self::Oracle(pinned) => {
                db::traced_result(conn_id, db_name, sql, |n: &u64| Some(*n), pinned.execute(sql)).await
            }
        }
    }

    async fn fetch(
        &mut self,
        conn_id: &str,
        db_name: &str,
        sql: &str,
    ) -> Result<db::QueryOutput, SidecarError> {
        match self {
            Self::Postgres(conn) => {
                db::fetch_pg_conn_traced(&mut *conn, conn_id, db_name, sql).await
            }
            Self::MySql(conn) => {
                db::fetch_mysql_conn_traced(&mut *conn, conn_id, db_name, sql).await
            }
            Self::Sqlite(conn) => {
                db::fetch_sqlite_conn_traced(&mut *conn, conn_id, db_name, sql).await
            }
            Self::Oracle(pinned) => {
                db::traced_result(conn_id, db_name, sql, |o: &db::QueryOutput| Some(o.rows.len() as u64), pinned.fetch(sql))
                    .await
            }
        }
    }

    /// Start a transaction. Oracle has no BEGIN: a transaction starts with the
    /// first write, so the pinned session just stops committing per statement.
    async fn begin(&mut self, conn_id: &str, db_name: &str) -> Result<(), SidecarError> {
        match self {
            Self::Oracle(pinned) => {
                pinned.begin();
                Ok(())
            }
            _ => self.execute(conn_id, db_name, "BEGIN").await.map(|_| ()),
        }
    }

    async fn finish(&mut self, conn_id: &str, db_name: &str, commit: bool) -> Result<(), SidecarError> {
        let sql = if commit { "COMMIT" } else { "ROLLBACK" };
        match self {
            Self::Oracle(pinned) => {
                let op = async { if commit { pinned.commit().await } else { pinned.rollback().await } };
                db::traced_result(conn_id, db_name, sql, |_: &()| None, op).await
            }
            _ => self.execute(conn_id, db_name, sql).await.map(|_| ()),
        }
    }
}

/// A pooled connection pinned for one request. While foreign-key checks are
/// switched off it holds the previous setting; if it is dropped before that is
/// restored (request aborted, restore failed) the connection is detached so the
/// pool never hands it out again with checks still disabled.
struct PinnedConnection {
    connection: Option<BatchConnection>,
    fk_restore: Option<String>,
}

impl PinnedConnection {
    async fn acquire(client: &DbClient) -> Result<Self, SidecarError> {
        Ok(Self { connection: Some(BatchConnection::acquire(client).await?), fk_restore: None })
    }

    fn inner(&mut self) -> &mut BatchConnection {
        self.connection.as_mut().expect("pinned connection is held until drop")
    }

    async fn execute(&mut self, conn_id: &str, db_name: &str, sql: &str) -> Result<u64, SidecarError> {
        self.inner().execute(conn_id, db_name, sql).await
    }

    async fn fetch(&mut self, conn_id: &str, db_name: &str, sql: &str) -> Result<db::QueryOutput, SidecarError> {
        self.inner().fetch(conn_id, db_name, sql).await
    }

    async fn use_db(&mut self, conn_id: &str, trace_db: &str, db_name: &str) -> Result<(), SidecarError> {
        if matches!(self.inner(), BatchConnection::MySql(_)) && !db_name.is_empty() {
            let sql = format!("USE `{}`", db_name.replace('`', "``"));
            self.execute(conn_id, trace_db, &sql).await?;
        }
        Ok(())
    }

    /// Turn foreign-key enforcement off for this session. Postgres has no
    /// dedicated switch: `session_replication_role = replica` skips the FK
    /// triggers (and ordinary user triggers) and needs superuser rights.
    async fn disable_foreign_keys(&mut self, conn_id: &str, trace_db: &str) -> Result<(), SidecarError> {
        let (read_sql, fallback, off) = match self.inner() {
            BatchConnection::Postgres(_) => ("SHOW session_replication_role", "origin", "replica"),
            BatchConnection::MySql(_) => ("SELECT @@SESSION.foreign_key_checks", "1", "0"),
            BatchConnection::Sqlite(_) => ("PRAGMA foreign_keys", "0", "0"),
            BatchConnection::Oracle(_) => return Err(SidecarError::msg(ORACLE_NO_FK_TOGGLE)),
        };
        let current = self.fetch(conn_id, trace_db, read_sql).await?.first_text();
        let previous = current
            .filter(|value| matches!(value.as_str(), "origin" | "replica" | "local" | "0" | "1"))
            .unwrap_or_else(|| fallback.to_string());
        self.fk_restore = Some(previous);
        if let Err(error) = self.set_foreign_keys(conn_id, trace_db, off).await {
            // A plain SQL error (e.g. permission denied) leaves the setting as it was.
            self.fk_restore = None;
            return Err(error);
        }
        Ok(())
    }

    async fn restore_foreign_keys(&mut self, conn_id: &str, trace_db: &str) -> Result<(), SidecarError> {
        let Some(previous) = self.fk_restore.clone() else {
            return Ok(());
        };
        self.set_foreign_keys(conn_id, trace_db, &previous).await?;
        self.fk_restore = None;
        Ok(())
    }

    async fn set_foreign_keys(&mut self, conn_id: &str, trace_db: &str, value: &str) -> Result<(), SidecarError> {
        let sql = match self.inner() {
            BatchConnection::Postgres(_) => format!("SET session_replication_role = {value}"),
            BatchConnection::MySql(_) => format!("SET FOREIGN_KEY_CHECKS = {value}"),
            BatchConnection::Sqlite(_) => format!("PRAGMA foreign_keys = {value}"),
            BatchConnection::Oracle(_) => return Err(SidecarError::msg(ORACLE_NO_FK_TOGGLE)),
        };
        self.execute(conn_id, trace_db, &sql).await.map(|_| ())
    }
}

impl Drop for PinnedConnection {
    fn drop(&mut self) {
        if self.fk_restore.is_some() {
            if let Some(connection) = self.connection.take() {
                connection.detach();
            }
        }
    }
}

fn top_level_words(sql: &str) -> Vec<String> {
    let chars: Vec<char> = sql.chars().collect();
    let mut words = Vec::new();
    let mut depth = 0usize;
    let mut i = 0usize;
    while i < chars.len() {
        match chars[i] {
            '-' if chars.get(i + 1) == Some(&'-') => {
                i += 2;
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
            }
            '#' => {
                i += 1;
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
            }
            '/' if chars.get(i + 1) == Some(&'*') => {
                i += 2;
                let mut comment_depth = 1usize;
                while i < chars.len() && comment_depth > 0 {
                    if chars[i] == '/' && chars.get(i + 1) == Some(&'*') {
                        comment_depth += 1;
                        i += 2;
                    } else if chars[i] == '*' && chars.get(i + 1) == Some(&'/') {
                        comment_depth -= 1;
                        i += 2;
                    } else {
                        i += 1;
                    }
                }
            }
            quote @ ('\'' | '"' | '`') => {
                i += 1;
                while i < chars.len() {
                    if chars[i] == quote {
                        if chars.get(i + 1) == Some(&quote) {
                            i += 2;
                            continue;
                        }
                        i += 1;
                        break;
                    }
                    if chars[i] == '\\' && quote != '"' {
                        i += 2;
                    } else {
                        i += 1;
                    }
                }
            }
            '[' => {
                i += 1;
                while i < chars.len() {
                    if chars[i] == ']' && chars.get(i + 1) == Some(&']') {
                        i += 2;
                    } else if chars[i] == ']' {
                        i += 1;
                        break;
                    } else {
                        i += 1;
                    }
                }
            }
            '$' => {
                if let Some(end) = dollar_quote_end(&chars, i) {
                    i = end;
                } else {
                    i += 1;
                }
            }
            '(' => {
                depth += 1;
                i += 1;
            }
            ')' => {
                depth = depth.saturating_sub(1);
                i += 1;
            }
            c if c.is_ascii_alphabetic() || c == '_' => {
                let start = i;
                i += 1;
                while i < chars.len()
                    && (chars[i].is_ascii_alphanumeric() || chars[i] == '_' || chars[i] == '$')
                {
                    i += 1;
                }
                if depth == 0 {
                    words.push(chars[start..i].iter().collect::<String>().to_uppercase());
                }
            }
            _ => i += 1,
        }
    }
    words
}

fn is_select(sql: &str) -> bool {
    let words = top_level_words(sql);
    let Some(first) = words.first().map(String::as_str) else {
        return false;
    };
    if matches!(
        first,
        "SELECT" | "SHOW" | "DESCRIBE" | "DESC" | "EXPLAIN" | "PRAGMA" | "VALUES" | "TABLE"
    ) {
        return true;
    }
    if matches!(first, "INSERT" | "UPDATE" | "DELETE" | "MERGE") {
        return words.iter().any(|word| word == "RETURNING");
    }
    if first == "WITH" {
        let main = words.iter().skip(1).find(|word| {
            matches!(
                word.as_str(),
                "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "MERGE" | "VALUES"
            )
        });
        return matches!(main.map(String::as_str), Some("SELECT" | "VALUES"))
            || words.iter().any(|word| word == "RETURNING");
    }
    false
}

/// Oracle returns rows only from queries: `RETURNING ... INTO` fills binds
/// rather than producing a result set, and there is no SHOW/PRAGMA/VALUES.
fn oracle_is_select(sql: &str) -> bool {
    let words = top_level_words(sql);
    match words.first().map(String::as_str) {
        Some("SELECT") => true,
        Some("WITH") => {
            let main = words.iter().skip(1).find(|word| matches!(word.as_str(), "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "MERGE"));
            main.map(String::as_str) == Some("SELECT")
        }
        _ => false,
    }
}

/// Whether `sql` produces a result set on this connection's database.
pub fn returns_rows(client: &DbClient, sql: &str) -> bool {
    match client {
        DbClient::Oracle(_) => oracle_is_select(sql),
        _ => is_select(sql),
    }
}

/// Switch the active database on a connection (MySQL: USE; Postgres and
/// SQLite: no-op — Postgres queries should use qualified names).
pub async fn switch_db(
    client: &DbClient,
    conn_id: &str,
    trace_db: &str,
    db: &str,
) -> Result<(), SidecarError> {
    if db.is_empty() {
        return Ok(());
    }
    if matches!(client, DbClient::MySql { .. }) {
        let sql = format!("USE `{}`", db.replace('`', "``"));
        db::execute_raw(client, conn_id, trace_db, &sql).await?;
    }
    Ok(())
}

async fn execute_sql(
    client: &DbClient,
    conn_id: &str,
    trace_db: &str,
    sql: &str,
    select: bool,
) -> Result<Value, SidecarError> {
    if select {
        let output = db::fetch_raw(client, conn_id, trace_db, sql).await?;
        let row_count = output.rows.len();
        Ok(json!({
            "columns": output.columns,
            "rows": output.rows,
            "rowCount": row_count,
            "query": sql,
        }))
    } else {
        let affected = db::execute_raw(client, conn_id, trace_db, sql).await?;
        Ok(json!({ "affectedRows": affected, "query": sql }))
    }
}

/// Run one statement on a pinned connection with foreign-key checks off,
/// restoring the previous setting afterwards whether or not it succeeded.
async fn run_query_without_foreign_keys(
    entry: &Arc<PoolEntry>,
    conn_id: &str,
    trace_db: &str,
    db: &str,
    sql: &str,
    select: bool,
) -> Result<Value, SidecarError> {
    let mut connection = PinnedConnection::acquire(&entry.client).await?;
    connection.use_db(conn_id, trace_db, db).await?;
    connection.disable_foreign_keys(conn_id, trace_db).await?;
    let t0 = Instant::now();
    let outcome = if select {
        connection.fetch(conn_id, trace_db, sql).await.map(|output| {
            let row_count = output.rows.len();
            json!({
                "columns": output.columns,
                "rows": output.rows,
                "rowCount": row_count,
                "query": sql,
            })
        })
    } else {
        connection
            .execute(conn_id, trace_db, sql)
            .await
            .map(|affected| json!({ "affectedRows": affected, "query": sql }))
    };
    let duration = t0.elapsed().as_secs_f64() * 1_000.0;
    let restored = connection.restore_foreign_keys(conn_id, trace_db).await;
    let mut result = outcome?;
    restored?;
    if let Some(map) = result.as_object_mut() {
        map.insert("duration".into(), json!(duration));
    }
    Ok(result)
}

async fn run_query(
    entry: &Arc<PoolEntry>,
    conn_id: &str,
    trace_db: &str,
    db: &str,
    sql: &str,
    select: bool,
    disable_fk: bool,
) -> Result<Value, SidecarError> {
    if disable_fk {
        return run_query_without_foreign_keys(entry, conn_id, trace_db, db, sql, select).await;
    }
    switch_db(&entry.client, conn_id, trace_db, db).await?;
    let t0 = Instant::now();
    let mut result = execute_sql(&entry.client, conn_id, trace_db, sql, select).await?;
    if let Some(map) = result.as_object_mut() {
        map.insert(
            "duration".into(),
            json!(t0.elapsed().as_secs_f64() * 1_000.0),
        );
    }
    Ok(result)
}

pub async fn handle_query(bytes: Bytes) -> Response {
    println!("[sidecar] executing query");
    let body: QueryBody = match parse_body(&bytes) {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    let (Some(connection_id), Some(sql)) = (
        body.connection_id.filter(|s| !s.is_empty()),
        body.sql.filter(|s| !s.is_empty()),
    ) else {
        return error_response("Missing connectionId or sql", 400);
    };
    let db = body.db.unwrap_or_default();
    let disable_fk = body.disable_foreign_keys;

    let Some(record) = pool::get_record(&connection_id) else {
        return error_response("Connection not found. Call /connections/open first.", 404);
    };
    let trace_db = record.profile.database.clone();
    let select = returns_rows(&record.entry.client, &sql);

    let attempt: Result<Value, SidecarError> = async {
        let (entry, reconnected) = pool::ensure_connection_alive(&connection_id, false).await?;
        let result =
            run_query(&entry, &connection_id, &trace_db, &db, &sql, select, disable_fk).await?;
        pool::mark_connection_used(&connection_id);
        Ok(with_connection_status(result, &connection_id, reconnected))
    }
    .await;

    match attempt {
        Ok(value) => json_response(200, value),
        Err(error) if error.is_connection_error() => {
            println!(
                "[sidecar] connection error detected, attempting reconnect for {connection_id}..."
            );
            let retry: Result<Value, SidecarError> = async {
                let entry = pool::reconnect(&connection_id).await?;
                let result = run_query(
                    &entry,
                    &connection_id,
                    &trace_db,
                    &db,
                    &sql,
                    select,
                    disable_fk,
                )
                .await?;
                pool::mark_connection_used(&connection_id);
                Ok(with_connection_status(result, &connection_id, true))
            }
            .await;
            match retry {
                Ok(value) => json_response(200, value),
                Err(retry_error) => {
                    let message = retry_error.friendly();
                    eprintln!("[sidecar] reconnect+retry failed: {message}");
                    error_response(&message, 500)
                }
            }
        }
        Err(error) => {
            let message = error.friendly();
            eprintln!("[sidecar] query error: {message}");
            error_response(&message, 500)
        }
    }
}

pub async fn handle_query_batch(bytes: Bytes) -> Response {
    let body: QueryBatchBody = match parse_body(&bytes) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let Some(connection_id) = body.connection_id.filter(|value| !value.is_empty()) else {
        return error_response("Missing connectionId", 400);
    };
    let statements: Vec<String> = body
        .statements
        .unwrap_or_default()
        .into_iter()
        .filter(|sql| !sql.trim().is_empty())
        .collect();
    if statements.is_empty() || statements.len() > 100 {
        return error_response("Batch must contain 1 to 100 statements", 400);
    }
    let requested_db = body.db.unwrap_or_default();
    let Some(record) = pool::get_record(&connection_id) else {
        return error_response("Connection not found. Call /connections/open first.", 404);
    };
    let trace_db = record.profile.database.clone();

    let attempt: Result<Value, SidecarError> = async {
        let (entry, reconnected) = pool::ensure_connection_alive(&connection_id, false).await?;
        let mut connection = PinnedConnection::acquire(&entry.client).await?;
        connection.use_db(&connection_id, &trace_db, &requested_db).await?;
        // Before BEGIN: SQLite ignores PRAGMA foreign_keys inside a transaction.
        if body.disable_foreign_keys {
            connection.disable_foreign_keys(&connection_id, &trace_db).await?;
        }
        let batch: Result<(Vec<Value>, bool), SidecarError> = async {
            if body.atomic {
                connection.inner().begin(&connection_id, &trace_db).await?;
            }

            let mut results = Vec::with_capacity(statements.len());
            let mut failed = false;
            for sql in &statements {
                let started = Instant::now();
                let outcome = if returns_rows(&entry.client, sql) {
                    connection.fetch(&connection_id, &trace_db, sql).await.map(|output| {
                        let row_count = output.rows.len();
                        json!({
                            "columns": output.columns,
                            "rows": output.rows,
                            "rowCount": row_count,
                            "query": sql,
                            "duration": started.elapsed().as_secs_f64() * 1_000.0,
                        })
                    })
                } else {
                    connection.execute(&connection_id, &trace_db, sql).await.map(|affected| json!({
                        "affectedRows": affected,
                        "query": sql,
                        "duration": started.elapsed().as_secs_f64() * 1_000.0,
                    }))
                };
                match outcome {
                    Ok(result) => results.push(result),
                    Err(error) => {
                        results.push(json!({ "query": sql, "error": error.friendly(), "duration": started.elapsed().as_secs_f64() * 1_000.0 }));
                        failed = true;
                        if body.atomic { break; }
                    }
                }
            }

            let rolled_back = body.atomic && failed;
            if body.atomic {
                connection.inner().finish(&connection_id, &trace_db, !rolled_back).await?;
            }
            Ok((results, rolled_back))
        }
        .await;
        let restored = connection.restore_foreign_keys(&connection_id, &trace_db).await;
        let (results, rolled_back) = batch?;
        restored?;
        pool::mark_connection_used(&connection_id);
        Ok(with_connection_status(json!({ "results": results, "rolledBack": rolled_back }), &connection_id, reconnected))
    }.await;

    match attempt {
        Ok(value) => json_response(200, value),
        Err(error) => error_response(&error.friendly(), 500),
    }
}

#[cfg(test)]
mod tests {
    use super::{is_select, oracle_is_select, PinnedConnection};
    use crate::db::DbClient;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    async fn sqlite_client() -> DbClient {
        let options = SqliteConnectOptions::new().in_memory(true).foreign_keys(true);
        let pool = SqlitePoolOptions::new().max_connections(1).connect_with(options).await.unwrap();
        DbClient::Sqlite { pool }
    }

    async fn foreign_keys(connection: &mut PinnedConnection) -> String {
        connection.fetch("test", "", "PRAGMA foreign_keys").await.unwrap().first_text().unwrap()
    }

    #[tokio::test]
    async fn foreign_key_checks_are_disabled_then_restored() {
        let client = sqlite_client().await;
        let mut connection = PinnedConnection::acquire(&client).await.unwrap();
        connection.disable_foreign_keys("test", "").await.unwrap();
        assert_eq!(foreign_keys(&mut connection).await, "0");
        connection.restore_foreign_keys("test", "").await.unwrap();
        assert_eq!(foreign_keys(&mut connection).await, "1");
    }

    #[tokio::test]
    async fn unrestored_connection_is_not_returned_to_the_pool() {
        let client = sqlite_client().await;
        let DbClient::Sqlite { pool } = &client else { unreachable!() };
        let mut connection = PinnedConnection::acquire(&client).await.unwrap();
        connection.disable_foreign_keys("test", "").await.unwrap();
        drop(connection);
        assert_eq!(pool.size(), 0);
    }

    #[test]
    fn oracle_select_detection() {
        assert!(oracle_is_select("SELECT sid, serial# FROM v$session"));
        assert!(oracle_is_select("with x as (select 1 from dual) select * from x"));
        assert!(!oracle_is_select("UPDATE t SET a = 1 RETURNING a INTO :out"));
        assert!(!oracle_is_select("BEGIN NULL; END;"));
        assert!(!oracle_is_select("EXPLAIN PLAN FOR SELECT 1 FROM dual"));
    }

    #[test]
    fn select_detection_handles_result_producing_statements() {
        assert!(is_select("SELECT 1"));
        assert!(is_select("  \n select * from t"));
        assert!(is_select("SHOW TABLES"));
        assert!(is_select("describe t"));
        assert!(is_select("EXPLAIN SELECT 1"));
        assert!(is_select("WITH x AS (SELECT 1) SELECT * FROM x"));
        assert!(is_select("UPDATE people SET name = 'Ada' RETURNING *"));
        assert!(!is_select(
            "UPDATE people SET note = $body$RETURNING is text$body$"
        ));
        assert!(is_select("PRAGMA table_info(people)"));
        assert!(!is_select(
            "WITH x AS (SELECT 1) UPDATE people SET name = 'Ada'"
        ));
        assert!(!is_select("SELECTX"));
        assert!(!is_select("INSERT INTO t VALUES (1)"));
        assert!(!is_select("UPDATE t SET a = 1"));
    }
}
