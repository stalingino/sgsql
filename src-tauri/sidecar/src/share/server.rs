//! Second HTTP listener for agents: Streamable HTTP transport for MCP.
//! Loopback only, per-share bearer tokens, no browser access.

use std::sync::OnceLock;

use axum::body::Bytes;
use axum::extract::{Path, Request};
use axum::http::header::{HOST, ORIGIN, WWW_AUTHENTICATE};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Router;
use serde_json::Value;
use tokio::net::TcpListener;

use super::mcp::{self, LiveBackend, Outcome, RpcRequest};
use super::registry;
use crate::auth;
use crate::routes::{error_response, json_response};

pub const DEFAULT_MCP_PORT: u16 = 45822;

static MCP_PORT: OnceLock<u16> = OnceLock::new();

pub fn mcp_port() -> u16 {
    *MCP_PORT.get().unwrap_or(&DEFAULT_MCP_PORT)
}

/// Bind the agent listener: the fixed port keeps agent configs stable, the
/// OS-assigned fallback keeps the feature working when it is taken.
pub async fn bind() -> std::io::Result<TcpListener> {
    let listener = match TcpListener::bind(("127.0.0.1", DEFAULT_MCP_PORT)).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("[mcp] port {DEFAULT_MCP_PORT} unavailable ({error}); using a free port");
            TcpListener::bind(("127.0.0.1", 0)).await?
        }
    };
    let port = listener.local_addr()?.port();
    let _ = MCP_PORT.set(port);
    Ok(listener)
}

fn is_loopback_host(host: &str) -> bool {
    let name = host.rsplit_once(':').map(|(name, _)| name).unwrap_or(host);
    name == "127.0.0.1" || name == "localhost" || name == "[::1]"
}

fn host_is_loopback(headers: &HeaderMap) -> bool {
    headers
        .get(HOST)
        .and_then(|value| value.to_str().ok())
        .map(is_loopback_host)
        .unwrap_or(true)
}

/// Absent (non-browser client) or a loopback origin; anything else is a web
/// page trying to reach the agent endpoint.
fn origin_is_loopback(headers: &HeaderMap) -> bool {
    headers
        .get(ORIGIN)
        .and_then(|value| value.to_str().ok())
        .map(|origin| {
            origin
                .strip_prefix("http://")
                .or_else(|| origin.strip_prefix("https://"))
                .is_some_and(is_loopback_host)
        })
        .unwrap_or(true)
}

/// Agents are not browsers: a foreign `Origin` means a web page is calling,
/// and a non-loopback `Host` means DNS rebinding. Both are refused.
pub async fn reject_browser_requests(request: Request, next: Next) -> Response {
    if !origin_is_loopback(request.headers()) {
        return error_response("origin not allowed", 403);
    }
    if !host_is_loopback(request.headers()) {
        return error_response("host not allowed", 403);
    }
    next.run(request).await
}

async fn method_not_allowed() -> Response {
    error_response("MCP requests must be POSTed as JSON-RPC", 405)
}

fn unauthorized() -> Response {
    let mut response = error_response("unauthorized", 401);
    response
        .headers_mut()
        .insert(WWW_AUTHENTICATE, "Bearer realm=\"sgsql-share\"".parse().unwrap());
    response
}

pub async fn handle_mcp_post(Path(share_id): Path<String>, headers: HeaderMap, body: Bytes) -> Response {
    let Some(share) = registry::get(&share_id) else {
        return error_response("share not found", 404);
    };
    if !auth::token_matches(auth::bearer_token(&headers), &share.token) {
        return unauthorized();
    }

    let payload: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(_) => return json_response(200, mcp::rpc_error(Value::Null, mcp::PARSE_ERROR, "Parse error")),
    };
    if payload.is_array() {
        return json_response(
            200,
            mcp::rpc_error(Value::Null, mcp::INVALID_REQUEST, "Batch requests are not supported"),
        );
    }
    let request: RpcRequest = match serde_json::from_value(payload) {
        Ok(request) => request,
        Err(_) => return json_response(200, mcp::rpc_error(Value::Null, mcp::INVALID_REQUEST, "Invalid request")),
    };

    match mcp::dispatch(&share, request, &LiveBackend(&share)).await {
        Outcome::Response(value) => json_response(200, value),
        Outcome::Accepted => StatusCode::ACCEPTED.into_response(),
    }
}

