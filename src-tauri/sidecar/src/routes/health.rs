use axum::response::Response;
use serde_json::json;
use std::sync::LazyLock;
use std::time::Instant;

use super::json_response;

static PROCESS_START: LazyLock<Instant> = LazyLock::new(Instant::now);

/// Called from main() so uptime starts at process launch, not first request.
pub fn init_uptime() {
    LazyLock::force(&PROCESS_START);
}

pub async fn handle_health() -> Response {
    println!("[sidecar] health check");
    json_response(
        200,
        json!({
            "status": "ok",
            "version": "0.1.0",
            "uptime": PROCESS_START.elapsed().as_secs_f64(),
        }),
    )
}
