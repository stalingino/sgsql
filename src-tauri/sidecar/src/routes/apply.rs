use axum::body::Bytes;
use axum::extract::Path;
use axum::response::Response;
use serde::Deserialize;
use serde_json::json;
use std::time::Instant;

use super::query::switch_db;
use super::{error_response, json_response, parse_body, with_connection_status};
use crate::db::{self, DbClient};
use crate::error::SidecarError;
use crate::pool;
use crate::trace;

#[derive(Deserialize)]
struct ApplyBody {
    statements: Option<Vec<String>>,
    db: Option<String>,
    #[serde(rename = "disableForeignKeys", default)]
    disable_foreign_keys: bool,
}

async fn apply_postgres(
    pool: sqlx::PgPool,
    connection_id: String,
    trace_db: String,
    statements: Vec<String>,
    applied: &mut usize,
) -> Result<(), SidecarError> {
    let mut tx = pool.begin().await.map_err(SidecarError::from)?;
    for statement in &statements {
        let t = trace::start(&connection_id, &trace_db, statement);
        match db::exec_pg_conn(&mut tx, statement).await {
            Ok(affected) => t.success(Some(affected)),
            Err(cause) => {
                let err = SidecarError::from(cause);
                t.failure(&err.to_string());
                return Err(err);
            }
        }
        *applied += 1;
    }
    tx.commit().await.map_err(SidecarError::from)?;
    Ok(())
}

async fn apply_sqlite(
    pool: sqlx::SqlitePool,
    connection_id: String,
    trace_db: String,
    statements: Vec<String>,
    disable_fk: bool,
    applied: &mut usize,
) -> Result<(), SidecarError> {
    let mut conn = pool.acquire().await.map_err(SidecarError::from)?;

    async fn traced_exec(
        conn: &mut sqlx::SqliteConnection,
        connection_id: &str,
        trace_db: &str,
        sql: &str,
    ) -> Result<u64, SidecarError> {
        let t = trace::start(connection_id, trace_db, sql);
        match db::exec_sqlite_conn(conn, sql).await {
            Ok(affected) => {
                t.success(Some(affected));
                Ok(affected)
            }
            Err(cause) => {
                let err = SidecarError::from(cause);
                t.failure(&err.to_string());
                Err(err)
            }
        }
    }

    if disable_fk {
        traced_exec(&mut conn, &connection_id, &trace_db, "PRAGMA foreign_keys = OFF").await?;
    }

    let batch: Result<(), SidecarError> = async {
        let mut tx = sqlx::Connection::begin(&mut *conn).await.map_err(SidecarError::from)?;
        for statement in &statements {
            traced_exec(&mut tx, &connection_id, &trace_db, statement).await?;
            *applied += 1;
        }
        if disable_fk {
            let sql = "PRAGMA foreign_key_check";
            let t = trace::start(&connection_id, &trace_db, sql);
            match db::fetch_sqlite_conn(&mut tx, sql).await {
                Ok(violations) => {
                    t.success(Some(violations.len() as u64));
                    if !violations.is_empty() {
                        let n = violations.len();
                        return Err(SidecarError::msg(format!(
                            "Foreign-key validation failed for {n} row{}",
                            if n == 1 { "" } else { "s" }
                        )));
                    }
                }
                Err(cause) => {
                    let err = SidecarError::from(cause);
                    t.failure(&err.to_string());
                    return Err(err);
                }
            }
        }
        tx.commit().await.map_err(SidecarError::from)?;
        Ok(())
    }
    .await;

    if disable_fk {
        let restore = traced_exec(&mut conn, &connection_id, &trace_db, "PRAGMA foreign_keys = ON").await;
        if batch.is_ok() {
            restore?;
        }
    }
    batch
}

async fn apply_mysql(
    client: &DbClient,
    connection_id: String,
    trace_db: String,
    statements: Vec<String>,
    applied: &mut usize,
) -> Result<(), SidecarError> {
    // MySQL implicitly commits most DDL. Execute in order and report exactly
    // how many statements committed if a later statement fails.
    for statement in &statements {
        db::execute_raw(client, &connection_id, &trace_db, statement).await?;
        *applied += 1;
    }
    Ok(())
}

pub async fn handle_schema_apply(Path(connection_id): Path<String>, bytes: Bytes) -> Response {
    println!("[sidecar] schema apply: /schema/{connection_id}/apply");
    let body: ApplyBody = match parse_body(&bytes) {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    let statements: Vec<String> = body
        .statements
        .unwrap_or_default()
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if statements.is_empty() {
        return error_response("No DDL statements supplied", 400);
    }
    if statements.len() > 100 {
        return error_response("Schema batches are limited to 100 statements", 400);
    }

    let Some(record) = pool::get_record(&connection_id) else {
        return error_response("Connection not found. Call /connections/open first.", 404);
    };
    let trace_db = record.profile.database.clone();
    let is_mysql = matches!(record.entry.client, DbClient::MySql { .. });

    let started = Instant::now();
    let mut applied: usize = 0;
    let db_arg = body.db.unwrap_or_default();

    let ensured = pool::ensure_connection_alive(&connection_id, false).await;
    let outcome: Result<bool, SidecarError> = match ensured {
        Err(error) => Err(error),
        Ok((entry, reconnected)) => {
            let run = async {
                switch_db(&entry.client, &connection_id, &trace_db, &db_arg).await?;
                match &entry.client {
                    DbClient::Postgres { pool, .. } => {
                        apply_postgres(
                            pool.clone(),
                            connection_id.clone(),
                            trace_db.clone(),
                            statements.clone(),
                            &mut applied,
                        )
                        .await
                    }
                    DbClient::Sqlite { pool } => {
                        apply_sqlite(
                            pool.clone(),
                            connection_id.clone(),
                            trace_db.clone(),
                            statements.clone(),
                            body.disable_foreign_keys,
                            &mut applied,
                        )
                        .await
                    }
                    DbClient::MySql { .. } => {
                        apply_mysql(
                            &entry.client,
                            connection_id.clone(),
                            trace_db.clone(),
                            statements.clone(),
                            &mut applied,
                        )
                        .await
                    }
                }
            }
            .await;
            run.map(|()| reconnected)
        }
    };

    match outcome {
        Ok(reconnected) => {
            pool::mark_connection_used(&connection_id);
            json_response(
                200,
                with_connection_status(
                    json!({
                        "ok": true,
                        "applied": applied,
                        "atomic": !is_mysql,
                        "duration": started.elapsed().as_secs_f64() * 1_000.0,
                    }),
                    &connection_id,
                    reconnected,
                ),
            )
        }
        Err(error) => {
            let message = error.friendly();
            let suffix = if is_mysql && applied > 0 {
                format!(
                    " ({applied} statement{} already committed)",
                    if applied == 1 { "" } else { "s" }
                )
            } else {
                String::new()
            };
            eprintln!("[sidecar] schema apply failed after {applied} statements: {message}");
            error_response(&format!("{message}{suffix}"), 500)
        }
    }
}
