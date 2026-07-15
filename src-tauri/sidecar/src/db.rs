use std::sync::atomic::AtomicU64;
use std::sync::Arc;

use serde_json::Value;
use sqlx::mysql::MySqlRow;
use sqlx::postgres::PgRow;
use sqlx::sqlite::SqliteRow;
use sqlx::{MySqlPool, PgPool, SqlitePool};

use crate::error::SidecarError;
use crate::trace;
use crate::value;

pub enum DbClient {
    Postgres {
        pool: PgPool,
        /// Backend pids captured per pooled connection, for pg_cancel_backend.
        pids: Arc<std::sync::Mutex<std::collections::HashSet<i32>>>,
    },
    MySql {
        pool: MySqlPool,
        /// CONNECTION_ID() of the (single) pooled connection, for KILL QUERY.
        thread_id: Arc<AtomicU64>,
    },
    Sqlite {
        pool: SqlitePool,
    },
}

pub struct QueryOutput {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
}

fn objects(columns: &[String], rows: Vec<Vec<Value>>) -> Vec<Value> {
    rows.into_iter()
        .map(|row| {
            let mut map = serde_json::Map::new();
            for (name, value) in columns.iter().zip(row) {
                map.insert(name.clone(), value);
            }
            Value::Object(map)
        })
        .collect()
}

impl QueryOutput {
    pub fn into_objects(self) -> Vec<Value> {
        objects(&self.columns, self.rows)
    }
}

fn pg_output(rows: &[PgRow]) -> QueryOutput {
    let columns = rows.first().map(value::column_names).unwrap_or_default();
    QueryOutput {
        columns,
        rows: rows.iter().map(value::pg_row_values).collect(),
    }
}

fn mysql_output(rows: &[MySqlRow]) -> QueryOutput {
    let columns = rows.first().map(value::column_names).unwrap_or_default();
    QueryOutput {
        columns,
        rows: rows.iter().map(value::mysql_row_values).collect(),
    }
}

fn sqlite_output(rows: &[SqliteRow]) -> QueryOutput {
    let columns = rows.first().map(value::column_names).unwrap_or_default();
    QueryOutput {
        columns,
        rows: rows.iter().map(value::sqlite_row_values).collect(),
    }
}

/// Run a fallible async DB operation with query-log tracing, mirroring the
/// old Proxy-based instrumentConnection.
pub async fn traced<T, F>(
    conn_id: &str,
    db: &str,
    sql: &str,
    row_count: impl FnOnce(&T) -> Option<u64>,
    op: F,
) -> Result<T, SidecarError>
where
    F: std::future::Future<Output = Result<T, sqlx::Error>>,
{
    let t = trace::start(conn_id, db, sql);
    match op.await {
        Ok(value) => {
            t.success(row_count(&value));
            Ok(value)
        }
        Err(cause) => {
            let err = SidecarError::from(cause);
            t.failure(&err.to_string());
            Err(err)
        }
    }
}

// ---------------------------------------------------------------------------
// Raw (unprepared, text/simple protocol) execution — used for user SQL,
// SHOW/PRAGMA statements, and DDL. Matches how the JS drivers ran these.
// ---------------------------------------------------------------------------

pub async fn fetch_raw(client: &DbClient, conn_id: &str, db: &str, sql: &str) -> Result<QueryOutput, SidecarError> {
    match client {
        DbClient::Postgres { pool, .. } => {
            let rows = traced(conn_id, db, sql, |r: &Vec<PgRow>| Some(r.len() as u64), sqlx::raw_sql(sql).fetch_all(pool)).await?;
            Ok(pg_output(&rows))
        }
        DbClient::MySql { pool, .. } => {
            let rows = traced(conn_id, db, sql, |r: &Vec<MySqlRow>| Some(r.len() as u64), sqlx::raw_sql(sql).fetch_all(pool)).await?;
            Ok(mysql_output(&rows))
        }
        DbClient::Sqlite { pool } => {
            let rows = traced(conn_id, db, sql, |r: &Vec<SqliteRow>| Some(r.len() as u64), sqlx::raw_sql(sql).fetch_all(pool)).await?;
            Ok(sqlite_output(&rows))
        }
    }
}

pub async fn execute_raw(client: &DbClient, conn_id: &str, db: &str, sql: &str) -> Result<u64, SidecarError> {
    match client {
        DbClient::Postgres { pool, .. } => {
            traced(conn_id, db, sql, |n: &u64| Some(*n), async {
                Ok(sqlx::raw_sql(sql).execute(pool).await?.rows_affected())
            })
            .await
        }
        DbClient::MySql { pool, .. } => {
            traced(conn_id, db, sql, |n: &u64| Some(*n), async {
                Ok(sqlx::raw_sql(sql).execute(pool).await?.rows_affected())
            })
            .await
        }
        DbClient::Sqlite { pool } => {
            traced(conn_id, db, sql, |n: &u64| Some(*n), async {
                Ok(sqlx::raw_sql(sql).execute(pool).await?.rows_affected())
            })
            .await
        }
    }
}

