//! Minimal MCP (Model Context Protocol) server over JSON-RPC 2.0: a
//! stateless, tools-only implementation that agents reach through the
//! Streamable HTTP transport in `server.rs`.

use std::future::Future;
use std::sync::atomic::Ordering;

use serde::Deserialize;
use serde_json::{json, Value};

use super::exec::{QueryResult, ToolError};
use super::types::{AllowedTable, Share};

pub const SERVER_PROTOCOL_VERSION: &str = "2025-03-26";
const SUPPORTED_PROTOCOL_VERSIONS: [&str; 3] = ["2024-11-05", "2025-03-26", "2025-06-18"];

pub const PARSE_ERROR: i64 = -32700;
pub const INVALID_REQUEST: i64 = -32600;
pub const METHOD_NOT_FOUND: i64 = -32601;
pub const INVALID_PARAMS: i64 = -32602;

#[derive(Deserialize, Debug)]
pub struct RpcRequest {
    #[serde(default)]
    pub jsonrpc: Option<String>,
    #[serde(default)]
    pub id: Option<Value>,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

pub enum Outcome {
    /// A JSON-RPC response body (HTTP 200).
    Response(Value),
    /// A notification was accepted (HTTP 202, no body).
    Accepted,
}

/// What the dispatcher needs from the world; `LiveBackend` talks to the
/// database, tests use a fake.
pub trait ToolBackend: Send + Sync {
    fn list_tables(&self) -> Vec<AllowedTable>;
    fn describe_table(&self, table: &str) -> impl Future<Output = Result<Value, ToolError>> + Send;
    fn table_ddl(&self, table: &str) -> impl Future<Output = Result<String, ToolError>> + Send;
    fn query(&self, sql: &str) -> impl Future<Output = Result<QueryResult, ToolError>> + Send;
}

pub struct LiveBackend<'a>(pub &'a Share);

impl ToolBackend for LiveBackend<'_> {
    fn list_tables(&self) -> Vec<AllowedTable> {
        self.0.tables.clone()
    }

    async fn describe_table(&self, table: &str) -> Result<Value, ToolError> {
        super::exec::describe_table(self.0, table).await
    }

    async fn table_ddl(&self, table: &str) -> Result<String, ToolError> {
        super::exec::table_ddl(self.0, table).await
    }

    async fn query(&self, sql: &str) -> Result<QueryResult, ToolError> {
        super::exec::run(self.0, sql).await
    }
}

pub fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn rpc_result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

pub fn tool_result(text: String, is_error: bool) -> Value {
    let mut result = json!({ "content": [{ "type": "text", "text": text }] });
    if is_error {
        result["isError"] = Value::Bool(true);
    }
    result
}

fn table_arg_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "table": {
                "type": "string",
                "description": "Table name, optionally schema-qualified (e.g. \"orders\" or \"sales.invoices\")."
            }
        },
        "required": ["table"],
        "additionalProperties": false
    })
}

pub fn tool_definitions(share: &Share) -> Vec<Value> {
    let query_mode = if share.read_only {
        "This share is read-only: only SELECT / WITH / VALUES / EXPLAIN queries are allowed."
    } else {
        "SELECT, INSERT, UPDATE and DELETE are allowed on the shared tables only; DDL and other statements are rejected."
    };
    vec![
        json!({
            "name": "list_tables",
            "description": "List the tables shared with this agent (name, schema, type). Only these tables can be queried.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
        json!({
            "name": "describe_table",
            "description": "Columns, primary key, foreign keys (to other shared tables) and indexes of a shared table.",
            "inputSchema": table_arg_schema()
        }),
        json!({
            "name": "get_table_ddl",
            "description": "The CREATE statement of a shared table.",
            "inputSchema": table_arg_schema()
        }),
        json!({
            "name": "query",
            "description": format!(
                "Run exactly one SQL statement ({}) against the shared tables. {} Results are capped at {} rows; use LIMIT and WHERE to stay under the cap. Only the shared tables may be referenced.",
                share.db_type.as_str(), query_mode, share.max_rows
            ),
            "inputSchema": {
                "type": "object",
                "properties": { "sql": { "type": "string", "description": "One SQL statement." } },
                "required": ["sql"],
                "additionalProperties": false
            }
        }),
    ]
}

fn instructions(share: &Share) -> String {
    format!(
        "SGSql shares the {} database \"{}\" ({}) with you. Shared tables: {}. {} Results are capped at {} rows. Use list_tables and describe_table to explore, then query.",
        share.db_type.as_str(),
        share.database,
        share.connection_name,
        share.table_list(),
        if share.read_only {
            "Access is read-only."
        } else {
            "Reads and writes (INSERT/UPDATE/DELETE) are allowed on the shared tables."
        },
        share.max_rows,
    )
}

fn initialize(share: &Share, params: &Value) -> Value {
    let requested = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
    let version = if SUPPORTED_PROTOCOL_VERSIONS.contains(&requested) {
        requested
    } else {
        SERVER_PROTOCOL_VERSION
    };
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": {} },
        "serverInfo": {
            "name": "sgsql",
            "title": format!("SGSql – {}", share.connection_name),
            "version": env!("CARGO_PKG_VERSION"),
        },
        "instructions": instructions(share),
    })
}

