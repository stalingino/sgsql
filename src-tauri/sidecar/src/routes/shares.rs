//! Management of agent shares (app-authenticated): create, list, inspect, stop.

use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::{Path, Query};
use axum::response::Response;
use serde_json::{json, Value};

use super::{error_response, json_response, parse_body};
use crate::pool;
use crate::share::{exec, registry};
use crate::share::types::CreateShareRequest;

pub async fn handle_create(bytes: Bytes) -> Response {
    let body: CreateShareRequest = match parse_body(&bytes) {
        Ok(body) => body,
        Err(response) => return response,
    };
    if body.connection_id.is_empty() {
        return error_response("Missing connectionId", 400);
    }
    let Some(record) = pool::get_record(&body.connection_id) else {
        return error_response("Connection not found. Call /connections/open first.", 404);
    };

    let share = match registry::create(body, &record.profile) {
        Ok(share) => share,
        Err(error) => return error_response(&error.friendly(), 400),
    };

    // Open the dedicated connection now so tunnel / file / permission
    // problems surface to the user instead of to the agent.
    if let Err(error) = exec::ensure_open(&share).await {
        registry::remove(&share.id).await;
        let message = error.friendly();
        eprintln!("[mcp] share connection failed: {message}");
        return error_response(&message, 500);
    }

    println!("[mcp] share {} started for connection {} ({}, {})",
        share.id,
        share.connection_id,
        if share.all_databases { "all databases".to_string() } else if share.full_database { "full database".to_string() } else { format!("{} tables", share.tables.len()) },
        if share.read_only { "read-only" } else { "read-write" });
    json_response(201, json!({ "share": share.info(true) }))
}

pub async fn handle_list(Query(params): Query<HashMap<String, String>>) -> Response {
    let connection_id = params.get("connectionId").map(String::as_str).filter(|s| !s.is_empty());
    let shares: Vec<Value> = registry::list(connection_id).iter().map(|s| s.info(false)).collect();
    json_response(200, json!({ "shares": shares }))
}

pub async fn handle_get(Path(id): Path<String>) -> Response {
    match registry::get(&id) {
        Some(share) => json_response(200, json!({ "share": share.info(false) })),
        None => error_response("share not found", 404),
    }
}

pub async fn handle_delete(Path(id): Path<String>) -> Response {
    match registry::remove(&id).await {
        Some(share) => {
            println!("[mcp] share {} stopped", share.id);
            json_response(200, json!({ "ok": true }))
        }
        None => error_response("share not found", 404),
    }
}