async fn not_found() -> Response {
    error_response("not found", 404)
}

pub fn router() -> Router {
    Router::new()
        .route(
            "/mcp/{share_id}",
            post(handle_mcp_post).get(method_not_allowed).delete(method_not_allowed),
        )
        .fallback(not_found)
        .layer(middleware::from_fn(reject_browser_requests))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::share::types::{AllowedTable, CreateShareRequest};
    use axum::body::Body;
    use axum::http::header::AUTHORIZATION;
    use http_body_util::BodyExt;

    fn create_share() -> std::sync::Arc<crate::share::types::Share> {
        let profile: crate::types::ConnectionProfile = serde_json::from_value(serde_json::json!({
            "id": "conn-test", "name": "Test", "type": "postgres", "database": "app"
        }))
        .unwrap();
        registry::create(
            CreateShareRequest {
                connection_id: "conn-test".into(),
                db: None,
                full_database: false,
                all_databases: false,
                tables: vec![AllowedTable { schema: String::new(), name: "users".into(), kind: "table".into() }],
                read_only: true,
                max_rows: 10,
                timeout_ms: 5_000,
            },
            &profile,
        )
        .unwrap()
    }

    fn headers(token: Option<&str>) -> HeaderMap {
        let mut headers = HeaderMap::new();
        if let Some(token) = token {
            headers.insert(AUTHORIZATION, format!("Bearer {token}").parse().unwrap());
        }
        headers
    }

    async fn body_json(response: Response) -> Value {
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn rejects_unknown_share_and_bad_tokens() {
        let share = create_share();
        let body = Bytes::from_static(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}");

        let r = handle_mcp_post(Path("nope".into()), headers(Some(&share.token)), body.clone()).await;
        assert_eq!(r.status(), 404);

        let r = handle_mcp_post(Path(share.id.clone()), headers(None), body.clone()).await;
        assert_eq!(r.status(), 401);
        assert!(r.headers().contains_key(WWW_AUTHENTICATE));

        let r = handle_mcp_post(Path(share.id.clone()), headers(Some("wrong")), body.clone()).await;
        assert_eq!(r.status(), 401);

        let r = handle_mcp_post(Path(share.id.clone()), headers(Some(&share.token)), body).await;
        assert_eq!(r.status(), 200);
        assert_eq!(body_json(r).await["result"], serde_json::json!({}));
    }

    #[tokio::test]
    async fn rejects_batches_and_garbage_with_jsonrpc_errors() {
        let share = create_share();
        let r = handle_mcp_post(Path(share.id.clone()), headers(Some(&share.token)), Bytes::from_static(b"[]")).await;
        assert_eq!(r.status(), 200);
        assert_eq!(body_json(r).await["error"]["code"], mcp::INVALID_REQUEST);

        let r = handle_mcp_post(Path(share.id.clone()), headers(Some(&share.token)), Bytes::from_static(b"{nope")).await;
        assert_eq!(body_json(r).await["error"]["code"], mcp::PARSE_ERROR);

        let r = handle_mcp_post(
            Path(share.id.clone()),
            headers(Some(&share.token)),
            Bytes::from_static(b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}"),
        )
        .await;
        assert_eq!(r.status(), 202);
    }

    #[tokio::test]
    async fn refuses_browser_origins_and_foreign_hosts() {
        let app = router();
        use tower::ServiceExt;

        let request = Request::builder()
            .method("POST")
            .uri("/mcp/x")
            .header(ORIGIN, "http://evil.test")
            .body(Body::empty())
            .unwrap();
        assert_eq!(app.clone().oneshot(request).await.unwrap().status(), 403);

        let request = Request::builder()
            .method("POST")
            .uri("/mcp/x")
            .header(ORIGIN, "http://localhost:3000")
            .body(Body::empty())
            .unwrap();
        // Loopback origin passes the middleware; the unknown share yields 404.
        assert_eq!(app.clone().oneshot(request).await.unwrap().status(), 404);

        let request = Request::builder()
            .method("POST")
            .uri("/mcp/x")
            .header(HOST, "evil.test:45822")
            .body(Body::empty())
            .unwrap();
        assert_eq!(app.clone().oneshot(request).await.unwrap().status(), 403);

        let request = Request::builder().method("GET").uri("/mcp/x").body(Body::empty()).unwrap();
        assert_eq!(app.oneshot(request).await.unwrap().status(), 405);
    }
}
