//! Oracle Database support through the pure-Rust `oracledb` thin driver.
//!
//! The driver is synchronous, so every call runs on tokio's blocking pool
//! while holding the session's async mutex. Holding that mutex pins the one
//! server session for batches and transactions, the same way the MySQL pool
//! keeps a single connection.

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use oracledb::{
    Config, Connection, JsonValue, OracleIntervalDS, OracleIntervalYM, OracleNumber, OracleTimestamp, Row, ToDbValue,
    Vector, VectorData,
};
use serde_json::Value;
use tokio::sync::{Mutex, OwnedMutexGuard};

use crate::db::QueryOutput;
use crate::error::SidecarError;
use crate::types::ConnectionProfile;
use crate::value;

/// Error reported for a statement whose session was killed by /cancel.
pub const CANCELLED: &str = "ORA-01013: user requested cancel of current operation";

// ---------------------------------------------------------------------------
// Connecting
// ---------------------------------------------------------------------------

/// EZConnect string for the profile. `database` holds the service name, or a
/// full `(DESCRIPTION=...)` connect descriptor for setups EZConnect can't
/// express (SIDs, failover lists).
pub fn connect_string(profile: &ConnectionProfile, host: &str, port: u16) -> String {
    let target = profile.database.trim();
    if target.starts_with('(') {
        return target.to_string();
    }
    let scheme = if profile.ssl { "tcps://" } else { "" };
    format!("{scheme}{host}:{port}/{target}")
}

/// ISO date formats for the session, matching how DATE and TIMESTAMP values
/// are sent to the app (see `timestamp`), so edited values and primary keys
/// convert back implicitly instead of failing against `DD-MON-RR`.
const SESSION_FORMATS: &str = "ALTER SESSION SET \
    NLS_DATE_FORMAT = 'YYYY-MM-DD HH24:MI:SS' \
    NLS_TIMESTAMP_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF' \
    NLS_TIMESTAMP_TZ_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF TZH:TZM'";

/// Open a connection on the current (blocking) thread.
pub fn connect_blocking(profile: &ConnectionProfile, host: &str, port: u16) -> Result<Connection, SidecarError> {
    let config = Config::default()
        .set_credentials(&profile.username, &profile.password)
        .set_program("SGSql")?
        .set_connect_string(&connect_string(profile, host, port))?;
    let conn = oracledb::connect(config)?;
    conn.execute(SESSION_FORMATS, &[])?;
    Ok(conn)
}

/// Open a connection without blocking the async runtime.
pub async fn connect(profile: &ConnectionProfile, host: &str, port: u16) -> Result<Connection, SidecarError> {
    let (profile, host) = (profile.clone(), host.to_string());
    tokio::task::spawn_blocking(move || connect_blocking(&profile, &host, port))
        .await
        .map_err(worker_failed)?
}

fn worker_failed(error: tokio::task::JoinError) -> SidecarError {
    SidecarError::msg(format!("Oracle worker failed: {error}"))
}

/// Run `f` against a locked connection on the blocking pool, handing the lock
/// back so the caller can keep the session pinned.
async fn on_blocking_pool<T, F>(
    guard: OwnedMutexGuard<Connection>,
    f: F,
) -> Result<(OwnedMutexGuard<Connection>, Result<T, oracledb::Error>), SidecarError>
where
    T: Send + 'static,
    F: FnOnce(&Connection) -> Result<T, oracledb::Error> + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        let result = f(&guard);
        (guard, result)
    })
    .await
    .map_err(worker_failed)
}

/// A killed session fails its running call with ORA-00028, which would look
/// like a dropped connection and be retried. Report it as the cancellation it
/// was instead.
fn outcome<T>(killed: &AtomicBool, result: Result<T, oracledb::Error>) -> Result<T, SidecarError> {
    match result {
        Ok(value) => Ok(value),
        Err(_) if killed.load(Ordering::Relaxed) => Err(SidecarError::msg(CANCELLED)),
        Err(error) => Err(error.into()),
    }
}

pub struct OracleSession {
    conn: Arc<Mutex<Connection>>,
    pub sid: usize,
    pub serial: usize,
    pub version: String,
    killed: Arc<AtomicBool>,
}

