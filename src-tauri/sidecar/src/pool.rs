use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use futures::future::{BoxFuture, FutureExt, Shared};
use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions, MySqlSslMode};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions, PgSslMode};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::Connection;

use crate::db::DbClient;
use crate::error::SidecarError;
use crate::ssh::{create_ssh_tunnel, SshTunnel};
use crate::types::ConnectionProfile;

const IDLE_CHECK_AFTER_MS: u64 = 30_000;
const HEALTH_CHECK_TIMEOUT_MS: u64 = 3_000;
const CONNECT_TIMEOUT_MS: u64 = 5_000;

pub struct PoolEntry {
    pub client: DbClient,
    pub tunnel: Option<SshTunnel>,
    /// Effective host/port after any SSH tunnel — what /cancel's side
    /// connections must dial.
    pub connect_host: String,
    pub connect_port: u16,
}

pub struct PoolRecord {
    pub entry: Arc<PoolEntry>,
    pub profile: ConnectionProfile,
    last_used_ms: AtomicU64,
}

static START: LazyLock<Instant> = LazyLock::new(Instant::now);

fn now_ms() -> u64 {
    START.elapsed().as_millis() as u64
}

static POOL: LazyLock<Mutex<HashMap<String, Arc<PoolRecord>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

type ReconnectFuture = Shared<BoxFuture<'static, Result<Arc<PoolEntry>, String>>>;
static RECONNECTING: LazyLock<Mutex<HashMap<String, ReconnectFuture>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn get_record(id: &str) -> Option<Arc<PoolRecord>> {
    POOL.lock().unwrap().get(id).cloned()
}

pub fn has_connection(id: &str) -> bool {
    POOL.lock().unwrap().contains_key(id)
}

pub fn mark_connection_used(id: &str) {
    if let Some(record) = get_record(id) {
        record.last_used_ms.store(now_ms(), Ordering::Relaxed);
    }
}

fn set_connection(id: &str, entry: Arc<PoolEntry>, profile: ConnectionProfile) {
    let record = Arc::new(PoolRecord {
        entry,
        profile,
        last_used_ms: AtomicU64::new(now_ms()),
    });
    POOL.lock().unwrap().insert(id.to_string(), record);
}

async fn with_timeout<T>(
    fut: impl std::future::Future<Output = Result<T, SidecarError>>,
    timeout_ms: u64,
    message: &str,
) -> Result<T, SidecarError> {
    match tokio::time::timeout(Duration::from_millis(timeout_ms), fut).await {
        Ok(result) => result,
        Err(_) => Err(SidecarError::msg(message)),
    }
}

async fn close_client(client: &DbClient) {
    match client {
        DbClient::Postgres { pool, .. } => pool.close().await,
        DbClient::MySql { pool, .. } => pool.close().await,
        DbClient::Sqlite { pool } => pool.close().await,
    }
}

pub async fn close_entry(entry: &PoolEntry) {
    close_client(&entry.client).await;
    if let Some(tunnel) = &entry.tunnel {
        tunnel.close().await;
    }
}

/// Close and remove a pooled connection. A new connection with the same
/// profile id may have been opened while the old client's asynchronous
/// shutdown was in progress — never delete that replacement from the pool.
pub async fn close_connection(id: &str) -> bool {
    let Some(record) = get_record(id) else {
        return false;
    };
    close_entry(&record.entry).await;
    let mut map = POOL.lock().unwrap();
    if let Some(current) = map.get(id) {
        if Arc::ptr_eq(current, &record) {
            map.remove(id);
        }
    }
    true
}

/// Establish a database client (through an SSH tunnel when configured)
/// without touching the pool registry.
pub async fn connect(profile: &ConnectionProfile) -> Result<PoolEntry, SidecarError> {
    let tunnel = create_ssh_tunnel(profile).await?;
    let (connect_host, connect_port) = match &tunnel {
        Some(t) => (t.host.to_string(), t.port),
        None => (profile.host.clone(), profile.port),
    };

    let client_result = build_client(profile, &connect_host, connect_port).await;
    match client_result {
        Ok(client) => Ok(PoolEntry {
            client,
            tunnel,
            connect_host,
            connect_port,
        }),
        Err(error) => {
            if let Some(t) = &tunnel {
                t.close().await;
            }
            Err(error)
        }
    }
}

