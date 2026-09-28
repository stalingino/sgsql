use axum::body::Bytes;
use axum::response::Response;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Connection;
use std::sync::atomic::Ordering;
use std::time::Duration;

use super::connections::ConnectionIdBody;
use super::{error_response, json_response, parse_body};
use crate::db::DbClient;
use crate::error::SidecarError;
use crate::pool::{self, PoolRecord};
use crate::trace;

// Both queries run on a side connection: MySQL pools a single connection, so
// the list would otherwise queue behind the very query the user wants to kill.

const MYSQL_PROCESSLIST: &str = "SELECT ID AS id, USER AS `user`, HOST AS host, DB AS db, \
     COMMAND AS command, STATE AS state, TIME AS time, INFO AS info \
     FROM information_schema.PROCESSLIST \
     WHERE ID <> CONNECTION_ID() \
     ORDER BY COMMAND = 'Sleep', TIME DESC";

const PG_ACTIVITY: &str = "SELECT pid::int8 AS id, usename::text AS \"user\", \
     COALESCE(host(client_addr) || ':' || client_port, CASE WHEN client_port = -1 THEN 'local socket' ELSE '' END) AS host, \
     datname::text AS db, COALESCE(state, '') AS command, \
     COALESCE(wait_event_type || ': ' || wait_event, '') AS state, \
     EXTRACT(EPOCH FROM now() - COALESCE(state_change, backend_start))::int8 AS time, \
     query AS info \
     FROM pg_stat_activity \
     WHERE backend_type = 'client backend' AND pid <> pg_backend_pid() \
     ORDER BY (state = 'idle'), time DESC NULLS LAST";

const SIDE_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

async fn mysql_side(record: &PoolRecord) -> Result<sqlx::MySqlConnection, SidecarError> {
    let options = pool::mysql_connect_options(&record.profile, &record.entry.connect_host, record.entry.connect_port);
    tokio::time::timeout(SIDE_CONNECT_TIMEOUT, sqlx::MySqlConnection::connect_with(&options))
        .await
        .map_err(|_| SidecarError::msg("connect timeout"))?
        .map_err(SidecarError::from)
}

async fn pg_side(record: &PoolRecord) -> Result<sqlx::PgConnection, SidecarError> {
    let options = pool::pg_connect_options(&record.profile, &record.entry.connect_host, record.entry.connect_port);
    tokio::time::timeout(SIDE_CONNECT_TIMEOUT, sqlx::PgConnection::connect_with(&options))
        .await
        .map_err(|_| SidecarError::msg("connect timeout"))?
        .map_err(SidecarError::from)
}

/// Flag the app's own pooled connections and idle sessions for the UI.
fn annotate(rows: Vec<Value>, is_own: impl Fn(i64) -> bool, idle_command: &str) -> Vec<Value> {
    rows.into_iter()
        .map(|mut row| {
            let id = row.get("id").and_then(Value::as_i64).unwrap_or(0);
            let idle = row.get("command").and_then(Value::as_str) == Some(idle_command);
            if let Some(map) = row.as_object_mut() {
                map.insert("own".into(), Value::Bool(is_own(id)));
                map.insert("idle".into(), Value::Bool(idle));
            }
            row
        })
        .collect()
}

async fn list(record: &PoolRecord) -> Result<Option<Vec<Value>>, SidecarError> {
    match &record.entry.client {
        DbClient::MySql { thread_id, .. } => {
            let mut conn = mysql_side(record).await?;
            let output = crate::db::fetch_mysql_conn(&mut conn, MYSQL_PROCESSLIST).await;
            let _ = conn.close().await;
            let own = thread_id.load(Ordering::Relaxed) as i64;
            Ok(Some(annotate(output?.into_objects(), |id| id == own, "Sleep")))
        }
        DbClient::Postgres { pids, .. } => {
            let mut conn = pg_side(record).await?;
            let output = crate::db::fetch_pg_conn(&mut conn, PG_ACTIVITY).await;
            let _ = conn.close().await;
            let own = pids.lock().unwrap().clone();
            Ok(Some(annotate(output?.into_objects(), |id| own.contains(&(id as i32)), "idle")))
        }
        DbClient::Sqlite { .. } => Ok(None),
    }
}

