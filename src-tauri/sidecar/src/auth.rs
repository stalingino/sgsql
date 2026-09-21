use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::header::{AUTHORIZATION, ORIGIN, SEC_WEBSOCKET_PROTOCOL};
use axum::http::HeaderMap;
use axum::middleware::Next;
use axum::response::Response;
use subtle::ConstantTimeEq;

use crate::routes;

const WEBSOCKET_AUTH_PREFIX: &str = "sgsql-auth.";
const ALLOWED_ORIGINS: [&str; 3] = [
    "tauri://localhost",
    "http://tauri.localhost",
    "http://localhost:5173",
];

#[derive(Clone)]
pub struct AuthState {
    token: Arc<str>,
}

impl AuthState {
    pub fn new(token: String) -> Self {
        Self {
            token: token.into(),
        }
    }
}

pub fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}

fn websocket_token(request: &Request) -> Option<&str> {
    request
        .headers()
        .get(SEC_WEBSOCKET_PROTOCOL)?
        .to_str()
        .ok()?
        .split(',')
        .map(str::trim)
        .find_map(|protocol| protocol.strip_prefix(WEBSOCKET_AUTH_PREFIX))
}

pub fn token_matches(candidate: Option<&str>, expected: &str) -> bool {
    candidate
        .filter(|value| value.len() == expected.len())
        .is_some_and(|value| value.as_bytes().ct_eq(expected.as_bytes()).into())
}

fn origin_allowed(request: &Request) -> bool {
    request
        .headers()
        .get(ORIGIN)
        .and_then(|value| value.to_str().ok())
        .is_none_or(|origin| ALLOWED_ORIGINS.contains(&origin))
}

pub async fn require_auth(State(auth): State<AuthState>, request: Request, next: Next) -> Response {
    if !origin_allowed(&request) {
        return routes::error_response("origin not allowed", 403);
    }

    let authorized = token_matches(bearer_token(request.headers()), &auth.token)
        || token_matches(websocket_token(&request), &auth.token);
    if !authorized {
        return routes::error_response("unauthorized", 401);
    }

    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef";

    fn request() -> Request {
        Request::builder()
            .uri("/health")
            .body(Body::empty())
            .unwrap()
    }

    #[test]
    fn accepts_the_bearer_token() {
        let request = Request::builder()
            .uri("/health")
            .header(AUTHORIZATION, format!("Bearer {TOKEN}"))
            .body(Body::empty())
            .unwrap();

        assert!(token_matches(bearer_token(request.headers()), TOKEN));
    }

    #[test]
    fn accepts_the_websocket_protocol_token() {
        let request = Request::builder()
            .uri("/query-log")
            .header(
                SEC_WEBSOCKET_PROTOCOL,
                format!("sgsql, {WEBSOCKET_AUTH_PREFIX}{TOKEN}"),
            )
            .body(Body::empty())
            .unwrap();

        assert!(token_matches(websocket_token(&request), TOKEN));
    }

    #[test]
    fn rejects_missing_or_partial_tokens() {
        assert!(!token_matches(bearer_token(request().headers()), TOKEN));
        assert!(!token_matches(Some(&TOKEN[..TOKEN.len() - 1]), TOKEN));
    }

    #[test]
    fn limits_browser_origins_to_tauri_and_vite() {
        let allowed = Request::builder()
            .uri("/health")
            .header(ORIGIN, "tauri://localhost")
            .body(Body::empty())
            .unwrap();
        let denied = Request::builder()
            .uri("/health")
            .header(ORIGIN, "https://example.com")
            .body(Body::empty())
            .unwrap();

        assert!(origin_allowed(&allowed));
        assert!(!origin_allowed(&denied));
        assert!(origin_allowed(&request()));
    }
}