impl OracleSession {
    pub async fn open(profile: &ConnectionProfile, host: &str, port: u16) -> Result<Self, SidecarError> {
        let conn = connect(profile, host, port).await?;
        Ok(Self {
            sid: conn.session_id()?,
            serial: conn.serial_num()?,
            version: conn.version()?.to_string(),
            conn: Arc::new(Mutex::new(conn)),
            killed: Arc::new(AtomicBool::new(false)),
        })
    }

    /// Run one unit of work with the session to itself.
    pub async fn run<T, F>(&self, f: F) -> Result<T, SidecarError>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> Result<T, oracledb::Error> + Send + 'static,
    {
        let guard = Arc::clone(&self.conn).lock_owned().await;
        let (_guard, result) = on_blocking_pool(guard, f).await?;
        outcome(&self.killed, result)
    }

    /// Hold the session across several calls (batches, transactions).
    pub async fn pin(&self) -> OraclePinned {
        OraclePinned {
            guard: Some(Arc::clone(&self.conn).lock_owned().await),
            killed: Arc::clone(&self.killed),
            in_transaction: false,
        }
    }

    /// A statement is running; the connection is plainly alive.
    pub fn is_busy(&self) -> bool {
        self.conn.try_lock().is_err()
    }

    /// Flag the session before /cancel kills it (see `outcome`).
    pub fn mark_killed(&self) {
        self.killed.store(true, Ordering::Relaxed);
    }

    /// The kill was refused; the session is still in business.
    pub fn unmark_killed(&self) {
        self.killed.store(false, Ordering::Relaxed);
    }

    pub fn was_killed(&self) -> bool {
        self.killed.load(Ordering::Relaxed)
    }

    pub async fn ping(&self) -> Result<(), SidecarError> {
        self.run(|conn| conn.ping()).await
    }

    /// Log off politely when the session is idle. A session still running a
    /// statement is simply dropped with its thread.
    pub async fn close(&self) {
        if let Ok(guard) = Arc::clone(&self.conn).try_lock_owned() {
            let _ = tokio::task::spawn_blocking(move || {
                let mut guard = guard;
                let _ = guard.close();
            })
            .await;
        }
    }
}

/// The session held for a batch. Oracle has no autocommit, so writes are
/// committed after each statement unless a transaction is open.
pub struct OraclePinned {
    guard: Option<OwnedMutexGuard<Connection>>,
    killed: Arc<AtomicBool>,
    in_transaction: bool,
}

impl OraclePinned {
    async fn call<T, F>(&mut self, f: F) -> Result<T, SidecarError>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> Result<T, oracledb::Error> + Send + 'static,
    {
        let guard = self.guard.take().expect("pinned Oracle session is held until drop");
        let (guard, result) = on_blocking_pool(guard, f).await?;
        self.guard = Some(guard);
        outcome(&self.killed, result)
    }

    pub async fn fetch(&mut self, sql: &str) -> Result<QueryOutput, SidecarError> {
        let sql = sql.to_string();
        self.call(move |conn| fetch(conn, &sql, &[])).await
    }

    pub async fn execute(&mut self, sql: &str) -> Result<u64, SidecarError> {
        let (sql, commit) = (sql.to_string(), !self.in_transaction);
        self.call(move |conn| execute(conn, &sql, commit)).await
    }

    pub fn begin(&mut self) {
        self.in_transaction = true;
    }

    pub async fn commit(&mut self) -> Result<(), SidecarError> {
        self.in_transaction = false;
        self.call(|conn| conn.commit()).await
    }

    pub async fn rollback(&mut self) -> Result<(), SidecarError> {
        self.in_transaction = false;
        self.call(|conn| conn.rollback()).await
    }
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

/// Upper-cased leading keywords, skipping whitespace and comments.
fn leading_words(sql: &str, count: usize) -> Vec<String> {
    let mut rest = sql;
    let mut words = Vec::new();
    while words.len() < count {
        rest = rest.trim_start();
        if let Some(after) = rest.strip_prefix("--") {
            rest = after.split_once('\n').map_or("", |(_, tail)| tail);
        } else if let Some(after) = rest.strip_prefix("/*") {
            rest = after.split_once("*/").map_or("", |(_, tail)| tail);
        } else {
            let end = rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).unwrap_or(rest.len());
            if end == 0 {
                break;
            }
            words.push(rest[..end].to_ascii_uppercase());
            rest = &rest[end..];
        }
    }
    words
}