pub fn pg_connect_options(profile: &ConnectionProfile, host: &str, port: u16) -> PgConnectOptions {
    PgConnectOptions::new()
        .host(host)
        .port(port)
        .database(&profile.database)
        .username(&profile.username)
        .password(&profile.password)
        .ssl_mode(if profile.ssl { PgSslMode::Require } else { PgSslMode::Disable })
}

pub fn mysql_connect_options(profile: &ConnectionProfile, host: &str, port: u16) -> MySqlConnectOptions {
    let mut options = MySqlConnectOptions::new()
        .host(host)
        .port(port)
        .username(&profile.username)
        .password(&profile.password)
        .ssl_mode(if profile.ssl { MySqlSslMode::Required } else { MySqlSslMode::Disabled });
    if !profile.database.is_empty() {
        options = options.database(&profile.database);
    }
    options
}

async fn build_client(profile: &ConnectionProfile, host: &str, port: u16) -> Result<DbClient, SidecarError> {
    match profile.db_type.as_str() {
        "postgres" => {
            let pids: Arc<Mutex<HashSet<i32>>> = Arc::new(Mutex::new(HashSet::new()));
            let hook_pids = Arc::clone(&pids);
            let pool_future = PgPoolOptions::new()
                .max_connections(4)
                .after_connect(move |conn, _meta| {
                    let pids = Arc::clone(&hook_pids);
                    Box::pin(async move {
                        let row: (i32,) = sqlx::query_as("SELECT pg_backend_pid()").fetch_one(&mut *conn).await?;
                        pids.lock().unwrap().insert(row.0);
                        Ok(())
                    })
                })
                .connect_with(pg_connect_options(profile, host, port));
            let pool = with_timeout(
                async { pool_future.await.map_err(SidecarError::from) },
                CONNECT_TIMEOUT_MS,
                "connect timeout",
            )
            .await?;
            Ok(DbClient::Postgres { pool, pids })
        }
        "mysql" => {
            let thread_id = Arc::new(AtomicU64::new(0));
            let hook_tid = Arc::clone(&thread_id);
            let pool_future = MySqlPoolOptions::new()
                .max_connections(1)
                .after_connect(move |conn, _meta| {
                    let tid = Arc::clone(&hook_tid);
                    Box::pin(async move {
                        let row: (u64,) = sqlx::query_as("SELECT CONNECTION_ID()").fetch_one(&mut *conn).await?;
                        tid.store(row.0, Ordering::Relaxed);
                        Ok(())
                    })
                })
                .connect_with(mysql_connect_options(profile, host, port));
            let pool = with_timeout(
                async { pool_future.await.map_err(SidecarError::from) },
                CONNECT_TIMEOUT_MS,
                "connect timeout",
            )
            .await?;
            Ok(DbClient::MySql { pool, thread_id })
        }
        "sqlite" => {
            let options = SqliteConnectOptions::new()
                .filename(&profile.database)
                .create_if_missing(true)
                // bun:sqlite left SQLite's default (foreign keys OFF); sqlx
                // would otherwise turn them on and change DML behavior.
                .foreign_keys(false);
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect_with(options)
                .await
                .map_err(SidecarError::from)?;
            Ok(DbClient::Sqlite { pool })
        }
        other => Err(SidecarError::msg(format!("Unsupported connection type: {other}"))),
    }
}

/// Open (or replace) a pooled connection and report the server version.
pub async fn open_connection(profile: &ConnectionProfile) -> Result<(Arc<PoolEntry>, String), SidecarError> {
    if has_connection(&profile.id) {
        close_connection(&profile.id).await;
    }

    let entry = Arc::new(connect(profile).await?);
    let version_result = fetch_server_version(&entry.client, &profile.id, &profile.database).await;
    match version_result {
        Ok(server_version) => {
            set_connection(&profile.id, Arc::clone(&entry), profile.clone());
            Ok((entry, server_version))
        }
        Err(error) => {
            close_entry(&entry).await;
            Err(error)
        }
    }
}