fn string_arg<'a>(params: &'a Value, name: &str) -> Option<&'a str> {
    params
        .get("arguments")
        .and_then(|args| args.get(name))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn compact(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string())
}

fn record_outcome(share: &Share, result: &Result<Value, ToolError>) {
    if let Err(error) = result {
        if error.is_rejection() {
            share.stats.rejected.fetch_add(1, Ordering::Relaxed);
        } else {
            share.stats.errors.fetch_add(1, Ordering::Relaxed);
        }
    }
}

async fn call_tool<B: ToolBackend>(share: &Share, id: Value, params: &Value, backend: &B) -> Value {
    let Some(name) = params.get("name").and_then(Value::as_str) else {
        return rpc_error(id, INVALID_PARAMS, "Missing tool name");
    };
    share.stats.touch();

    let result: Result<Value, ToolError> = match name {
        "list_tables" => Ok(json!({ "tables": backend.list_tables() })),
        "describe_table" => match string_arg(params, "table") {
            Some(table) => backend.describe_table(table).await,
            None => return rpc_error(id, INVALID_PARAMS, "Missing required argument: table"),
        },
        "get_table_ddl" => match string_arg(params, "table") {
            Some(table) => backend.table_ddl(table).await.map(|ddl| json!({ "ddl": ddl })),
            None => return rpc_error(id, INVALID_PARAMS, "Missing required argument: table"),
        },
        "query" => match string_arg(params, "sql") {
            Some(sql) => backend.query(sql).await.map(|result| result.to_json(share.max_rows)),
            None => return rpc_error(id, INVALID_PARAMS, "Missing required argument: sql"),
        },
        other => return rpc_error(id, INVALID_PARAMS, &format!("Unknown tool: {other}")),
    };
    record_outcome(share, &result);

    match result {
        Ok(value) => rpc_result(id, tool_result(compact(&value), false)),
        Err(error) => rpc_result(id, tool_result(error.message(), true)),
    }
}