/// `CREATE [OR REPLACE] [EDITIONABLE | NONEDITIONABLE] TRIGGER`
fn is_trigger_ddl(sql: &str) -> bool {
    let words = leading_words(sql, 5);
    let mut words = words.iter().map(String::as_str);
    if words.next() != Some("CREATE") {
        return false;
    }
    let mut next = words.next();
    if next == Some("OR") {
        if words.next() != Some("REPLACE") {
            return false;
        }
        next = words.next();
    }
    if matches!(next, Some("EDITIONABLE" | "NONEDITIONABLE")) {
        next = words.next();
    }
    next == Some("TRIGGER")
}

/// Adapt statement text for the driver: drop a SQL*Plus `/` terminator line,
/// and run trigger DDL through EXECUTE IMMEDIATE because the driver mistakes
/// `:NEW` / `:OLD` in the trigger body for bind variables.
pub fn prepare(sql: &str) -> Cow<'_, str> {
    let mut text = sql.trim_end();
    if let Some(head) = text.strip_suffix('/') {
        if head.is_empty() || head.ends_with('\n') {
            text = head.trim_end();
        }
    }
    if is_trigger_ddl(text) {
        return Cow::Owned(format!("BEGIN EXECUTE IMMEDIATE '{}'; END;", text.replace('\'', "''")));
    }
    Cow::Borrowed(text)
}

/// Run a query and read every row. Binds are positional text values; an
/// empty string binds as NULL, which Oracle treats the same.
pub fn fetch(conn: &Connection, sql: &str, binds: &[String]) -> Result<QueryOutput, oracledb::Error> {
    let params: Vec<&dyn ToDbValue> = binds.iter().map(|bind| bind as &dyn ToDbValue).collect();
    let cursor = conn.query(&prepare(sql), &params)?;
    let columns = cursor.columns().iter().map(|column| column.name().to_string()).collect();
    let mut rows = Vec::new();
    for row in cursor {
        rows.push(row_values(&row?));
    }
    Ok(QueryOutput { columns, rows })
}

/// Run a statement that returns no rows, committing it unless the caller
/// holds a transaction open.
pub fn execute(conn: &Connection, sql: &str, commit: bool) -> Result<u64, oracledb::Error> {
    let affected = conn.execute(&prepare(sql), &[])?.rows_affected();
    if commit {
        conn.commit()?;
    }
    Ok(affected)
}

// ---------------------------------------------------------------------------
// Values → JSON wire format
// ---------------------------------------------------------------------------

/// Integral NUMBERs that fit a JS number become numbers; everything else
/// stays text so no precision is lost (like Postgres NUMERIC). Columns
/// declared with decimals are always text, so one column never mixes both.
fn number(text: String, decimal_column: bool) -> Value {
    match text.parse::<i64>() {
        Ok(integer) if !decimal_column => value::num_i64(integer),
        _ => Value::from(text),
    }
}

fn naive(ts: &OracleTimestamp) -> Option<NaiveDateTime> {
    NaiveDate::from_ymd_opt(ts.year() as i32, ts.month() as u32, ts.day() as u32)?.and_hms_nano_opt(
        ts.hour() as u32,
        ts.minute() as u32,
        ts.second() as u32,
        ts.nanoseconds(),
    )
}

/// Zoned values are UTC instants (`...Z`, shown in local time by the app).
/// DATE and TIMESTAMP use the session's NLS form, `YYYY-MM-DD HH24:MI:SS[.FF]`,
/// so an unchanged value converts back when used in a WHERE clause.
fn timestamp(ts: &OracleTimestamp, utc: bool) -> Value {
    match naive(ts) {
        Some(dt) if utc => value::iso_utc(DateTime::from_naive_utc_and_offset(dt, Utc)),
        Some(dt) => Value::from(dt.format("%Y-%m-%d %H:%M:%S%.f").to_string()),
        None => Value::Null,
    }
}