async fn fetch_server_version(client: &DbClient, conn_id: &str, db: &str) -> Result<String, SidecarError> {
    let sql = match client {
        DbClient::Postgres { .. } => "SHOW server_version",
        DbClient::MySql { .. } => "SELECT version() AS v",
        DbClient::Sqlite { .. } => "SELECT sqlite_version() AS v",
    };
    let output = crate::db::fetch_raw(client, conn_id, db, sql).await?;
    Ok(output
        .rows
        .first()
        .and_then(|row| row.first())
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string())
}

/// Reconnect a dead connection using its stored profile. Concurrent callers
/// for the same id share one attempt.
pub async fn reconnect(id: &str) -> Result<Arc<PoolEntry>, SidecarError> {
    let fut = {
        let mut map = RECONNECTING.lock().unwrap();
        if let Some(existing) = map.get(id) {
            existing.clone()
        } else {
            let fut: ReconnectFuture = reconnect_internal(id.to_string()).boxed().shared();
            map.insert(id.to_string(), fut.clone());
            fut
        }
    };
    let result = fut.await;
    RECONNECTING.lock().unwrap().remove(id);
    result.map_err(SidecarError::Msg)
}

async fn reconnect_internal(id: String) -> Result<Arc<PoolEntry>, String> {
    let record = get_record(&id).ok_or_else(|| "Connection not found".to_string())?;
    let profile = record.profile.clone();
    println!(
        "[pool] reconnecting {id} ({} {}:{}/{})",
        profile.db_type, profile.host, profile.port, profile.database
    );

    // Try to close the old one silently.
    let _ = tokio::time::timeout(Duration::from_millis(1_500), close_client(&record.entry.client)).await;
    if let Some(tunnel) = &record.entry.tunnel {
        tunnel.close().await;
    }

    let entry = Arc::new(connect(&profile).await.map_err(|e| e.friendly())?);

    // Verify the new connection is alive before publishing it.
    if matches!(entry.client, DbClient::Postgres { .. }) {
        if let Err(error) = crate::db::fetch_raw(&entry.client, &id, &profile.database, "SELECT 1").await {
            close_entry(&entry).await;
            return Err(error.friendly());
        }
    }

    set_connection(&id, Arc::clone(&entry), profile);
    println!("[pool] reconnected {id} successfully");
    Ok(entry)
}

/// Check connections that have been idle long enough to plausibly have
/// crossed a server timeout or device sleep. A stuck ping is bounded, then
/// the existing profile is used to reconnect before the caller sends work.
pub async fn ensure_connection_alive(id: &str, force: bool) -> Result<(Arc<PoolEntry>, bool), SidecarError> {
    let record = get_record(id).ok_or_else(|| SidecarError::msg("Connection not found"))?;

    if matches!(record.entry.client, DbClient::Sqlite { .. }) {
        record.last_used_ms.store(now_ms(), Ordering::Relaxed);
        return Ok((Arc::clone(&record.entry), false));
    }

    if !force && now_ms().saturating_sub(record.last_used_ms.load(Ordering::Relaxed)) < IDLE_CHECK_AFTER_MS {
        record.last_used_ms.store(now_ms(), Ordering::Relaxed);
        return Ok((Arc::clone(&record.entry), false));
    }

    let health = match &record.entry.client {
        DbClient::Postgres { .. } => {
            with_timeout(
                async {
                    crate::db::fetch_raw(&record.entry.client, id, &record.profile.database, "SELECT 1").await?;
                    Ok(())
                },
                HEALTH_CHECK_TIMEOUT_MS,
                "PostgreSQL connection health check timed out",
            )
            .await
        }
        DbClient::MySql { pool, .. } => {
            with_timeout(
                async {
                    let mut conn = pool.acquire().await.map_err(SidecarError::from)?;
                    conn.ping().await.map_err(SidecarError::from)?;
                    Ok(())
                },
                HEALTH_CHECK_TIMEOUT_MS,
                "MySQL connection health check timed out",
            )
            .await
        }
        DbClient::Sqlite { .. } => unreachable!(),
    };

    match health {
        Ok(()) => {
            record.last_used_ms.store(now_ms(), Ordering::Relaxed);
            Ok((Arc::clone(&record.entry), false))
        }
        Err(error) => {
            println!("[pool] idle connection check failed for {id}: {error}");
            let entry = reconnect(id).await?;
            Ok((entry, true))
        }
    }
}
