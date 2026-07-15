pub mod apply;
pub mod cancel;
pub mod connections;
pub mod health;
pub mod query;
pub mod schema;
pub mod ws;

use axum::body::Bytes;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};

pub fn json_response(status: u16, value: Value) -> Response {
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        axum::Json(value),
    )
        .into_response()
}

pub fn error_response(message: &str, status: u16) -> Response {
    json_response(status, json!({ "error": message }))
}

pub fn parse_body<T: DeserializeOwned>(bytes: &Bytes) -> Result<T, Response> {
    serde_json::from_slice(bytes).map_err(|_| error_response("Invalid JSON body", 400))
}

/// After an auto-reconnect, responses gain a `_connection` marker so the
/// frontend can refresh connection state.
pub fn with_connection_status(mut value: Value, connection_id: &str, reconnected: bool) -> Value {
    if reconnected {
        if let Some(map) = value.as_object_mut() {
            map.insert(
                "_connection".to_string(),
                json!({ "connectionId": connection_id, "reconnected": true }),
            );
        }
    }
    value
}
