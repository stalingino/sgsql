use axum::body::Bytes;
use axum::response::Response;
use serde_json::json;
use sqlx::Connection;
use std::sync::atomic::Ordering;
use std::time::Duration;

use super::connections::ConnectionIdBody;
use super::{error_response, json_response, parse_body};
use crate::db::DbClient;
use crate::error::SidecarError;
use crate::pool;
use crate::trace;
use crate::types::ConnectionProfile;

async fn cancel_mysql(
    connection_id: String,
    profile: ConnectionProfile,
    host: String,
    port: u16,
    tid: u64,
) -> Result<String, SidecarError> {
    // Open a separate connection to kill the query. Dial the effective
    // (possibly tunneled) endpoint, not the raw profile host.
    let options = sqlx::mysql::MySqlConnectOptions::new()
        .host(&host)
        .port(port)
        .username(&profile.username)
        .password(&profile.password)
        .ssl_mode(if profile.ssl {
            sqlx::mysql::MySqlSslMode::Required
        } else {
            sqlx::mysql::MySqlSslMode::Disabled
        });
    let mut killer = tokio::time::timeout(
        Duration::from_secs(5),
        sqlx::MySqlConnection::connect_with(&options),
    )
    .await
    .map_err(|_| SidecarError::msg("connect timeout"))??;

    let sql = format!("KILL QUERY {tid}");
    let t = trace::start(&connection_id, &profile.database, &sql);
    match crate::db::exec_mysql_conn(&mut killer, &sql).await {
        Ok(_) => t.success(None),
        Err(cause) => {
            let err = SidecarError::from(cause);
            t.failure(&err.to_string());
            return Err(err);
        }
    }
    let _ = killer.close().await;
    let detail = format!("Killed MySQL query on thread {tid}");
    println!("[sidecar] {detail}");
    Ok(detail)
}

async fn cancel_postgres(
    connection_id: String,
    profile: ConnectionProfile,
    host: String,
    port: u16,
    pids: Vec<i32>,
) -> Result<String, SidecarError> {
    if pids.is_empty() {
        return Ok(String::new());
    }
    let options = pool::pg_connect_options(&profile, &host, port);
    let mut canceller = tokio::time::timeout(
        Duration::from_secs(5),
        sqlx::PgConnection::connect_with(&options),
    )
    .await
    .map_err(|_| SidecarError::msg("connect timeout"))??;

    let mut killed: Vec<String> = Vec::new();
    for pid in pids {
        let sql = "SELECT pg_cancel_backend($1)";
        let t = trace::start(&connection_id, &profile.database, sql);
        match crate::db::pg_cancel_backend(&mut canceller, pid).await {
            Ok(()) => {
                t.success(Some(1));
                killed.push(pid.to_string());
            }
            // A stale pid is harmless; keep cancelling the rest.
            Err(cause) => t.failure(&cause.to_string()),
        }
    }
    let _ = canceller.close().await;
    let detail = format!("Killed Postgres query on pid {}", killed.join(", "));
    println!("[sidecar] {detail}");
    Ok(detail)
}

/// Run one admin statement on a fresh side connection, traced.
pub(crate) async fn oracle_admin(
    connection_id: &str,
    profile: &ConnectionProfile,
    host: &str,
    port: u16,
    sql: String,
) -> Result<(), SidecarError> {
    let t = trace::start(connection_id, &profile.database, &sql);
    let (profile, host) = (profile.clone(), host.to_string());
    let run = tokio::task::spawn_blocking(move || -> Result<(), SidecarError> {
        let mut conn = crate::oracle::connect_blocking(&profile, &host, port)?;
        let result = conn.execute(&sql, &[]).map(|_| ());
        let _ = conn.close();
        match result {
            // ORA-00031: the session is marked for kill and goes away as soon
            // as its current call notices — the goal was reached.
            Err(error) if error.to_string().contains("ORA-00031") => Ok(()),
            other => Ok(other?),
        }
    });
    let result = match tokio::time::timeout(Duration::from_secs(15), run).await {
        Ok(Ok(result)) => result,
        Ok(Err(join)) => Err(SidecarError::msg(format!("Oracle worker failed: {join}"))),
        Err(_) => Err(SidecarError::msg("connect timeout")),
    };
    match &result {
        Ok(()) => t.success(Some(1)),
        Err(error) => t.failure(&error.to_string()),
    }
    result.map_err(|error| {
        if error.to_string().contains("ORA-01031") {
            SidecarError::msg(
                "Oracle needs the ALTER SYSTEM privilege to stop a session. Ask a DBA to grant it, or wait for the statement to finish.",
            )
        } else {
            error
        }
    })
}

/// The driver hangs if its running call is interrupted with ALTER SYSTEM
/// CANCEL SQL, so the app's own session is killed instead; the next request
/// reconnects (see pool::ensure_connection_alive).
async fn cancel_oracle(
    connection_id: String,
    profile: ConnectionProfile,
    host: String,
    port: u16,
    session: &crate::oracle::OracleSession,
) -> Result<String, SidecarError> {
    if !session.is_busy() {
        return Ok(String::new());
    }
    session.mark_killed();
    let sql = format!("ALTER SYSTEM KILL SESSION '{},{}' IMMEDIATE", session.sid, session.serial);
    if let Err(error) = oracle_admin(&connection_id, &profile, &host, port, sql).await {
        session.unmark_killed();
        return Err(error);
    }
    let detail = format!("Killed Oracle session {},{}", session.sid, session.serial);
    println!("[sidecar] {detail}");
    Ok(detail)
}

pub async fn handle_cancel(bytes: Bytes) -> Response {
    println!("[sidecar] cancelling query");
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
    let profile = record.profile.clone();
    let host = record.entry.connect_host.clone();
    let port = record.entry.connect_port;

    let result: Result<String, SidecarError> = match &record.entry.client {
        DbClient::MySql { thread_id, .. } => {
            let tid = thread_id.load(Ordering::Relaxed);
            if tid == 0 {
                return error_response("Cannot determine MySQL thread ID", 500);
            }
            cancel_mysql(connection_id, profile, host, port, tid).await
        }
        DbClient::Postgres { pids, .. } => {
            let snapshot: Vec<i32> = pids.lock().unwrap().iter().copied().collect();
            cancel_postgres(connection_id, profile, host, port, snapshot).await
        }
        DbClient::Sqlite { .. } => Ok("SQLite queries cannot be killed server-side".to_string()),
        DbClient::Oracle(session) => cancel_oracle(connection_id, profile, host, port, session).await,
    };

    match result {
        Ok(detail) => json_response(200, json!({ "ok": true, "detail": detail })),
        Err(error) => {
            let message = error.friendly();
            eprintln!("[sidecar] cancel error: {message}");
            error_response(&message, 500)
        }
    }
}