/// Oracle's own literal form: `+01 02:03:04.500000`.
fn interval_ds(v: &OracleIntervalDS) -> String {
    let negative = v.days() < 0 || v.hours() < 0 || v.minutes() < 0 || v.seconds() < 0 || v.nanoseconds() < 0;
    format!(
        "{}{:02} {:02}:{:02}:{:02}.{:06}",
        if negative { '-' } else { '+' },
        v.days().unsigned_abs(),
        v.hours().unsigned_abs(),
        v.minutes().unsigned_abs(),
        v.seconds().unsigned_abs(),
        v.nanoseconds().unsigned_abs() / 1_000,
    )
}

/// Oracle's own literal form: `+02-03`.
fn interval_ym(v: &OracleIntervalYM) -> String {
    let negative = v.years() < 0 || v.months() < 0;
    format!("{}{:02}-{:02}", if negative { '-' } else { '+' }, v.years().unsigned_abs(), v.months().unsigned_abs())
}

fn vector_data(data: &VectorData) -> Value {
    match data {
        VectorData::Float32(values) => values.iter().map(|x| value::num_f64(*x as f64)).collect(),
        VectorData::Float64(values) => values.iter().map(|x| value::num_f64(*x)).collect(),
        VectorData::Int8(values) => values.iter().map(|x| Value::from(*x)).collect(),
        VectorData::Binary(values) => values.iter().map(|x| Value::from(*x)).collect(),
    }
}

fn vector(v: &Vector) -> Value {
    match v {
        Vector::Dense(data) => vector_data(data),
        Vector::Sparse(sparse) => serde_json::json!({
            "dimensions": sparse.num_dimensions(),
            "indices": sparse.indices(),
            "values": vector_data(sparse.values()),
        }),
    }
}

fn json(v: &JsonValue) -> Value {
    match v {
        JsonValue::Null => Value::Null,
        JsonValue::Boolean(flag) => Value::Bool(*flag),
        JsonValue::String(text) => Value::from(text.as_str()),
        JsonValue::Number(n) => {
            let text = n.to_string();
            text.parse::<i64>()
                .map(value::num_i64)
                .or_else(|_| text.parse::<f64>().map(value::num_f64))
                .unwrap_or(Value::from(text))
        }
        JsonValue::BinaryDouble(x) => value::num_f64(*x),
        JsonValue::BinaryFloat(x) => value::num_f64(*x as f64),
        JsonValue::Timestamp(ts) => timestamp(ts, false),
        JsonValue::IntervalDS(v) => Value::from(interval_ds(v)),
        JsonValue::IntervalYM(v) => Value::from(interval_ym(v)),
        JsonValue::Raw(bytes) | JsonValue::JsonId(bytes) => {
            Value::from(bytes.iter().map(|b| format!("{b:02x}")).collect::<String>())
        }
        JsonValue::Vector(v) => vector(v),
        JsonValue::JsonArray(items) => items.iter().map(json).collect(),
        JsonValue::JsonObject(map) => {
            let map: &HashMap<String, JsonValue> = map;
            Value::Object(map.iter().map(|(key, item)| (key.clone(), json(item))).collect())
        }
    }
}

