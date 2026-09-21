use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::exec::ShareConn;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DbType {
    Postgres,
    MySql,
    Sqlite,
}

impl DbType {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "postgres" => Some(DbType::Postgres),
            "mysql" => Some(DbType::MySql),
            "sqlite" => Some(DbType::Sqlite),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            DbType::Postgres => "postgres",
            DbType::MySql => "mysql",
            DbType::Sqlite => "sqlite",
        }
    }
}

/// Normalized (lowercased) identity of a table for allowlist matching.
/// `schema` is the Postgres schema, the MySQL database, or `main` for SQLite.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct TableKey {
    pub schema: String,
    pub name: String,
}

impl TableKey {
    pub fn new(schema: &str, name: &str) -> Self {
        Self {
            schema: schema.to_lowercase(),
            name: name.to_lowercase(),
        }
    }
}

/// A shared table as the user picked it (original case) and as shown to the agent.
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct AllowedTable {
    #[serde(default)]
    pub schema: String,
    pub name: String,
    #[serde(rename = "type", default = "default_kind")]
    pub kind: String,
}

fn default_kind() -> String {
    "table".to_string()
}

#[derive(Default)]
pub struct ShareStats {
    pub calls: AtomicU64,
    pub rejected: AtomicU64,
    pub errors: AtomicU64,
    pub last_used_at: Mutex<Option<DateTime<Utc>>>,
}

impl ShareStats {
    pub fn touch(&self) {
        self.calls.fetch_add(1, Ordering::Relaxed);
        *self.last_used_at.lock().unwrap() = Some(Utc::now());
    }

    fn to_json(&self) -> Value {
        json!({
            "calls": self.calls.load(Ordering::Relaxed),
            "rejected": self.rejected.load(Ordering::Relaxed),
            "errors": self.errors.load(Ordering::Relaxed),
            "lastUsedAt": self.last_used_at.lock().unwrap().map(|t| t.to_rfc3339()),
        })
    }
}

pub struct Share {
    pub id: String,
    pub token: String,
    pub connection_id: String,
    pub connection_name: String,
    pub db_type: DbType,
    /// MySQL: database to `USE` and default qualifier. Postgres: the profile
    /// database (only used to validate 3-part names). SQLite: the file path.
    pub database: String,
    /// Postgres `public`, MySQL = `database`, SQLite `main`.
    pub default_schema: String,
    pub allowed: HashSet<TableKey>,
    pub tables: Vec<AllowedTable>,
    pub read_only: bool,
    pub max_rows: usize,
    pub timeout_ms: u64,
    pub created_at: DateTime<Utc>,
    /// Dedicated database connection, opened lazily and dropped on errors.
    pub conn: tokio::sync::Mutex<Option<ShareConn>>,
    pub stats: ShareStats,
}

impl Share {
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}/mcp/{}", super::server::mcp_port(), self.id)
    }

    pub fn info(&self, include_token: bool) -> Value {
        let mut value = json!({
            "id": self.id,
            "connectionId": self.connection_id,
            "connectionName": self.connection_name,
            "db": self.database,
            "url": self.url(),
            "readOnly": self.read_only,
            "maxRows": self.max_rows,
            "timeoutMs": self.timeout_ms,
            "tables": self.tables,
            "createdAt": self.created_at.to_rfc3339(),
            "stats": self.stats.to_json(),
        });
        if include_token {
            value["token"] = Value::from(self.token.clone());
        }
        value
    }

    /// Human-readable list of shared tables for error messages and the
    /// server instructions, e.g. `users, orders, sales.invoices`.
    pub fn table_list(&self) -> String {
        self.tables
            .iter()
            .map(|t| {
                if t.schema.is_empty() || t.schema.eq_ignore_ascii_case(&self.default_schema) {
                    t.name.clone()
                } else {
                    format!("{}.{}", t.schema, t.name)
                }
            })
            .collect::<Vec<_>>()
            .join(", ")
    }
}

fn default_true() -> bool {
    true
}

pub const DEFAULT_MAX_ROWS: usize = 500;
pub const DEFAULT_TIMEOUT_MS: u64 = 15_000;

fn default_max_rows() -> usize {
    DEFAULT_MAX_ROWS
}

fn default_timeout_ms() -> u64 {
    DEFAULT_TIMEOUT_MS
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CreateShareRequest {
    pub connection_id: String,
    /// Active database (MySQL). Ignored for Postgres and SQLite.
    #[serde(default)]
    pub db: Option<String>,
    pub tables: Vec<AllowedTable>,
    #[serde(default = "default_true")]
    pub read_only: bool,
    #[serde(default = "default_max_rows")]
    pub max_rows: usize,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
}
