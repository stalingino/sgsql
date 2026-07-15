use axum::body::Bytes;
use axum::response::Response;
use serde::Deserialize;
use serde_json::{json, Value};
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

fn is_select(sql: &str) -> bool {
    let trimmed = sql.trim_start();
    ["SELECT", "SHOW", "DESCRIBE", "EXPLAIN"]
        .iter()
        .any(|kw| trimmed.len() >= kw.len() && trimmed[..kw.len()].eq_ignore_ascii_case(kw))
}

/// Switch the active database on a connection (MySQL: USE; Postgres and
/// SQLite: no-op — Postgres queries should use qualified names).
pub async fn switch_db(client: &DbClient, conn_id: &str, trace_db: &str, db: &str) -> Result<(), SidecarError> {
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
        map.insert("duration".into(), json!(t0.elapsed().as_secs_f64() * 1_000.0));
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
            println!("[sidecar] connection error detected, attempting reconnect for {connection_id}...");
            let retry: Result<Value, SidecarError> = async {
                let entry = pool::reconnect(&connection_id).await?;
                let result = run_query(&entry, &connection_id, &trace_db, &db, &sql, select).await?;
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

#[cfg(test)]
mod tests {
    use super::is_select;

    #[test]
    fn select_detection_matches_the_old_regex() {
        assert!(is_select("SELECT 1"));
        assert!(is_select("  \n select * from t"));
        assert!(is_select("SHOW TABLES"));
        assert!(is_select("describe t"));
        assert!(is_select("EXPLAIN SELECT 1"));
        // Prefix match, no word boundary — same as /^\s*(SELECT|...)/i.
        assert!(is_select("SELECTX"));
        assert!(!is_select("INSERT INTO t VALUES (1)"));
        assert!(!is_select("UPDATE t SET a = 1"));
    }
}
