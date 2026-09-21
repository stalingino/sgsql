//! In-memory registry of active shares. Shares are session-only: they exist
//! while the sidecar runs and are removed when their connection closes.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock, Mutex};

use chrono::Utc;
use uuid::Uuid;

use super::types::{AllowedTable, CreateShareRequest, DbType, Share, TableKey};
use crate::error::SidecarError;
use crate::types::ConnectionProfile;

const MAX_TABLES: usize = 500;
const MAX_ROWS_LIMIT: usize = 10_000;
const MIN_TIMEOUT_MS: u64 = 1_000;
const MAX_TIMEOUT_MS: u64 = 120_000;

static SHARES: LazyLock<Mutex<HashMap<String, Arc<Share>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn new_token() -> String {
    // 256 bits of OS randomness; uuid v4 is already a dependency and `rand` is not.
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

fn new_id() -> String {
    Uuid::new_v4().simple().to_string()[..12].to_string()
}

fn validate_name(value: &str, what: &str) -> Result<(), SidecarError> {
    if value.is_empty() {
        return Err(SidecarError::msg(format!("{what} must not be empty")));
    }
    if value.chars().any(|c| c.is_control()) {
        return Err(SidecarError::msg(format!("{what} contains invalid characters")));
    }
    Ok(())
}

/// Validate the request, build the share and register it. The dedicated
/// database connection is opened later by the caller.
pub fn create(req: CreateShareRequest, profile: &ConnectionProfile) -> Result<Arc<Share>, SidecarError> {
    let db_type = DbType::parse(&profile.db_type)
        .ok_or_else(|| SidecarError::msg(format!("Unsupported connection type: {}", profile.db_type)))?;

    if req.tables.is_empty() {
        return Err(SidecarError::msg("Select at least one table to share"));
    }
    if req.tables.len() > MAX_TABLES {
        return Err(SidecarError::msg(format!("At most {MAX_TABLES} tables can be shared")));
    }
    if req.max_rows == 0 || req.max_rows > MAX_ROWS_LIMIT {
        return Err(SidecarError::msg(format!("maxRows must be between 1 and {MAX_ROWS_LIMIT}")));
    }
    if req.timeout_ms < MIN_TIMEOUT_MS || req.timeout_ms > MAX_TIMEOUT_MS {
        return Err(SidecarError::msg(format!(
            "timeoutMs must be between {MIN_TIMEOUT_MS} and {MAX_TIMEOUT_MS}"
        )));
    }

    let (database, default_schema) = match db_type {
        DbType::Postgres => (profile.database.clone(), "public".to_string()),
        DbType::MySql => {
            let db = req
                .db
                .clone()
                .filter(|d| !d.is_empty())
                .unwrap_or_else(|| profile.database.clone());
            if db.is_empty() {
                return Err(SidecarError::msg("A database must be selected to share a MySQL connection"));
            }
            (db.clone(), db)
        }
        DbType::Sqlite => (profile.database.clone(), "main".to_string()),
    };

    let mut allowed = HashSet::new();
    let mut tables: Vec<AllowedTable> = Vec::with_capacity(req.tables.len());
    for mut table in req.tables {
        validate_name(&table.name, "Table name")?;
        if table.schema.is_empty() {
            table.schema = default_schema.clone();
        } else {
            validate_name(&table.schema, "Schema name")?;
        }
        let key = TableKey::new(&table.schema, &table.name);
        if allowed.insert(key) {
            tables.push(table);
        }
    }

    let share = Arc::new(Share {
        id: new_id(),
        token: new_token(),
        connection_id: req.connection_id,
        connection_name: profile.name.clone(),
        db_type,
        database,
        default_schema,
        allowed,
        tables,
        read_only: req.read_only,
        max_rows: req.max_rows,
        timeout_ms: req.timeout_ms,
        created_at: Utc::now(),
        conn: tokio::sync::Mutex::new(None),
        stats: Default::default(),
    });
    SHARES.lock().unwrap().insert(share.id.clone(), Arc::clone(&share));
    Ok(share)
}

pub fn get(id: &str) -> Option<Arc<Share>> {
    SHARES.lock().unwrap().get(id).cloned()
}

pub fn list(connection_id: Option<&str>) -> Vec<Arc<Share>> {
    let mut shares: Vec<Arc<Share>> = SHARES
        .lock()
        .unwrap()
        .values()
        .filter(|s| connection_id.is_none_or(|id| s.connection_id == id))
        .cloned()
        .collect();
    shares.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    shares
}

/// Unregister a share and close its dedicated connection.
pub async fn remove(id: &str) -> Option<Arc<Share>> {
    let share = SHARES.lock().unwrap().remove(id)?;
    super::exec::close(&share).await;
    Some(share)
}

/// Teardown hook for `/connections/close`: drop every share bound to the connection.
pub async fn remove_for_connection(connection_id: &str) -> usize {
    let ids: Vec<String> = list(Some(connection_id)).iter().map(|s| s.id.clone()).collect();
    for id in &ids {
        remove(id).await;
    }
    ids.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_64_hex_chars_and_unique() {
        let a = new_token();
        let b = new_token();
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }
}
