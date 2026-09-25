//! Minimal MCP (Model Context Protocol) server over JSON-RPC 2.0: a
//! stateless, tools-only implementation that agents reach through the
//! Streamable HTTP transport in `server.rs`.

use std::future::Future;
use std::sync::atomic::Ordering;

use serde::Deserialize;
use serde_json::{json, Value};

use super::exec::{QueryResult, ToolError, MAX_BATCH_STATEMENTS};
use super::types::{AllowedTable, DbType, Share};

pub const SERVER_PROTOCOL_VERSION: &str = "2025-03-26";
const SUPPORTED_PROTOCOL_VERSIONS: [&str; 3] = ["2024-11-05", "2025-03-26", "2025-06-18"];

pub const PARSE_ERROR: i64 = -32700;
pub const INVALID_REQUEST: i64 = -32600;
pub const METHOD_NOT_FOUND: i64 = -32601;
pub const INVALID_PARAMS: i64 = -32602;

const DEFAULT_TABLE_LIMIT: usize = 500;
const MAX_TABLE_LIMIT: usize = 5_000;
const MIN_VALUE_LENGTH: usize = 20;

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
    fn list_databases(&self) -> impl Future<Output = Result<Vec<String>, ToolError>> + Send;
    fn list_tables(&self, database: Option<&str>) -> impl Future<Output = Result<Vec<AllowedTable>, ToolError>> + Send;
    fn describe_table(&self, table: &str) -> impl Future<Output = Result<Value, ToolError>> + Send;
    fn table_ddl(&self, table: &str) -> impl Future<Output = Result<String, ToolError>> + Send;
    fn query(&self, sql: &str) -> impl Future<Output = Result<QueryResult, ToolError>> + Send;
    fn transaction(&self, statements: &[String]) -> impl Future<Output = Result<Vec<QueryResult>, ToolError>> + Send;
}

pub struct LiveBackend<'a>(pub &'a Share);

impl ToolBackend for LiveBackend<'_> {
    async fn list_databases(&self) -> Result<Vec<String>, ToolError> {
        super::exec::list_databases(self.0).await
    }

    async fn list_tables(&self, database: Option<&str>) -> Result<Vec<AllowedTable>, ToolError> {
        super::exec::list_tables(self.0, database).await
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

    async fn transaction(&self, statements: &[String]) -> Result<Vec<QueryResult>, ToolError> {
        super::exec::run_batch(self.0, statements).await
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
                "description": "Table name, optionally schema- or database-qualified (e.g. \"orders\" or \"sales.invoices\")."
            }
        },
        "required": ["table"],
        "additionalProperties": false
    })
}

fn max_value_length_schema() -> Value {
    json!({
        "type": "integer",
        "minimum": MIN_VALUE_LENGTH,
        "description": "Cut text values longer than this many characters and mark them as truncated. Use it when reading wide text/HTML/JSON columns you do not need in full; omit it to get values unchanged (required before writing a value back)."
    })
}

fn timeout_seconds(share: &Share) -> String {
    let seconds = share.timeout_ms as f64 / 1000.0;
    format!("{seconds}s")
}

fn write_results(share: &Share) -> &'static str {
    match share.db_type {
        DbType::MySql => "Writes return affectedRows; an INSERT into a table with an AUTO_INCREMENT key also returns lastInsertId (the first generated id of a multi-row INSERT).",
        DbType::Sqlite => "Writes return affectedRows; an INSERT also returns lastInsertId (the rowid). RETURNING clauses return rows.",
        DbType::Postgres => "Writes return affectedRows; add RETURNING (e.g. RETURNING id) to get generated keys or changed rows back.",
    }
}

