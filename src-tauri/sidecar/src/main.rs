mod auth;
mod db;
mod error;
mod pool;
mod routes;
mod share;
mod ssh;
mod trace;
mod types;
mod value;

use axum::http::{header, HeaderValue, Method};
use axum::middleware;
use axum::routing::{any, get, post};
use axum::Router;
use tower_http::cors::CorsLayer;

const DEFAULT_PORT: u16 = 45821; // distinctive high port — avoids collisions

fn get_port() -> u16 {
    std::env::args()
        .find_map(|arg| arg.strip_prefix("--port=").and_then(|p| p.parse().ok()))
        .unwrap_or(DEFAULT_PORT)
}

fn get_auth_token() -> String {
    std::env::var("SGSQL_SIDECAR_TOKEN")
        .ok()
        .filter(|token| token.len() >= 32)
        .unwrap_or_else(|| {
            eprintln!("SGSQL_SIDECAR_TOKEN must contain at least 32 characters");
            std::process::exit(2);
        })
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
    let auth = auth::AuthState::new(get_auth_token());
    routes::health::init_uptime();

    let cors = CorsLayer::new()
        .allow_origin(vec![
            HeaderValue::from_static("tauri://localhost"),
            HeaderValue::from_static("http://tauri.localhost"),
            HeaderValue::from_static("http://localhost:5173"),
        ])
        .allow_methods([Method::GET, Method::POST, Method::DELETE, Method::OPTIONS])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE]);

    let app = Router::new()
        .route("/health", get(routes::health::handle_health))
        .route("/connections/test", post(routes::connections::handle_test_connection))
        .route("/connections/open", post(routes::connections::handle_open_connection))
        .route("/connections/close", post(routes::connections::handle_close_connection))
        .route("/connections/ensure", post(routes::connections::handle_ensure_connection))
        .route("/connections/reload", post(routes::connections::handle_reload_connection))
        .route("/query", post(routes::query::handle_query))
        .route("/query/batch", post(routes::query::handle_query_batch))
        .route("/cancel", post(routes::cancel::handle_cancel))
        .route("/query-log", any(routes::ws::handle_query_log))
        .route("/schema/{connId}/apply", post(routes::apply::handle_schema_apply))
        .route("/schema/{connId}/{action}", get(routes::schema::handle_schema_request))
        .route("/shares", post(routes::shares::handle_create).get(routes::shares::handle_list))
        .route("/shares/{id}", get(routes::shares::handle_get).delete(routes::shares::handle_delete))
        .fallback(not_found)
        .layer(middleware::from_fn_with_state(auth, auth::require_auth))
        .layer(cors);

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .unwrap_or_else(|e| panic!("failed to bind port {port}: {e}"));

    println!("sgsql-sidecar listening on port {port}");

    // Agent (MCP) listener: separate port, per-share tokens, no app CORS.
    match share::server::bind().await {
        Ok(mcp_listener) => {
            println!("sgsql-sidecar mcp listening on port {}", share::server::mcp_port());
            tokio::spawn(async move {
                if let Err(error) = axum::serve(mcp_listener, share::server::router()).await {
                    eprintln!("[mcp] server error: {error}");
                }
            });
        }
        Err(error) => eprintln!("[mcp] failed to bind agent listener: {error}"),
    }

    axum::serve(listener, app).await.expect("server error");
}