pub async fn handle_processes(bytes: Bytes) -> Response {
    let body: ConnectionIdBody = match parse_body(&bytes) {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    let Some(connection_id) = body.connection_id.filter(|s| !s.is_empty()) else {
        return error_response("Missing connectionId", 400);
    };
    let Some(record) = pool::get_record(&connection_id) else {
        return error_response("Connection not found", 404);
    };
    match list(&record).await {
        Ok(Some(processes)) => json_response(200, json!({ "supported": true, "processes": processes })),
        Ok(None) => json_response(200, json!({ "supported": false, "processes": [] })),
        Err(error) => error_response(&error.friendly(), 500),
    }
}

#[derive(Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
enum KillMode {
    /// Stop the running statement, keep the session.
    Query,
    /// Drop the whole session.
    Connection,
}

#[derive(Deserialize)]
struct KillBody {
    #[serde(rename = "connectionId")]
    connection_id: String,
    id: i64,
    mode: KillMode,
}

async fn kill_mysql(record: &PoolRecord, connection_id: &str, id: u64, mode: KillMode) -> Result<String, SidecarError> {
    let sql = match mode {
        KillMode::Query => format!("KILL QUERY {id}"),
        KillMode::Connection => format!("KILL CONNECTION {id}"),
    };
    let mut conn = mysql_side(record).await?;
    let mut result = crate::db::exec_mysql_conn_traced(&mut conn, connection_id, &record.profile.database, &sql).await;
    // Amazon RDS/Aurora refuse KILL on other users' threads ("You are not
    // owner of thread") but ship stored procedures that do the same job.
    if let Err(error) = &result {
        if error.to_string().to_lowercase().contains("not owner of thread") {
            let procedure = match mode {
                KillMode::Query => "mysql.rds_kill_query",
                KillMode::Connection => "mysql.rds_kill",
            };
            let rds_sql = format!("CALL {procedure}({id})");
            if crate::db::exec_mysql_conn_traced(&mut conn, connection_id, &record.profile.database, &rds_sql).await.is_ok() {
                result = Ok(0);
            }
        }
    }
    let _ = conn.close().await;
    result?;
    Ok(match mode {
        KillMode::Query => format!("Killed query on thread {id}"),
        KillMode::Connection => format!("Killed connection {id}"),
    })
}

async fn kill_postgres(record: &PoolRecord, connection_id: &str, pid: i32, mode: KillMode) -> Result<String, SidecarError> {
    let function = match mode {
        KillMode::Query => "pg_cancel_backend",
        KillMode::Connection => "pg_terminate_backend",
    };
    let mut conn = pg_side(record).await?;
    let t = trace::start(connection_id, &record.profile.database, &format!("SELECT {function}({pid})"));
    let result = crate::db::pg_signal_backend(&mut conn, function, pid).await;
    let _ = conn.close().await;
    match result {
        Ok(true) => {
            t.success(Some(1));
            Ok(match mode {
                KillMode::Query => format!("Cancelled query on pid {pid}"),
                KillMode::Connection => format!("Terminated pid {pid}"),
            })
        }
        Ok(false) => {
            let message = format!("pid {pid} is no longer running");
            t.failure(&message);
            Err(SidecarError::msg(message))
        }
        Err(cause) => {
            let error = SidecarError::from(cause);
            t.failure(&error.to_string());
            Err(error)
        }
    }
}

pub async fn handle_kill_process(bytes: Bytes) -> Response {
    let body: KillBody = match parse_body(&bytes) {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    let Some(record) = pool::get_record(&body.connection_id) else {
        return error_response("Connection not found", 404);
    };
    let result = match &record.entry.client {
        DbClient::MySql { .. } => match u64::try_from(body.id) {
            Ok(id) => kill_mysql(&record, &body.connection_id, id, body.mode).await,
            Err(_) => return error_response("Invalid process id", 400),
        },
        DbClient::Postgres { .. } => match i32::try_from(body.id) {
            Ok(pid) => kill_postgres(&record, &body.connection_id, pid, body.mode).await,
            Err(_) => return error_response("Invalid process id", 400),
        },
        DbClient::Sqlite { .. } => return error_response("SQLite has no server processes", 400),
    };
    match result {
        Ok(detail) => {
            println!("[sidecar] {detail}");
            json_response(200, json!({ "ok": true, "detail": detail }))
        }
        Err(error) => error_response(&error.friendly(), 500),
    }
}
