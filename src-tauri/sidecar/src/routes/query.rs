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
}

#[derive(Deserialize)]
struct QueryBatchBody {
    #[serde(rename = "connectionId")]
    connection_id: Option<String>,
    statements: Option<Vec<String>>,
    db: Option<String>,
    #[serde(default)]
    atomic: bool,
}

enum BatchConnection {
    Postgres(PoolConnection<Postgres>),
    MySql(PoolConnection<MySql>),
    Sqlite(PoolConnection<Sqlite>),
}

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

async fn run_query(
    entry: &Arc<PoolEntry>,
    conn_id: &str,
    trace_db: &str,
    db: &str,
    sql: &str,
    select: bool,
) -> Result<Value, SidecarError> {
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

    let Some(record) = pool::get_record(&connection_id) else {
        return error_response("Connection not found. Call /connections/open first.", 404);
    };
    let trace_db = record.profile.database.clone();
    let select = is_select(&sql);

    let attempt: Result<Value, SidecarError> = async {
        let (entry, reconnected) = pool::ensure_connection_alive(&connection_id, false).await?;
        let result = run_query(&entry, &connection_id, &trace_db, &db, &sql, select).await?;
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
                let result =
                    run_query(&entry, &connection_id, &trace_db, &db, &sql, select).await?;
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
        let mut connection = match &entry.client {
            DbClient::Postgres { pool, .. } => BatchConnection::Postgres(pool.acquire().await.map_err(SidecarError::from)?),
            DbClient::MySql { pool, .. } => BatchConnection::MySql(pool.acquire().await.map_err(SidecarError::from)?),
            DbClient::Sqlite { pool } => BatchConnection::Sqlite(pool.acquire().await.map_err(SidecarError::from)?),
        };
        if matches!(connection, BatchConnection::MySql(_)) && !requested_db.is_empty() {
            let use_sql = format!("USE `{}`", requested_db.replace('`', "``"));
            connection.execute(&connection_id, &trace_db, &use_sql).await?;
        }
        if body.atomic {
            connection.execute(&connection_id, &trace_db, "BEGIN").await?;
        }

        let mut results = Vec::with_capacity(statements.len());
        let mut failed = false;
        for sql in &statements {
            let started = Instant::now();
            let outcome = if is_select(sql) {
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
            connection.execute(&connection_id, &trace_db, if rolled_back { "ROLLBACK" } else { "COMMIT" }).await?;
        }
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
    use super::is_select;

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