pub fn tool_definitions(share: &Share) -> Vec<Value> {
    let query_mode = if share.read_only {
        "This share is read-only: only SELECT / WITH / VALUES / EXPLAIN queries are allowed."
    } else if share.all_databases {
        "SELECT, INSERT, UPDATE and DELETE are allowed in databases accessible to this MySQL connection; DDL and other statements are rejected."
    } else if share.full_database {
        "SELECT, INSERT, UPDATE and DELETE are allowed in the shared database; DDL and other statements are rejected."
    } else {
        "SELECT, INSERT, UPDATE and DELETE are allowed on the shared tables only; DDL and other statements are rejected."
    };
    let scope = if share.all_databases {
        "Any table in a database accessible to this MySQL connection may be referenced; qualify tables outside the default database as database.table."
    } else if share.full_database {
        "Any table in the current database may be referenced."
    } else {
        "Only the shared tables may be referenced."
    };
    let metadata = if share.db_type == DbType::MySql {
        " SHOW COLUMNS FROM t, SHOW CREATE TABLE t and DESCRIBE t also work; information_schema is not available."
    } else {
        ""
    };
    let mut tools = vec![];
    if share.all_databases {
        tools.push(json!({
            "name": "list_databases",
            "description": "List MySQL databases visible to this connection on demand. Database permissions still apply.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        }));
    }
    let mut list_properties = json!({
        "pattern": {
            "type": "string",
            "description": "Case-insensitive name filter in SQL LIKE syntax (% = any run of characters, _ = any one character), e.g. \"fe_%\". Without a %, matches names containing the text."
        },
        "limit": {
            "type": "integer",
            "minimum": 1,
            "maximum": MAX_TABLE_LIMIT,
            "description": format!("Most names to return (default {DEFAULT_TABLE_LIMIT}).")
        }
    });
    if share.all_databases {
        list_properties["database"] = json!({ "type": "string", "description": "MySQL database to list; defaults to the connection's current database." });
    }
    let list_scope = if share.all_databases {
        "List table and view names in one MySQL database (omit database for the connection's default database)."
    } else if share.full_database {
        "List table and view names in the shared database."
    } else {
        "List the tables shared with this agent. Only these tables can be queried."
    };
    tools.extend([
        json!({
            "name": "list_tables",
            "description": format!(
                "{list_scope} Returns names only, grouped into tables and views; filter with pattern on large databases. Use describe_table for columns."
            ),
            "inputSchema": { "type": "object", "properties": list_properties, "additionalProperties": false }
        }),
        json!({
            "name": "describe_table",
            "description": "Columns (name, type, nullable, default, comment), primary key, foreign keys and indexes of an accessible table. Call this before writing queries against an unfamiliar table.",
            "inputSchema": table_arg_schema()
        }),
        json!({
            "name": "get_table_ddl",
            "description": "The CREATE statement of an accessible table.",
            "inputSchema": table_arg_schema()
        }),
        json!({
            "name": "query",
            "description": format!(
                "Run exactly one SQL statement ({}). {} Results are capped at {} rows; use LIMIT and WHERE to stay under the cap. Each statement is cancelled after {}; use EXPLAIN to check the plan of a slow query. {}{} {}",
                share.db_type.as_str(),
                query_mode,
                share.max_rows,
                timeout_seconds(share),
                if share.read_only { "" } else { write_results(share) },
                if share.read_only { String::new() } else { " For changes that span several statements, use transaction instead.".to_string() },
                format!("{scope}{metadata}")
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "sql": { "type": "string", "description": "One SQL statement." },
                    "maxValueLength": max_value_length_schema()
                },
                "required": ["sql"],
                "additionalProperties": false
            }
        }),
    ]);
    if !share.read_only {
        let chain_ids = match share.db_type {
            DbType::MySql => "Later statements can use LAST_INSERT_ID() to reference the key generated by the previous INSERT.",
            DbType::Sqlite => "Later statements can use last_insert_rowid() to reference the row inserted by the previous INSERT.",
            DbType::Postgres => "Use a data-modifying CTE (WITH new_row AS (INSERT ... RETURNING id) ...) to reuse generated keys within one statement.",
        };
        tools.push(json!({
            "name": "transaction",
            "description": format!(
                "Run up to {MAX_BATCH_STATEMENTS} SQL statements in order inside one database transaction: either all of them are committed or, if any statement is rejected or fails, none are. Every statement is checked before anything runs, and follows the same rules as query. Use this for any change that touches more than one row set or table (e.g. renaming something referenced from several tables) so the database is never left half-changed. Returns one result per statement (affectedRows, lastInsertId, or rows for SELECTs). {chain_ids} Each statement is cancelled after {}.",
                timeout_seconds(share)
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "statements": {
                        "type": "array",
                        "items": { "type": "string" },
                        "minItems": 1,
                        "maxItems": MAX_BATCH_STATEMENTS,
                        "description": "SQL statements, one per item, run in this order."
                    },
                    "maxValueLength": max_value_length_schema()
                },
                "required": ["statements"],
                "additionalProperties": false
            }
        }));
    }
    tools
}

fn instructions(share: &Share) -> String {
    let limits = format!(
        "Results are capped at {} rows and each statement is cancelled after {}.{}",
        share.max_rows,
        timeout_seconds(share),
        if share.read_only { "" } else { " Use the transaction tool for multi-statement changes so they apply all-or-nothing." }
    );
    if share.all_databases {
        return format!(
            "SGSql shares all MySQL databases visible to this connection ({}) with you. The default database is \"{}\"; qualify tables in other databases as database.table. Database account permissions still apply. {} {} Use list_databases and list_tables (with a pattern) only when discovery is needed; describe_table and get_table_ddl accept qualified table names directly.",
            share.connection_name,
            share.database,
            if share.read_only { "Access is read-only." } else { "Reads and writes (INSERT/UPDATE/DELETE) are allowed." },
            limits,
        );
    }
    if share.full_database {
        return format!(
            "SGSql shares the {} database \"{}\" ({}) with you. All tables in this database are accessible, including tables added later. {} {} Use list_tables (with a pattern) only when you need to discover table names; describe_table and get_table_ddl accept a table name directly.",
            share.db_type.as_str(),
            share.database,
            share.connection_name,
            if share.read_only { "Access is read-only." } else { "Reads and writes (INSERT/UPDATE/DELETE) are allowed." },
            limits,
        );
    }
    format!(
        "SGSql shares the {} database \"{}\" ({}) with you. Shared tables: {}. {} {} Use list_tables and describe_table to explore, then query.",
        share.db_type.as_str(),
        share.database,
        share.connection_name,
        share.table_list(),
        if share.read_only {
            "Access is read-only."
        } else {
            "Reads and writes (INSERT/UPDATE/DELETE) are allowed on the shared tables."
        },
        limits,
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

fn usize_arg(params: &Value, name: &str) -> Result<Option<usize>, String> {
    match params.get("arguments").and_then(|args| args.get(name)) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_u64()
            .filter(|n| *n > 0)
            .map(|n| Some(n as usize))
            .ok_or_else(|| format!("Argument {name} must be a positive integer")),
    }
}

fn max_value_length_arg(params: &Value) -> Result<Option<usize>, String> {
    Ok(usize_arg(params, "maxValueLength")?.map(|n| n.max(MIN_VALUE_LENGTH)))
}

/// Case-insensitive SQL LIKE match (`%` and `_`); a pattern without `%`
/// matches names that contain it.
fn like_match(pattern: &str, name: &str) -> bool {
    let pattern: Vec<char> = if pattern.contains('%') {
        pattern.to_lowercase().chars().collect()
    } else {
        format!("%{}%", pattern.to_lowercase()).chars().collect()
    };
    let name: Vec<char> = name.to_lowercase().chars().collect();
    let (mut p, mut n) = (0, 0);
    let mut backtrack: Option<(usize, usize)> = None;
    while n < name.len() {
        if p < pattern.len() && (pattern[p] == '_' || pattern[p] == name[n]) {
            p += 1;
            n += 1;
        } else if p < pattern.len() && pattern[p] == '%' {
            backtrack = Some((p, n));
            p += 1;
        } else if let Some((star, matched)) = backtrack {
            p = star + 1;
            n = matched + 1;
            backtrack = Some((star, matched + 1));
        } else {
            return false;
        }
    }
    pattern[p..].iter().all(|c| *c == '%')
}

/// Names-only table listing, qualified only outside the listed database/schema.
fn table_listing(share: &Share, tables: Vec<AllowedTable>, database: Option<&str>, pattern: Option<&str>, limit: usize) -> Value {
    let home = database.unwrap_or(&share.default_schema);
    let total = tables.len();
    let matched: Vec<AllowedTable> = tables.into_iter().filter(|t| pattern.is_none_or(|p| like_match(p, &t.name))).collect();
    let mut names = Vec::new();
    let mut views = Vec::new();
    for table in matched.iter().take(limit) {
        let name = if table.schema.is_empty() || table.schema.eq_ignore_ascii_case(home) {
            table.name.clone()
        } else {
            format!("{}.{}", table.schema, table.name)
        };
        if table.kind == "view" { views.push(name) } else { names.push(name) }
    }
    let mut listing = json!({ "tables": names });
    if !views.is_empty() {
        listing["views"] = json!(views);
    }
    if share.db_type == DbType::MySql {
        listing["database"] = json!(matched.first().map_or(home, |t| t.schema.as_str()));
    }
    if pattern.is_some() {
        listing["matched"] = json!(matched.len());
    }
    listing["total"] = json!(total);
    if matched.len() > limit {
        listing["truncated"] = json!(true);
        listing["hint"] = json!(format!("Only the first {limit} names are shown; narrow with pattern or raise limit."));
    }
    listing
}

/// Cut long text values; returns how many were shortened.
fn shorten_values(result: &mut QueryResult, max_len: usize) -> usize {
    let mut shortened = 0;
    for value in result.rows.iter_mut().flatten() {
        if let Value::String(text) = value {
            let length = text.chars().count();
            if length > max_len {
                let kept: String = text.chars().take(max_len).collect();
                *text = format!("{kept}…[truncated, {length} chars]");
                shortened += 1;
            }
        }
    }
    shortened
}

fn result_json(share: &Share, mut result: QueryResult, max_value_length: Option<usize>) -> Value {
    let shortened = max_value_length.map_or(0, |max_len| shorten_values(&mut result, max_len));
    let mut value = result.to_json(share.max_rows);
    if shortened > 0 {
        value["shortenedValues"] = json!(shortened);
    }
    value
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

    let max_value_length = match max_value_length_arg(params) {
        Ok(value) => value,
        Err(message) => return rpc_error(id, INVALID_PARAMS, &message),
    };
    let result: Result<Value, ToolError> = match name {
        "list_databases" if share.all_databases => backend.list_databases().await.map(|databases| json!({ "databases": databases })),
        "list_tables" => {
            let limit = match usize_arg(params, "limit") {
                Ok(limit) => limit.unwrap_or(DEFAULT_TABLE_LIMIT).min(MAX_TABLE_LIMIT),
                Err(message) => return rpc_error(id, INVALID_PARAMS, &message),
            };
            let database = string_arg(params, "database");
            backend
                .list_tables(database)
                .await
                .map(|tables| table_listing(share, tables, database, string_arg(params, "pattern"), limit))
        }
        "describe_table" => match string_arg(params, "table") {
            Some(table) => backend.describe_table(table).await,
            None => return rpc_error(id, INVALID_PARAMS, "Missing required argument: table"),
        },
        "get_table_ddl" => match string_arg(params, "table") {
            Some(table) => backend.table_ddl(table).await.map(|ddl| json!({ "ddl": ddl })),
            None => return rpc_error(id, INVALID_PARAMS, "Missing required argument: table"),
        },
        "query" => match string_arg(params, "sql") {
            Some(sql) => backend.query(sql).await.map(|result| result_json(share, result, max_value_length)),
            None => return rpc_error(id, INVALID_PARAMS, "Missing required argument: sql"),
        },
        "transaction" if !share.read_only => {
            let statements: Option<Vec<String>> = params
                .get("arguments")
                .and_then(|args| args.get("statements"))
                .and_then(Value::as_array)
                .and_then(|items| items.iter().map(|item| item.as_str().map(|sql| sql.trim().to_string())).collect());
            match statements {
                Some(statements) => backend.transaction(&statements).await.map(|results| {
                    let results: Vec<Value> = results.into_iter().map(|result| result_json(share, result, max_value_length)).collect();
                    json!({ "committed": true, "statements": results.len(), "results": results })
                }),
                None => return rpc_error(id, INVALID_PARAMS, "Argument statements must be an array of SQL strings"),
            }
        }
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

    pub(super) fn share(read_only: bool) -> Share {
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
            full_database: false,
            all_databases: false,
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
        list_calls: Mutex<Vec<Option<String>>>,
        fail_with: Option<fn() -> ToolError>,
    }

    impl ToolBackend for FakeBackend {
        async fn list_databases(&self) -> Result<Vec<String>, ToolError> {
            Ok(vec!["app".into(), "other".into()])
        }

        async fn list_tables(&self, database: Option<&str>) -> Result<Vec<AllowedTable>, ToolError> {
            self.list_calls.lock().unwrap().push(database.map(str::to_string));
            Ok(vec![AllowedTable { schema: "public".into(), name: "users".into(), kind: "table".into() }])
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
                columns: vec!["id".into(), "body".into()],
                rows: vec![vec![json!(1), json!("x".repeat(100))]],
                truncated: false,
                affected_rows: None,
                last_insert_id: None,
                duration_ms: 1.5,
            })
        }

        async fn transaction(&self, statements: &[String]) -> Result<Vec<QueryResult>, ToolError> {
            self.queries.lock().unwrap().extend(statements.iter().cloned());
            Ok(statements
                .iter()
                .map(|_| QueryResult {
                    columns: vec![],
                    rows: vec![],
                    truncated: false,
                    affected_rows: Some(1),
                    last_insert_id: Some(585),
                    duration_ms: 1.0,
                })
                .collect())
        }
    }

    fn text(v: &Value) -> Value {
        serde_json::from_str(v["result"]["content"][0]["text"].as_str().unwrap()).unwrap()
    }

    fn call(name: &str, arguments: Value) -> RpcRequest {
        request("tools/call", json!({ "name": name, "arguments": arguments }))
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

        assert!(query["description"].as_str().unwrap().contains("cancelled after 5s"));
        assert!(!tools.iter().any(|t| t["name"] == "transaction"));

        let v = response(&share(false), request("tools/list", Value::Null), &backend).await;
        let tools = v["result"]["tools"].as_array().unwrap();
        let query = tools.iter().find(|t| t["name"] == "query").unwrap();
        assert!(query["description"].as_str().unwrap().contains("INSERT, UPDATE and DELETE"));
        assert!(query["description"].as_str().unwrap().contains("RETURNING"));
        assert!(tools.iter().any(|t| t["name"] == "transaction"));
    }

    #[test]
    fn like_patterns() {
        assert!(like_match("fe_%", "fe_form"));
        assert!(like_match("FE_%", "fe_template"));
        assert!(!like_match("fe_%", "loan_fe"));
        assert!(like_match("form", "fe_form_query"));
        assert!(like_match("%_query", "fe_form_query"));
        assert!(!like_match("%_query", "fe_form"));
        assert!(like_match("f%m", "fe_form"));
        assert!(like_match("%", ""));
    }

    #[tokio::test]
    async fn list_tables_returns_filtered_names() {
        let share = share(true);
        let v = response(&share, call("list_tables", json!({ "pattern": "us%" })), &FakeBackend::default()).await;
        let listing = text(&v);
        assert_eq!(listing["tables"], json!(["users"]));
        assert_eq!(listing["matched"], 1);
        assert!(listing.get("truncated").is_none());

        let tables = vec![
            AllowedTable { schema: "app".into(), name: "a".into(), kind: "table".into() },
            AllowedTable { schema: "app".into(), name: "b".into(), kind: "view".into() },
            AllowedTable { schema: "app".into(), name: "c".into(), kind: "table".into() },
        ];
        let mut mysql = super::tests::share(true);
        mysql.db_type = DbType::MySql;
        mysql.default_schema = "app".into();
        let listing = table_listing(&mysql, tables, None, None, 2);
        assert_eq!(listing, json!({
            "tables": ["a"], "views": ["b"], "database": "app", "total": 3, "truncated": true,
            "hint": "Only the first 2 names are shown; narrow with pattern or raise limit."
        }));
    }

    #[tokio::test]
    async fn query_can_shorten_long_values() {
        let share = share(true);
        let backend = FakeBackend::default();
        let full = text(&response(&share, call("query", json!({ "sql": "SELECT 1" })), &backend).await);
        assert_eq!(full["rows"][0][1].as_str().unwrap().len(), 100);
        let short = text(&response(&share, call("query", json!({ "sql": "SELECT 1", "maxValueLength": 30 })), &backend).await);
        assert_eq!(short["rows"][0][1], format!("{}…[truncated, 100 chars]", "x".repeat(30)));
        assert_eq!(short["shortenedValues"], 1);
        let bad = response(&share, call("query", json!({ "sql": "SELECT 1", "maxValueLength": "big" })), &backend).await;
        assert_eq!(bad["error"]["code"], INVALID_PARAMS);
    }

    #[tokio::test]
    async fn transaction_tool_only_on_writable_shares() {
        let backend = FakeBackend::default();
        let statements = json!({ "statements": ["UPDATE users SET id = 1", "DELETE FROM orders"] });
        let hidden = response(&share(true), call("transaction", statements.clone()), &backend).await;
        assert_eq!(hidden["error"]["code"], INVALID_PARAMS);

        let v = response(&share(false), call("transaction", statements), &backend).await;
        let result = text(&v);
        assert_eq!(result["committed"], true);
        assert_eq!(result["statements"], 2);
        assert_eq!(result["results"][0], json!({ "affectedRows": 1, "lastInsertId": 585, "durationMs": 1.0 }));
        let bad = response(&share(false), call("transaction", json!({ "statements": "SELECT 1" })), &backend).await;
        assert_eq!(bad["error"]["code"], INVALID_PARAMS);
    }

    #[tokio::test]
    async fn full_database_does_not_embed_a_table_snapshot_in_instructions() {
        let mut share = share(true);
        share.full_database = true;
        share.tables.clear();
        share.allowed.clear();
        let backend = FakeBackend::default();
        let initialized = response(&share, request("initialize", Value::Null), &backend).await;
        let instructions = initialized["result"]["instructions"].as_str().unwrap();
        assert!(instructions.contains("All tables in this database"));
        assert!(!instructions.contains("users, orders"));
        let listed = response(&share, request("tools/list", Value::Null), &backend).await;
        let query = listed["result"]["tools"].as_array().unwrap().iter().find(|tool| tool["name"] == "query").unwrap();
        assert!(query["description"].as_str().unwrap().contains("current database"));
    }

    #[tokio::test]
    async fn all_databases_advertises_discovery_without_a_table_snapshot() {
        let mut instance_share = share(true);
        instance_share.db_type = DbType::MySql;
        instance_share.database = "app".into();
        instance_share.default_schema = "app".into();
        instance_share.all_databases = true;
        instance_share.tables.clear();
        instance_share.allowed.clear();
        let backend = FakeBackend::default();
        let initialized = response(&instance_share, request("initialize", Value::Null), &backend).await;
        let instructions = initialized["result"]["instructions"].as_str().unwrap();
        assert!(instructions.contains("database.table"));
        assert!(!instructions.contains("users, orders"));
        let listed = response(&instance_share, request("tools/list", Value::Null), &backend).await;
        let tools = listed["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 5);
        assert!(tools.iter().any(|tool| tool["name"] == "list_databases"));
        let found = response(&instance_share, request("tools/call", json!({ "name": "list_databases" })), &backend).await;
        assert!(found["result"]["content"][0]["text"].as_str().unwrap().contains("other"));
        let listed = response(&instance_share, request("tools/call", json!({ "name": "list_tables", "arguments": { "database": "other" } })), &backend).await;
        assert!(listed["result"].get("isError").is_none());
        assert_eq!(backend.list_calls.lock().unwrap().as_slice(), [Some("other".to_string())]);
        let normal = share(true);
        let hidden = response(&normal, request("tools/call", json!({ "name": "list_databases" })), &backend).await;
        assert_eq!(hidden["error"]["code"], INVALID_PARAMS);
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
        assert_eq!(parsed["columns"], json!(["id", "body"]));
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
