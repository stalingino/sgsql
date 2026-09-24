use axum::body::{Body, Bytes};
use axum::extract::Path;
use axum::http::header;
use axum::response::Response;
use futures::stream;
use serde::Deserialize;
use serde_json::json;
use std::convert::Infallible;
use std::time::Instant;
use tokio::sync::mpsc::UnboundedSender;

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

fn report_progress(
    progress: Option<&UnboundedSender<String>>,
    completed: usize,
    total: usize,
) -> Result<(), SidecarError> {
    if let Some(sender) = progress {
        sender
            .send(format!(
                "{}\n",
                json!({ "type": "progress", "completed": completed, "total": total })
            ))
            .map_err(|_| SidecarError::msg("Import cancelled"))?;
    }
    Ok(())
}

async fn apply_postgres(
    pool: sqlx::PgPool,
    connection_id: String,
    trace_db: String,
    statements: Vec<String>,
    applied: &mut usize,
    progress: Option<&UnboundedSender<String>>,
    total: usize,
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
        report_progress(progress, *applied, total)?;
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
    progress: Option<&UnboundedSender<String>>,
    total: usize,
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
            report_progress(progress, *applied, total)?;
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
    progress: Option<&UnboundedSender<String>>,
    total: usize,
) -> Result<(), SidecarError> {
    // MySQL implicitly commits most DDL. Execute in order and report exactly
    // how many statements committed if a later statement fails.
    for statement in &statements {
        db::execute_raw(client, &connection_id, &trace_db, statement).await?;
        *applied += 1;
        report_progress(progress, *applied, total)?;
    }
    Ok(())
}

struct ApplySuccess {
    reconnected: bool,
    applied: usize,
    atomic: bool,
    duration: f64,
}

struct ApplyFailure {
    message: String,
    applied: usize,
    status: u16,
}

fn statements_from_body(body: &mut ApplyBody) -> Vec<String> {
    body.statements
        .take()
        .unwrap_or_default()
        .into_iter()
        .map(|statement| statement.trim().to_string())
        .filter(|statement| !statement.is_empty())
        .collect()
}

async fn run_apply(
    connection_id: String,
    body: ApplyBody,
    statements: Vec<String>,
    operation: &'static str,
    progress: Option<UnboundedSender<String>>,
) -> Result<ApplySuccess, ApplyFailure> {
    println!("[sidecar] {operation}: {connection_id}");
    let Some(record) = pool::get_record(&connection_id) else {
        return Err(ApplyFailure {
            message: "Connection not found. Call /connections/open first.".to_string(),
            applied: 0,
            status: 404,
        });
    };
    let trace_db = record.profile.database.clone();
    let is_mysql = matches!(record.entry.client, DbClient::MySql { .. });

    let started = Instant::now();
    let mut applied: usize = 0;
    let db_arg = body.db.unwrap_or_default();
    let total = statements.len();

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
                            progress.as_ref(),
                            total,
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
                            progress.as_ref(),
                            total,
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
                            progress.as_ref(),
                            total,
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
            Ok(ApplySuccess {
                reconnected,
                applied,
                atomic: !is_mysql,
                duration: started.elapsed().as_secs_f64() * 1_000.0,
            })
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
            eprintln!("[sidecar] {operation} failed after {applied} statements: {message}");
            Err(ApplyFailure {
                message: format!("{message}{suffix}"),
                applied,
                status: 500,
            })
        }
    }
}

pub async fn handle_schema_apply(Path(connection_id): Path<String>, bytes: Bytes) -> Response {
    let mut body: ApplyBody = match parse_body(&bytes) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let statements = statements_from_body(&mut body);
    if statements.is_empty() {
        return error_response("No SQL statements supplied", 400);
    }
    if statements.len() > 100 {
        return error_response("Schema batches are limited to 100 statements", 400);
    }

    match run_apply(connection_id.clone(), body, statements, "schema apply", None).await {
        Ok(result) => json_response(
            200,
            with_connection_status(
                json!({
                    "ok": true,
                    "applied": result.applied,
                    "atomic": result.atomic,
                    "duration": result.duration,
                }),
                &connection_id,
                result.reconnected,
            ),
        ),
        Err(failure) => error_response(&failure.message, failure.status),
    }
}

pub async fn handle_sql_import(Path(connection_id): Path<String>, bytes: Bytes) -> Response {
    let mut body: ApplyBody = match parse_body(&bytes) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let statements = statements_from_body(&mut body);
    if statements.is_empty() {
        return error_response("No SQL statements supplied", 400);
    }

    let total = statements.len();
    let stream_connection_id = connection_id.clone();
    let (sender, receiver) = tokio::sync::mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        let outcome = run_apply(
            stream_connection_id.clone(),
            body,
            statements,
            "SQL import",
            Some(sender.clone()),
        )
        .await;
        let event = match outcome {
            Ok(result) => with_connection_status(
                json!({
                    "type": "complete",
                    "ok": true,
                    "applied": result.applied,
                    "total": total,
                    "atomic": result.atomic,
                    "duration": result.duration,
                }),
                &stream_connection_id,
                result.reconnected,
            ),
            Err(failure) => json!({
                "type": "error",
                "error": failure.message,
                "applied": failure.applied,
                "total": total,
            }),
        };
        let _ = sender.send(format!("{event}\n"));
    });

    let body_stream = stream::unfold(receiver, |mut receiver| async move {
        receiver
            .recv()
            .await
            .map(|line| (Ok::<Bytes, Infallible>(Bytes::from(line)), receiver))
    });
    Response::builder()
        .header(header::CONTENT_TYPE, "application/x-ndjson")
        .body(Body::from_stream(body_stream))
        .unwrap()
}
