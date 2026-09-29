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

// Needs SELECT on V$SESSION / V$SQL (SELECT_CATALOG_ROLE or a DBA grant).
const ORACLE_SESSIONS: &str = "SELECT s.sid AS \"id\", s.serial# AS \"serial\", s.username AS \"user\", \
     s.machine || CASE WHEN s.program IS NOT NULL THEN ' (' || s.program || ')' END AS \"host\", \
     s.schemaname AS \"db\", s.status AS \"command\", \
     CASE WHEN s.wait_class <> 'Idle' THEN s.event END AS \"state\", \
     s.last_call_et AS \"time\", q.sql_text AS \"info\" \
     FROM v$session s \
     LEFT JOIN v$sql q ON q.sql_id = s.sql_id AND q.child_number = s.sql_child_number \
     WHERE s.type = 'USER' AND s.sid <> SYS_CONTEXT('USERENV', 'SID') \
     ORDER BY CASE s.status WHEN 'ACTIVE' THEN 0 ELSE 1 END, s.last_call_et DESC";

const SIDE_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// Run blocking work on a fresh Oracle side connection.
async fn oracle_side<T, F>(record: &PoolRecord, f: F) -> Result<T, SidecarError>
where
    T: Send + 'static,
    F: FnOnce(&oracledb::Connection) -> Result<T, oracledb::Error> + Send + 'static,
{
    let (profile, host, port) = (record.profile.clone(), record.entry.connect_host.clone(), record.entry.connect_port);
    let run = tokio::task::spawn_blocking(move || -> Result<T, SidecarError> {
        let mut conn = crate::oracle::connect_blocking(&profile, &host, port)?;
        let result = f(&conn);
        let _ = conn.close();
        Ok(result?)
    });
    match tokio::time::timeout(Duration::from_secs(15), run).await {
        Ok(Ok(result)) => result,
        Ok(Err(join)) => Err(SidecarError::msg(format!("Oracle worker failed: {join}"))),
        Err(_) => Err(SidecarError::msg("connect timeout")),
    }
}

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
        DbClient::Oracle(session) => {
            let output = oracle_side(record, |conn| crate::oracle::fetch(conn, ORACLE_SESSIONS, &[]))
                .await
                .map_err(|error| error.oracle_needs("The process list"))?;
            let own = session.sid as i64;
            Ok(Some(annotate(output.into_objects(), |id| id == own, "INACTIVE")))
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

async fn kill_oracle(record: &PoolRecord, connection_id: &str, sid: i64, mode: KillMode) -> Result<String, SidecarError> {
    let lookup = format!("SELECT serial# FROM v$session WHERE sid = {sid}");
    let serial = oracle_side(record, move |conn| crate::oracle::fetch(conn, &lookup, &[])).await?;
    let serial = serial
        .rows
        .first()
        .and_then(|row| row.first())
        .and_then(Value::as_i64)
        .ok_or_else(|| SidecarError::msg(format!("Session {sid} is no longer running")))?;
    // CANCEL SQL on a session the app itself drives (this connection or any
    // other open Oracle connection) would hang that driver call (see
    // cancel.rs), so those sessions are killed and flagged for reconnect.
    let app_record = pool::oracle_record_for_session(sid as usize, serial as usize);
    let app_session = app_record.as_ref().and_then(|record| match &record.entry.client {
        DbClient::Oracle(session) => Some(session),
        _ => None,
    });
    let own = app_session.is_some();
    let sql = match mode {
        KillMode::Query if !own => format!("ALTER SYSTEM CANCEL SQL '{sid}, {serial}'"),
        _ => format!("ALTER SYSTEM KILL SESSION '{sid},{serial}' IMMEDIATE"),
    };
    if let Some(session) = app_session {
        session.mark_killed();
    }
    if let Err(error) = super::cancel::oracle_admin(connection_id, &record.profile, &record.entry.connect_host, record.entry.connect_port, sql).await {
        if let Some(session) = app_session {
            session.unmark_killed();
        }
        return Err(error);
    }
    Ok(match mode {
        KillMode::Query if !own => format!("Cancelled statement in session {sid},{serial}"),
        _ => format!("Killed session {sid},{serial}"),
    })
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
        DbClient::Oracle(_) => kill_oracle(&record, &body.connection_id, body.id, body.mode).await,
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
