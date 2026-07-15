use axum::body::Bytes;
use axum::response::Response;
use serde::Deserialize;
use serde_json::json;
use std::time::Instant;

use super::{error_response, json_response, parse_body, with_connection_status};
use crate::error::SidecarError;
use crate::pool;
use crate::types::ConnectionProfile;

#[derive(Deserialize)]
pub struct ConnectionIdBody {
    #[serde(rename = "connectionId")]
    pub connection_id: Option<String>,
}

fn ssh_context_message(profile: &ConnectionProfile, error: &SidecarError) -> String {
    let base = error.friendly();
    // SSH-stage failures already name the failing layer; anything else after a
    // successful tunnel means the database behind it was unreachable.
    if profile.use_ssh && !base.starts_with("SSH ") {
        format!(
            "SSH tunnel established, but the database at {}:{} could not be reached. {}",
            profile.host, profile.port, base
        )
    } else {
        base
    }
}

// ---------------------------------------------------------------------------
// POST /connections/test
// ---------------------------------------------------------------------------

pub async fn handle_test_connection(bytes: Bytes) -> Response {
    println!("[sidecar] testing connection");
    let profile: ConnectionProfile = match parse_body(&bytes) {
        Ok(p) => p,
        Err(resp) => return resp,
    };
    let start = Instant::now();
    let elapsed = |start: Instant| start.elapsed().as_millis() as u64;

    if profile.db_type == "sqlite" {
        if tokio::fs::metadata(&profile.database).await.is_err() {
            return json_response(
                200,
                json!({ "ok": false, "error": format!("File not found: {}", profile.database) }),
            );
        }
        return json_response(200, json!({ "ok": true, "latency": elapsed(start) }));
    }

    let result: Result<(), SidecarError> = async {
        let entry = pool::connect(&profile).await?;
        let probe = crate::db::fetch_raw(&entry.client, &profile.id, &profile.database, "SELECT 1").await;
        pool::close_entry(&entry).await;
        probe.map(|_| ())
    }
    .await;

    match result {
        Ok(()) => json_response(200, json!({ "ok": true, "latency": elapsed(start) })),
        Err(error) => {
            let message = ssh_context_message(&profile, &error);
            eprintln!("[sidecar] connection test failed: {message}");
            json_response(200, json!({ "ok": false, "error": message, "latency": elapsed(start) }))
        }
    }
}

// ---------------------------------------------------------------------------
// POST /connections/open
// ---------------------------------------------------------------------------

pub async fn handle_open_connection(bytes: Bytes) -> Response {
    let profile: ConnectionProfile = match parse_body(&bytes) {
        Ok(p) => p,
        Err(resp) => return resp,
    };

    println!(
        "[sidecar] opening connection: id={}, type={}, user={}, hasPassword={}, host={}:{}/{}",
        profile.id,
        profile.db_type,
        profile.username,
        !profile.password.is_empty(),
        profile.host,
        profile.port,
        profile.database
    );

    if profile.id.is_empty() || profile.db_type.is_empty() {
        return error_response("Missing id or type in profile", 400);
    }
    if !matches!(profile.db_type.as_str(), "postgres" | "mysql" | "sqlite") {
        return error_response(&format!("Unsupported connection type: {}", profile.db_type), 400);
    }

    match pool::open_connection(&profile).await {
        Ok((_entry, server_version)) => json_response(
            200,
            json!({ "connectionId": profile.id, "serverVersion": server_version }),
        ),
        Err(error) => {
            let message = ssh_context_message(&profile, &error);
            eprintln!("[sidecar] open connection failed: {message}");
            error_response(&message, 500)
        }
    }
}

// ---------------------------------------------------------------------------
// POST /connections/close
// ---------------------------------------------------------------------------

pub async fn handle_close_connection(bytes: Bytes) -> Response {
    println!("[sidecar] closing connection");
    let body: ConnectionIdBody = match parse_body(&bytes) {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    let Some(connection_id) = body.connection_id.filter(|s| !s.is_empty()) else {
        return error_response("Missing connectionId", 400);
    };

    if pool::close_connection(&connection_id).await {
        json_response(200, json!({ "ok": true }))
    } else {
        error_response("Connection not found", 404)
    }
}

// ---------------------------------------------------------------------------
// POST /connections/ensure — bounded idle health check + reconnect
// ---------------------------------------------------------------------------

pub async fn handle_ensure_connection(bytes: Bytes) -> Response {
    println!("[sidecar] checking connection");
    let body: ConnectionIdBody = match parse_body(&bytes) {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    let Some(connection_id) = body.connection_id.filter(|s| !s.is_empty()) else {
        return error_response("Missing connectionId", 400);
    };

    match pool::ensure_connection_alive(&connection_id, false).await {
        Ok((_entry, reconnected)) => json_response(
            200,
            with_connection_status(
                json!({ "ok": true, "reconnected": reconnected }),
                &connection_id,
                reconnected,
            ),
        ),
        Err(error) => {
            let message = error.friendly();
            eprintln!("[sidecar] connection ensure failed: {message}");
            error_response(&message, 500)
        }
    }
}

// ---------------------------------------------------------------------------
// POST /connections/reload — force a fresh connection using the saved profile
// ---------------------------------------------------------------------------

pub async fn handle_reload_connection(bytes: Bytes) -> Response {
    println!("[sidecar] reloading connection");
    let body: ConnectionIdBody = match parse_body(&bytes) {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    let Some(connection_id) = body.connection_id.filter(|s| !s.is_empty()) else {
        return error_response("Missing connectionId", 400);
    };

    match pool::reconnect(&connection_id).await {
        Ok(_) => json_response(200, json!({ "ok": true })),
        Err(error) => {
            let message = error.friendly();
            eprintln!("[sidecar] connection reload failed: {message}");
            error_response(&message, 500)
        }
    }
}
