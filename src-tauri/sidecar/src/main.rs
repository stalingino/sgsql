mod db;
mod error;
mod pool;
mod routes;
mod ssh;
mod trace;
mod types;
mod value;

use axum::http::Method;
use axum::routing::{any, get, post};
use axum::Router;
use tower_http::cors::{Any, CorsLayer};

const DEFAULT_PORT: u16 = 45821; // distinctive high port — avoids collisions

fn get_port() -> u16 {
    std::env::args()
        .find_map(|arg| arg.strip_prefix("--port=").and_then(|p| p.parse().ok()))
        .unwrap_or(DEFAULT_PORT)
}

async fn not_found() -> axum::response::Response {
    routes::error_response("not found", 404)
}

#[allow(dead_code)]
fn assert_handlers_send() {
    fn assert_send<F: std::future::Future + Send>(_: F) {}
    assert_send(routes::cancel::handle_cancel(axum::body::Bytes::new()));
    assert_send(routes::apply::handle_schema_apply(
        axum::extract::Path(String::new()),
        axum::body::Bytes::new(),
    ));
}

#[tokio::main]
async fn main() {
    let port = get_port();
    routes::health::init_uptime();

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE, Method::OPTIONS])
        .allow_headers(Any);

    let app = Router::new()
        .route("/health", get(routes::health::handle_health))
        .route("/connections/test", post(routes::connections::handle_test_connection))
        .route("/connections/open", post(routes::connections::handle_open_connection))
        .route("/connections/close", post(routes::connections::handle_close_connection))
        .route("/connections/ensure", post(routes::connections::handle_ensure_connection))
        .route("/connections/reload", post(routes::connections::handle_reload_connection))
        .route("/query", post(routes::query::handle_query))
        .route("/cancel", post(routes::cancel::handle_cancel))
        .route("/query-log", any(routes::ws::handle_query_log))
        .route("/schema/{connId}/apply", post(routes::apply::handle_schema_apply))
        .route("/schema/{connId}/{action}", get(routes::schema::handle_schema_request))
        .fallback(not_found)
        .layer(cors);

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .unwrap_or_else(|e| panic!("failed to bind port {port}: {e}"));

    println!("sgsql-sidecar listening on port {port}");

    axum::serve(listener, app).await.expect("server error");
}