// ---------------------------------------------------------------------------
// Prepared, string-bound fetches — used by introspection queries. All binds
// in the ported SQL are text.
// ---------------------------------------------------------------------------

pub async fn pg_fetch(
    client: &DbClient,
    conn_id: &str,
    db: &str,
    sql: &str,
    binds: &[&str],
) -> Result<Vec<Value>, SidecarError> {
    let DbClient::Postgres { pool, .. } = client else {
        return Err(SidecarError::msg("Unexpected connection type"));
    };
    let mut query = sqlx::query(sql);
    for bind in binds {
        query = query.bind(bind.to_string());
    }
    let rows = traced(conn_id, db, sql, |r: &Vec<PgRow>| Some(r.len() as u64), query.fetch_all(pool)).await?;
    let output = pg_output(&rows);
    Ok(output.into_objects())
}

pub async fn mysql_fetch(
    client: &DbClient,
    conn_id: &str,
    db: &str,
    sql: &str,
    binds: &[&str],
) -> Result<Vec<Value>, SidecarError> {
    let DbClient::MySql { pool, .. } = client else {
        return Err(SidecarError::msg("Unexpected connection type"));
    };
    let mut query = sqlx::query(sql);
    for bind in binds {
        query = query.bind(bind.to_string());
    }
    let rows = traced(conn_id, db, sql, |r: &Vec<MySqlRow>| Some(r.len() as u64), query.fetch_all(pool)).await?;
    let output = mysql_output(&rows);
    Ok(output.into_objects())
}

pub async fn sqlite_fetch(
    client: &DbClient,
    conn_id: &str,
    db: &str,
    sql: &str,
    binds: &[&str],
) -> Result<Vec<Value>, SidecarError> {
    let DbClient::Sqlite { pool } = client else {
        return Err(SidecarError::msg("Unexpected connection type"));
    };
    let mut query = sqlx::query(sql);
    for bind in binds {
        query = query.bind(bind.to_string());
    }
    let rows = traced(conn_id, db, sql, |r: &Vec<SqliteRow>| Some(r.len() as u64), query.fetch_all(pool)).await?;
    let output = sqlite_output(&rows);
    Ok(output.into_objects())
}

// ---------------------------------------------------------------------------
// Concrete-typed helpers for direct connections and transactions. These exist
// to sidestep a rustc "implementation of Executor is not general enough"
// limitation when raw_sql futures are built inline inside nested async blocks.
// ---------------------------------------------------------------------------

// Passing a plain &str to Executor methods runs it unprepared (text/simple
// protocol), same as sqlx::raw_sql — and the trait methods return BoxFuture,
// which sidesteps the auto-trait leakage problem entirely.

pub async fn exec_pg_conn(conn: &mut sqlx::PgConnection, sql: &str) -> Result<u64, sqlx::Error> {
    use sqlx::Executor;
    Ok(conn.execute(sql).await?.rows_affected())
}

pub async fn exec_mysql_conn(conn: &mut sqlx::MySqlConnection, sql: &str) -> Result<u64, sqlx::Error> {
    use sqlx::Executor;
    Ok(conn.execute(sql).await?.rows_affected())
}

pub async fn exec_sqlite_conn(conn: &mut sqlx::SqliteConnection, sql: &str) -> Result<u64, sqlx::Error> {
    use sqlx::Executor;
    Ok(conn.execute(sql).await?.rows_affected())
}

pub async fn fetch_sqlite_conn(conn: &mut sqlx::SqliteConnection, sql: &str) -> Result<Vec<SqliteRow>, sqlx::Error> {
    use sqlx::Executor;
    conn.fetch_all(sql).await
}

pub async fn pg_cancel_backend(conn: &mut sqlx::PgConnection, pid: i32) -> Result<(), sqlx::Error> {
    use sqlx::Executor;
    conn.execute(sqlx::query("SELECT pg_cancel_backend($1)").bind(pid)).await.map(|_| ())
}

/// Raw-SQL variant of the object fetches, for statements that cannot be
/// prepared or bound (SHOW ..., PRAGMA ..., SHOW CREATE TABLE ...).
pub async fn fetch_raw_objects(client: &DbClient, conn_id: &str, db: &str, sql: &str) -> Result<Vec<Value>, SidecarError> {
    let output = fetch_raw(client, conn_id, db, sql).await?;
    Ok(output.into_objects())
}
