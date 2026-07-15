use std::collections::VecDeque;
use std::sync::{LazyLock, Mutex};
use std::time::Instant;

use serde::Serialize;
use tokio::sync::broadcast;

const MAX_ENTRIES: usize = 1_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryLogEntry {
    pub id: u64,
    pub connection_id: String,
    pub db: String,
    pub query: String,
    pub timestamp: String,
    pub duration: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub row_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cancelled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cancel_detail: Option<String>,
}

struct LogState {
    entries: VecDeque<QueryLogEntry>,
    next_id: u64,
}

static LOG: LazyLock<Mutex<LogState>> = LazyLock::new(|| {
    Mutex::new(LogState {
        entries: VecDeque::new(),
        next_id: 0,
    })
});

static BROADCAST: LazyLock<broadcast::Sender<String>> = LazyLock::new(|| broadcast::channel(256).0);

pub fn subscribe() -> broadcast::Receiver<String> {
    BROADCAST.subscribe()
}

pub fn snapshot_message() -> String {
    let state = LOG.lock().unwrap();
    let entries: Vec<&QueryLogEntry> = state.entries.iter().collect();
    serde_json::json!({ "type": "snapshot", "entries": entries }).to_string()
}

pub fn clear_log() {
    let mut state = LOG.lock().unwrap();
    state.entries.clear();
    drop(state);
    let _ = BROADCAST.send(serde_json::json!({ "type": "cleared" }).to_string());
}

fn iso_now() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

fn append(mut entry: QueryLogEntry) {
    let mut state = LOG.lock().unwrap();
    state.next_id += 1;
    entry.id = state.next_id;
    state.entries.push_back(entry.clone());
    while state.entries.len() > MAX_ENTRIES {
        state.entries.pop_front();
    }
    drop(state);
    let _ = BROADCAST.send(serde_json::json!({ "type": "entry", "entry": entry }).to_string());
}

/// Started marker for a traced statement; log exactly one outcome per trace.
pub struct Trace {
    connection_id: String,
    db: String,
    query: String,
    timestamp: String,
    started: Instant,
}

pub fn start(connection_id: &str, db: &str, query: &str) -> Trace {
    Trace {
        connection_id: connection_id.to_string(),
        db: db.to_string(),
        query: query.to_string(),
        timestamp: iso_now(),
        started: Instant::now(),
    }
}

impl Trace {
    fn base(self, row_count: Option<u64>, error: Option<String>) -> QueryLogEntry {
        let duration = self.started.elapsed().as_secs_f64() * 1_000.0;
        let (cancelled, cancel_detail) = match &error {
            Some(message) => {
                let lowered = message.to_lowercase();
                let is_cancel = ["cancelled", "canceled", "canceling statement", "aborted", "interrupted", "killed"]
                    .iter()
                    .any(|needle| lowered.contains(needle));
                if is_cancel {
                    (Some(true), Some(message.clone()))
                } else {
                    (None, None)
                }
            }
            None => (None, None),
        };
        QueryLogEntry {
            id: 0,
            connection_id: self.connection_id,
            db: self.db,
            query: self.query,
            timestamp: self.timestamp,
            duration,
            row_count,
            error,
            cancelled,
            cancel_detail,
        }
    }

    pub fn success(self, row_count: Option<u64>) {
        append(self.base(row_count, None));
    }

    pub fn failure(self, error: &str) {
        append(self.base(None, Some(error.to_string())));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancelled_errors_get_flagged() {
        let trace = start("c1", "db", "SELECT pg_sleep(10)");
        let entry = trace.base(None, Some("canceling statement due to user request".into()));
        assert_eq!(entry.cancelled, Some(true));
        assert!(entry.cancel_detail.is_some());
    }

    #[test]
    fn plain_errors_are_not_cancelled() {
        let trace = start("c1", "db", "SELECT 1");
        let entry = trace.base(None, Some("syntax error".into()));
        assert_eq!(entry.cancelled, None);
    }
}