fn cell(row: &Row, i: usize) -> Result<Value, oracledb::Error> {
    let type_name = row.columns()[i].db_type().name();
    Ok(match type_name {
        "DB_TYPE_NUMBER" | "DB_TYPE_BINARY_INTEGER" => {
            let decimal_column = row.columns()[i].scale() > 0;
            row.get::<Option<OracleNumber>>(i)?.map(|n| number(n.to_string(), decimal_column)).unwrap_or(Value::Null)
        }
        "DB_TYPE_BINARY_DOUBLE" => row.get::<Option<f64>>(i)?.map(value::num_f64).unwrap_or(Value::Null),
        "DB_TYPE_BINARY_FLOAT" => row.get::<Option<f32>>(i)?.map(|x| value::num_f64(x as f64)).unwrap_or(Value::Null),
        "DB_TYPE_BOOLEAN" => row.get::<Option<bool>>(i)?.map(Value::Bool).unwrap_or(Value::Null),
        "DB_TYPE_DATE" | "DB_TYPE_TIMESTAMP" => {
            row.get::<Option<OracleTimestamp>>(i)?.map(|ts| timestamp(&ts, false)).unwrap_or(Value::Null)
        }
        // The driver returns both time-zone-aware types normalised to UTC.
        "DB_TYPE_TIMESTAMP_TZ" | "DB_TYPE_TIMESTAMP_LTZ" => {
            row.get::<Option<OracleTimestamp>>(i)?.map(|ts| timestamp(&ts, true)).unwrap_or(Value::Null)
        }
        "DB_TYPE_INTERVAL_DS" => {
            row.get::<Option<OracleIntervalDS>>(i)?.map(|v| Value::from(interval_ds(&v))).unwrap_or(Value::Null)
        }
        "DB_TYPE_INTERVAL_YM" => {
            row.get::<Option<OracleIntervalYM>>(i)?.map(|v| Value::from(interval_ym(&v))).unwrap_or(Value::Null)
        }
        // LOBs are fetched inline, so BLOBs arrive as LONG RAW.
        "DB_TYPE_RAW" | "DB_TYPE_LONG_RAW" | "DB_TYPE_BLOB" => {
            row.get::<Option<Vec<u8>>>(i)?.map(value::buffer_json).unwrap_or(Value::Null)
        }
        "DB_TYPE_JSON" => row.get::<Option<JsonValue>>(i)?.map(|v| json(&v)).unwrap_or(Value::Null),
        "DB_TYPE_VECTOR" => row.get::<Option<Vector>>(i)?.map(|v| vector(&v)).unwrap_or(Value::Null),
        _ => row.get::<Option<String>>(i)?.map(Value::from).unwrap_or(Value::Null),
    })
}

pub fn row_values(row: &Row) -> Vec<Value> {
    (0..row.columns().len())
        .map(|i| {
            // Object types, collections and nested cursors have no JSON
            // form; show their type instead of failing the whole result.
            cell(row, i).unwrap_or_else(|_| {
                Value::from(format!("<{}>", row.columns()[i].db_type().name().trim_start_matches("DB_TYPE_")))
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trigger_ddl_is_wrapped_in_execute_immediate() {
        let sql = "CREATE OR REPLACE TRIGGER t BEFORE INSERT ON x FOR EACH ROW BEGIN :NEW.a := 'b'; END;";
        assert_eq!(
            prepare(sql),
            "BEGIN EXECUTE IMMEDIATE 'CREATE OR REPLACE TRIGGER t BEFORE INSERT ON x FOR EACH ROW BEGIN :NEW.a := ''b''; END;'; END;"
        );
        assert!(is_trigger_ddl("-- note\ncreate editionable trigger t"));
        assert!(is_trigger_ddl("/* x */ CREATE TRIGGER t"));
        assert!(!is_trigger_ddl("CREATE TABLE trigger_log (id NUMBER)"));
        assert!(!is_trigger_ddl("SELECT 'CREATE TRIGGER' FROM dual"));
    }

    #[test]
    fn slash_terminator_is_dropped() {
        assert_eq!(prepare("BEGIN NULL; END;\n/\n"), "BEGIN NULL; END;");
        assert_eq!(prepare("SELECT 4 / 2 FROM dual"), "SELECT 4 / 2 FROM dual");
        assert_eq!(prepare("SELECT 4 /"), "SELECT 4 /");
    }

    #[test]
    fn numbers_keep_precision() {
        assert_eq!(number("42".into(), false), Value::from(42));
        assert_eq!(number("12.5".into(), false), Value::from("12.5"));
        assert_eq!(number("2088".into(), true), Value::from("2088"));
        assert_eq!(number("123456789012345678901234567890".into(), false), Value::from("123456789012345678901234567890"));
    }

    #[test]
    fn intervals_use_oracle_literal_form() {
        assert_eq!(interval_ds(&OracleIntervalDS::new(1, 2, 3, 4, 500_000_000)), "+01 02:03:04.500000");
        assert_eq!(interval_ym(&OracleIntervalYM::new(2, 3)), "+02-03");
    }
}