pub async fn dispatch<B: ToolBackend>(share: &Share, request: RpcRequest, backend: &B) -> Outcome {
    if request.method.starts_with("notifications/") {
        return Outcome::Accepted;
    }
    let Some(id) = request.id else {
        // A request without an id is a notification per JSON-RPC 2.0.
        return Outcome::Accepted;
    };
    if request.jsonrpc.as_deref().is_some_and(|version| version != "2.0") {
        return Outcome::Response(rpc_error(id, INVALID_REQUEST, "Unsupported JSON-RPC version"));
    }

    let response = match request.method.as_str() {
        "initialize" => rpc_result(id, initialize(share, &request.params)),
        "ping" => rpc_result(id, json!({})),
        "tools/list" => rpc_result(id, json!({ "tools": tool_definitions(share) })),
        "tools/call" => call_tool(share, id, &request.params, backend).await,
        other => rpc_error(id, METHOD_NOT_FOUND, &format!("Method not found: {other}")),
    };
    Outcome::Response(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::share::types::{DbType, TableKey};
    use chrono::Utc;
    use std::collections::HashSet;
    use std::sync::Mutex;

    fn share(read_only: bool) -> Share {
        let tables = vec![
            AllowedTable { schema: "public".into(), name: "users".into(), kind: "table".into() },
            AllowedTable { schema: "public".into(), name: "orders".into(), kind: "table".into() },
        ];
        let allowed: HashSet<TableKey> = tables.iter().map(|t| TableKey::new(&t.schema, &t.name)).collect();
        Share {
            id: "abc".into(),
            token: "tok".into(),
            connection_id: "c1".into(),
            connection_name: "Local PG".into(),
            db_type: DbType::Postgres,
            database: "app".into(),
            default_schema: "public".into(),
            allowed,
            tables,
            read_only,
            max_rows: 50,
            timeout_ms: 5_000,
            created_at: Utc::now(),
            conn: tokio::sync::Mutex::new(None),
            stats: Default::default(),
        }
    }

    #[derive(Default)]
    struct FakeBackend {
        queries: Mutex<Vec<String>>,
        fail_with: Option<fn() -> ToolError>,
    }

    impl ToolBackend for FakeBackend {
        fn list_tables(&self) -> Vec<AllowedTable> {
            vec![AllowedTable { schema: "public".into(), name: "users".into(), kind: "table".into() }]
        }

        async fn describe_table(&self, table: &str) -> Result<Value, ToolError> {
            Ok(json!({ "table": table, "columns": [] }))
        }

        async fn table_ddl(&self, table: &str) -> Result<String, ToolError> {
            Ok(format!("CREATE TABLE {table} ();"))
        }

        async fn query(&self, sql: &str) -> Result<QueryResult, ToolError> {
            self.queries.lock().unwrap().push(sql.to_string());
            if let Some(fail) = self.fail_with {
                return Err(fail());
            }
            Ok(QueryResult {
                columns: vec!["id".into()],
                rows: vec![vec![json!(1)]],
                truncated: false,
                affected_rows: None,
                duration_ms: 1.5,
            })
        }
    }

    fn request(method: &str, params: Value) -> RpcRequest {
        RpcRequest { jsonrpc: Some("2.0".into()), id: Some(json!(1)), method: method.into(), params }
    }

    async fn response(share: &Share, req: RpcRequest, backend: &FakeBackend) -> Value {
        match dispatch(share, req, backend).await {
            Outcome::Response(value) => value,
            Outcome::Accepted => panic!("expected a response"),
        }
    }

    #[tokio::test]
    async fn initialize_negotiates_protocol_version() {
        let share = share(true);
        let backend = FakeBackend::default();

        let v = response(&share, request("initialize", json!({ "protocolVersion": "2025-06-18" })), &backend).await;
        assert_eq!(v["result"]["protocolVersion"], "2025-06-18");
        assert!(v["result"]["capabilities"]["tools"].is_object());
        assert!(v["result"]["instructions"].as_str().unwrap().contains("users, orders"));

        let v = response(&share, request("initialize", json!({ "protocolVersion": "1999-01-01" })), &backend).await;
        assert_eq!(v["result"]["protocolVersion"], SERVER_PROTOCOL_VERSION);
    }

    #[tokio::test]
    async fn notifications_are_accepted_without_a_body() {
        let share = share(true);
        let req = RpcRequest { jsonrpc: None, id: None, method: "notifications/initialized".into(), params: Value::Null };
        assert!(matches!(dispatch(&share, req, &FakeBackend::default()).await, Outcome::Accepted));
    }

    #[tokio::test]
    async fn ping_and_unknown_methods() {
        let share = share(true);
        let backend = FakeBackend::default();
        assert_eq!(response(&share, request("ping", Value::Null), &backend).await["result"], json!({}));
        let v = response(&share, request("resources/list", Value::Null), &backend).await;
        assert_eq!(v["error"]["code"], METHOD_NOT_FOUND);
    }

    #[tokio::test]
    async fn tools_list_describes_the_mode() {
        let backend = FakeBackend::default();
        let v = response(&share(true), request("tools/list", Value::Null), &backend).await;
        let tools = v["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 4);
        let query = tools.iter().find(|t| t["name"] == "query").unwrap();
        assert!(query["description"].as_str().unwrap().contains("read-only"));

        let v = response(&share(false), request("tools/list", Value::Null), &backend).await;
        let query = v["result"]["tools"].as_array().unwrap().iter().find(|t| t["name"] == "query").unwrap();
        assert!(query["description"].as_str().unwrap().contains("INSERT, UPDATE and DELETE"));
    }

    #[tokio::test]
    async fn tools_call_query_returns_json_text() {
        let share = share(true);
        let backend = FakeBackend::default();
        let params = json!({ "name": "query", "arguments": { "sql": "SELECT 1" } });
        let v = response(&share, request("tools/call", params), &backend).await;
        assert!(v["result"].get("isError").is_none());
        let text = v["result"]["content"][0]["text"].as_str().unwrap();
        let parsed: Value = serde_json::from_str(text).unwrap();
        assert_eq!(parsed["columns"], json!(["id"]));
        assert_eq!(parsed["maxRows"], 50);
        assert_eq!(backend.queries.lock().unwrap().as_slice(), ["SELECT 1"]);
        assert_eq!(share.stats.calls.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn tool_errors_are_reported_as_is_error_results() {
        let share = share(true);
        let backend = FakeBackend { fail_with: Some(|| ToolError::Rejected("nope".into())), ..Default::default() };
        let params = json!({ "name": "query", "arguments": { "sql": "DELETE FROM users" } });
        let v = response(&share, request("tools/call", params), &backend).await;
        assert_eq!(v["result"]["isError"], true);
        assert_eq!(v["result"]["content"][0]["text"], "nope");
        assert_eq!(share.stats.rejected.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn protocol_level_argument_errors() {
        let share = share(true);
        let backend = FakeBackend::default();
        let v = response(&share, request("tools/call", json!({ "name": "nope" })), &backend).await;
        assert_eq!(v["error"]["code"], INVALID_PARAMS);
        let v = response(&share, request("tools/call", json!({ "name": "query", "arguments": {} })), &backend).await;
        assert_eq!(v["error"]["code"], INVALID_PARAMS);
        let v = response(&share, request("tools/call", json!({ "name": "describe_table", "arguments": { "table": "users" } })), &backend).await;
        assert!(v["result"]["content"][0]["text"].as_str().unwrap().contains("users"));
    }
}
