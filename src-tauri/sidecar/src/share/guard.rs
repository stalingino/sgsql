//! SQL guard for agent shares: parses each statement and enforces the table
//! allowlist and the read-only / read-write mode of the share.
//!
//! Enforcement is fail-closed: only statement kinds we understand are
//! allowed, everything else (DDL, DCL, SET, COPY, transactions, utility
//! statements, unparsable input) is rejected. The database-level read-only
//! transaction in `exec.rs` is a second, independent layer.
//!
//! Known limitations (documented to the user in the share dialog):
//! - A shared *view* may expand to tables that are not shared.
//! - The function deny-list is best effort; it closes the obvious holes the
//!   read-only transaction does not cover (sleep, backend signalling, file IO).
//! - Identifiers are compared case-insensitively, so two Postgres tables that
//!   differ only by case are treated as one.
//! - Syntax the parser does not understand is rejected rather than executed.

use std::collections::HashSet;
use std::fmt;
use std::ops::ControlFlow;

use sqlparser::ast::{
    visit_relations, Expr, ObjectName, ObjectNamePart, Query, Select, Statement, Visit, Visitor,
};
use sqlparser::dialect::{Dialect, MySqlDialect, PostgreSqlDialect, SQLiteDialect};
use sqlparser::parser::Parser;

use super::types::{DbType, Share, TableKey};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Read,
    Write,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GuardError {
    Empty,
    Parse(String),
    MultipleStatements(usize),
    /// A statement kind that is never allowed through a share (DDL, SET, ...).
    Forbidden(&'static str),
    WriteInReadOnly,
    TableNotAllowed { table: String, shared: String },
    FunctionNotAllowed(String),
    UnsupportedQualifier(String),
}

impl fmt::Display for GuardError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            GuardError::Empty => write!(f, "No SQL statement provided."),
            GuardError::Parse(msg) => write!(f, "Could not parse the SQL statement: {msg}"),
            GuardError::MultipleStatements(n) => {
                write!(f, "Exactly one SQL statement is allowed per call (got {n}).")
            }
            GuardError::Forbidden(what) => {
                write!(f, "{what} statements are not allowed through this share.")
            }
            GuardError::WriteInReadOnly => write!(
                f,
                "This share is read-only. Only SELECT / WITH / VALUES / EXPLAIN queries are allowed."
            ),
            GuardError::TableNotAllowed { table, shared } => write!(
                f,
                "Table \"{table}\" is not shared with this agent. Shared tables: {shared}."
            ),
            GuardError::FunctionNotAllowed(name) => {
                write!(f, "Function \"{name}\" is not allowed through this share.")
            }
            GuardError::UnsupportedQualifier(name) => write!(
                f,
                "Table reference \"{name}\" cannot be resolved within the shared database."
            ),
        }
    }
}

impl std::error::Error for GuardError {}

#[derive(Debug)]
pub struct Verdict {
    pub kind: Kind,
}

/// Functions with side effects that a read-only transaction does not block.
const DENIED_FUNCTIONS: &[&str] = &[
    // PostgreSQL
    "pg_sleep",
    "pg_sleep_for",
    "pg_sleep_until",
    "pg_terminate_backend",
    "pg_cancel_backend",
    "pg_read_file",
    "pg_read_binary_file",
    "pg_ls_dir",
    "pg_stat_file",
    "pg_reload_conf",
    "pg_stat_reset",
    "pg_switch_wal",
    "pg_promote",
    "pg_advisory_lock",
    "pg_advisory_xact_lock",
    "pg_notify",
    "set_config",
    "setval",
    "nextval",
    "lo_import",
    "lo_export",
    "lo_unlink",
    "lo_from_bytea",
    "dblink",
    "dblink_exec",
    // MySQL / MariaDB
    "sleep",
    "benchmark",
    "load_file",
    "get_lock",
    "release_lock",
    "master_pos_wait",
    "sys_exec",
    "sys_eval",
    // SQLite
    "readfile",
    "writefile",
    "load_extension",
];

fn dialect(db: DbType) -> Box<dyn Dialect> {
    match db {
        DbType::Postgres => Box::new(PostgreSqlDialect {}),
        DbType::MySql => Box::new(MySqlDialect {}),
        DbType::Sqlite => Box::new(SQLiteDialect {}),
    }
}

pub fn parse_single(sql: &str, db: DbType) -> Result<Statement, GuardError> {
    if sql.trim().is_empty() {
        return Err(GuardError::Empty);
    }
    let mut statements = Parser::parse_sql(dialect(db).as_ref(), sql).map_err(|e| GuardError::Parse(e.to_string()))?;
    match statements.len() {
        0 => Err(GuardError::Empty),
        1 => Ok(statements.remove(0)),
        n => Err(GuardError::MultipleStatements(n)),
    }
}

/// Everything the guard needs to know about a statement tree in one walk.
#[derive(Default)]
struct Scan {
    cte_names: HashSet<String>,
    has_write_statement: bool,
    has_select_into: bool,
    has_locks: bool,
    denied_function: Option<String>,
}

impl Visitor for Scan {
    type Break = ();

    fn pre_visit_query(&mut self, query: &Query) -> ControlFlow<()> {
        if let Some(with) = &query.with {
            for cte in &with.cte_tables {
                self.cte_names.insert(cte.alias.name.value.to_lowercase());
            }
        }
        if !query.locks.is_empty() {
            self.has_locks = true;
        }
        ControlFlow::Continue(())
    }

    fn pre_visit_select(&mut self, select: &Select) -> ControlFlow<()> {
        if select.into.is_some() {
            self.has_select_into = true;
        }
        ControlFlow::Continue(())
    }

    fn pre_visit_statement(&mut self, statement: &Statement) -> ControlFlow<()> {
        if matches!(
            statement,
            Statement::Insert(_) | Statement::Update(_) | Statement::Delete(_) | Statement::Merge(_)
        ) {
            self.has_write_statement = true;
        }
        ControlFlow::Continue(())
    }

    fn pre_visit_expr(&mut self, expr: &Expr) -> ControlFlow<()> {
        if let Expr::Function(function) = expr {
            if let Some(name) = last_ident(&function.name) {
                let lower = name.to_lowercase();
                if DENIED_FUNCTIONS.contains(&lower.as_str()) && self.denied_function.is_none() {
                    self.denied_function = Some(lower);
                }
            }
        }
        ControlFlow::Continue(())
    }
}

fn scan(statement: &Statement) -> Scan {
    let mut scan = Scan::default();
    let _ = statement.visit(&mut scan);
    scan
}

fn last_ident(name: &ObjectName) -> Option<&str> {
    name.0.last().and_then(|part| part.as_ident()).map(|ident| ident.value.as_str())
}

/// Classify a statement as a read or a write; anything else is forbidden.
pub fn classify(statement: &Statement) -> Result<Kind, GuardError> {
    match statement {
        Statement::Query(_) => {
            let scan = scan(statement);
            if scan.has_select_into {
                return Err(GuardError::Forbidden("SELECT INTO"));
            }
            if scan.has_write_statement || scan.has_locks {
                Ok(Kind::Write)
            } else {
                Ok(Kind::Read)
            }
        }
        Statement::Explain {
            analyze, statement, ..
        } => {
            if *analyze {
                return Err(GuardError::Forbidden("EXPLAIN ANALYZE"));
            }
            match classify(statement)? {
                Kind::Read => Ok(Kind::Read),
                Kind::Write => Err(GuardError::Forbidden("EXPLAIN of a writing")),
            }
        }
        Statement::Insert(_) | Statement::Update(_) | Statement::Delete(_) | Statement::Merge(_) => {
            Ok(Kind::Write)
        }
        Statement::CreateTable(_)
        | Statement::CreateView { .. }
        | Statement::CreateIndex(_)
        | Statement::AlterTable(_)
        | Statement::Drop { .. }
        | Statement::Truncate(_) => Err(GuardError::Forbidden("DDL")),
        Statement::Set(_) => Err(GuardError::Forbidden("SET")),
        Statement::Grant(_) | Statement::Revoke(_) => Err(GuardError::Forbidden("GRANT/REVOKE")),
        Statement::StartTransaction { .. } | Statement::Commit { .. } | Statement::Rollback { .. } => {
            Err(GuardError::Forbidden("Transaction control"))
        }
        Statement::Copy { .. } | Statement::CopyIntoSnowflake { .. } => Err(GuardError::Forbidden("COPY")),
        Statement::Pragma { .. } => Err(GuardError::Forbidden("PRAGMA")),
        Statement::Call(_) | Statement::Execute { .. } | Statement::Prepare { .. } => {
            Err(GuardError::Forbidden("Procedure/prepared"))
        }
        _ => Err(GuardError::Forbidden("Utility and DDL")),
    }
}

/// Every relation the statement reads or writes, excluding CTE names
/// (the CTE bodies' own relations are still included).
pub fn referenced_tables(statement: &Statement) -> Vec<ObjectName> {
    let scan = scan(statement);
    let mut names: Vec<ObjectName> = Vec::new();
    let _ = visit_relations(statement, |name: &ObjectName| {
        names.push(name.clone());
        ControlFlow::<()>::Continue(())
    });
    // Multi-table DELETE (`DELETE t1 FROM t1 JOIN ...`) lists targets that
    // are not marked as relations by the parser.
    if let Statement::Delete(delete) = statement {
        names.extend(delete.tables.iter().cloned());
    }
    names.retain(|name| {
        !(name.0.len() == 1
            && last_ident(name).is_some_and(|ident| scan.cte_names.contains(&ident.to_lowercase())))
    });
    names
}

fn display_parts(parts: &[String]) -> String {
    parts.join(".")
}

fn resolve_parts(share: &Share, parts: &[String]) -> Result<TableKey, GuardError> {
    match (share.db_type, parts) {
        (_, [table]) => Ok(TableKey::new(&share.default_schema, table)),
        (DbType::Postgres, [schema, table]) | (DbType::MySql, [schema, table]) => Ok(TableKey::new(schema, table)),
        (DbType::Sqlite, [schema, table]) if schema.eq_ignore_ascii_case("main") => Ok(TableKey::new("main", table)),
        (DbType::Postgres, [database, schema, table]) if database.eq_ignore_ascii_case(&share.database) => {
            Ok(TableKey::new(schema, table))
        }
        _ => Err(GuardError::UnsupportedQualifier(display_parts(parts))),
    }
}

/// Resolve a parsed relation name to an allowlist key.
pub fn resolve(share: &Share, name: &ObjectName) -> Result<TableKey, GuardError> {
    let mut parts: Vec<String> = Vec::with_capacity(name.0.len());
    for part in &name.0 {
        match part {
            ObjectNamePart::Identifier(ident) => parts.push(ident.value.clone()),
            ObjectNamePart::Function(_) => {
                return Err(GuardError::UnsupportedQualifier(name.to_string()));
            }
        }
    }
    resolve_parts(share, &parts)
}

fn strip_quotes(part: &str) -> String {
    let trimmed = part.trim();
    let unquoted = trimmed
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .or_else(|| trimmed.strip_prefix('`').and_then(|s| s.strip_suffix('`')))
        .or_else(|| trimmed.strip_prefix('[').and_then(|s| s.strip_suffix(']')))
        .unwrap_or(trimmed);
    unquoted.to_string()
}

/// Resolve a raw table argument (as an agent passes it to `describe_table`),
/// optionally qualified and/or quoted, to an allowlist key.
pub fn resolve_table_ref(share: &Share, raw: &str) -> Result<TableKey, GuardError> {
    let parts: Vec<String> = raw.split('.').map(strip_quotes).filter(|p| !p.is_empty()).collect();
    if parts.is_empty() {
        return Err(GuardError::Empty);
    }
    let key = resolve_parts(share, &parts)?;
    ensure_allowed(share, key, &display_parts(&parts))
}

fn ensure_allowed(share: &Share, key: TableKey, display: &str) -> Result<TableKey, GuardError> {
    if share.allows(&key) {
        Ok(key)
    } else {
        Err(GuardError::TableNotAllowed {
            table: display.to_string(),
            shared: share.table_list(),
        })
    }
}

/// Full check of one SQL string against the share's rules.
pub fn check(share: &Share, sql: &str) -> Result<Verdict, GuardError> {
    let statement = parse_single(sql, share.db_type)?;
    let kind = classify(&statement)?;
    if share.read_only && kind == Kind::Write {
        return Err(GuardError::WriteInReadOnly);
    }
    if let Some(function) = scan(&statement).denied_function {
        return Err(GuardError::FunctionNotAllowed(function));
    }
    for name in referenced_tables(&statement) {
        let key = resolve(share, &name)?;
        ensure_allowed(share, key, &name.to_string())?;
    }
    Ok(Verdict { kind })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::share::types::{AllowedTable, DbType};
    use chrono::Utc;
    use std::collections::HashSet;

    fn share(db: DbType, read_only: bool, tables: &[(&str, &str)]) -> Share {
        let default_schema = match db {
            DbType::Postgres => "public",
            DbType::MySql => "app",
            DbType::Sqlite => "main",
        };
        let tables: Vec<AllowedTable> = tables
            .iter()
            .map(|(schema, name)| AllowedTable {
                schema: if schema.is_empty() { default_schema.to_string() } else { schema.to_string() },
                name: name.to_string(),
                kind: "table".into(),
            })
            .collect();
        let allowed: HashSet<TableKey> = tables.iter().map(|t| TableKey::new(&t.schema, &t.name)).collect();
        Share {
            id: "s1".into(),
            token: "t".into(),
            connection_id: "c1".into(),
            connection_name: "Test".into(),
            db_type: db,
            database: "app".into(),
            default_schema: default_schema.into(),
            full_database: false,
            allowed,
            tables,
            read_only,
            max_rows: 100,
            timeout_ms: 5_000,
            created_at: Utc::now(),
            conn: tokio::sync::Mutex::new(None),
            stats: Default::default(),
        }
    }

    fn pg_ro() -> Share {
        share(DbType::Postgres, true, &[("", "users"), ("", "orders"), ("sales", "invoices")])
    }

    fn pg_rw() -> Share {
        share(DbType::Postgres, false, &[("", "users"), ("", "orders")])
    }

    fn full_db(db: DbType, read_only: bool) -> Share {
        let mut share = share(db, read_only, &[]);
        share.full_database = true;
        share
    }

    #[test]
    fn full_database_allows_unlisted_and_new_tables_but_keeps_sql_rules() {
        let share = full_db(DbType::Postgres, true);
        assert!(check(&share, "SELECT * FROM public.new_table").is_ok());
        assert!(check(&share, "SELECT * FROM sales.orders").is_ok());
        assert!(matches!(check(&share, "DELETE FROM public.new_table"), Err(GuardError::WriteInReadOnly)));
        assert!(matches!(check(&share, "DROP TABLE public.new_table"), Err(GuardError::Forbidden(_))));
        assert!(matches!(check(&share, "SELECT * FROM other.sales.orders"), Err(GuardError::UnsupportedQualifier(_))));
    }

    #[test]
    fn full_mysql_database_does_not_grant_other_databases() {
        let share = full_db(DbType::MySql, false);
        assert!(check(&share, "SELECT * FROM app.new_table").is_ok());
        assert!(check(&share, "INSERT INTO new_table (id) VALUES (1)").is_ok());
        assert!(matches!(check(&share, "SELECT * FROM other.users"), Err(GuardError::TableNotAllowed { .. })));
    }

    fn tables(sql: &str, db: DbType) -> Vec<String> {
        let statement = parse_single(sql, db).unwrap();
        let mut names: Vec<String> = referenced_tables(&statement).iter().map(|n| n.to_string().to_lowercase()).collect();
        names.sort();
        names.dedup();
        names
    }

    fn kind(sql: &str, db: DbType) -> Result<Kind, GuardError> {
        classify(&parse_single(sql, db).unwrap())
    }

    // --- parsing -----------------------------------------------------------

    #[test]
    fn rejects_multiple_empty_and_garbage_statements() {
        assert_eq!(parse_single("SELECT 1; SELECT 2", DbType::Postgres).unwrap_err(), GuardError::MultipleStatements(2));
        assert_eq!(parse_single("   ", DbType::Postgres).unwrap_err(), GuardError::Empty);
        assert!(matches!(parse_single("SELEC * FRM users", DbType::Postgres).unwrap_err(), GuardError::Parse(_)));
        assert!(parse_single("SELECT 1;", DbType::Postgres).is_ok());
    }

    // --- referenced tables -------------------------------------------------

    #[test]
    fn collects_tables_from_joins_and_subqueries() {
        let sql = "SELECT u.id FROM users u JOIN orders o ON o.user_id = u.id \
                   WHERE u.id IN (SELECT user_id FROM payments) \
                   AND (SELECT count(*) FROM audit_log) > 0";
        assert_eq!(tables(sql, DbType::Postgres), vec!["audit_log", "orders", "payments", "users"]);
    }

    #[test]
    fn excludes_cte_names_but_keeps_their_bodies() {
        let sql = "WITH recent AS (SELECT * FROM orders WHERE created_at > now()) \
                   SELECT * FROM recent JOIN users ON users.id = recent.user_id";
        assert_eq!(tables(sql, DbType::Postgres), vec!["orders", "users"]);
    }

    #[test]
    fn collects_write_targets() {
        assert_eq!(tables("INSERT INTO users (name) SELECT name FROM staging", DbType::Postgres), vec!["staging", "users"]);
        assert_eq!(tables("UPDATE users SET x = 1 FROM orders WHERE orders.user_id = users.id", DbType::Postgres), vec!["orders", "users"]);
        assert_eq!(tables("DELETE FROM users USING orders WHERE orders.user_id = users.id", DbType::Postgres), vec!["orders", "users"]);
        assert_eq!(
            tables("MERGE INTO users u USING staging s ON u.id = s.id WHEN MATCHED THEN UPDATE SET name = s.name", DbType::Postgres),
            vec!["staging", "users"]
        );
    }

    #[test]
    fn handles_dialect_quoting_and_qualification() {
        assert_eq!(tables("SELECT * FROM `app`.`users` u JOIN `orders` o ON 1=1", DbType::MySql), vec!["`app`.`users`", "`orders`"]);
        assert_eq!(tables("SELECT * FROM \"Users\"", DbType::Postgres), vec!["\"users\""]);
        assert_eq!(tables("SELECT * FROM app.public.users", DbType::Postgres), vec!["app.public.users"]);
        assert_eq!(tables("SELECT * FROM main.users", DbType::Sqlite), vec!["main.users"]);
    }

    // --- classification ----------------------------------------------------

    #[test]
    fn classifies_reads() {
        for sql in [
            "SELECT * FROM users",
            "WITH x AS (SELECT 1) SELECT * FROM x",
            "VALUES (1), (2)",
            "EXPLAIN SELECT * FROM users",
            "SELECT * FROM users UNION ALL SELECT * FROM users",
        ] {
            assert_eq!(kind(sql, DbType::Postgres).unwrap(), Kind::Read, "{sql}");
        }
        assert_eq!(kind("EXPLAIN QUERY PLAN SELECT * FROM users", DbType::Sqlite).unwrap(), Kind::Read);
    }

    #[test]
    fn classifies_writes() {
        for sql in [
            "INSERT INTO users (id) VALUES (1)",
            "UPDATE users SET id = 1",
            "DELETE FROM users",
            "WITH d AS (DELETE FROM orders RETURNING *) SELECT * FROM d",
            "SELECT * FROM users FOR UPDATE",
            "MERGE INTO users u USING orders o ON u.id = o.user_id WHEN MATCHED THEN DELETE",
        ] {
            assert_eq!(kind(sql, DbType::Postgres).unwrap(), Kind::Write, "{sql}");
        }
    }

    #[test]
    fn forbids_everything_else() {
        for sql in [
            "EXPLAIN ANALYZE SELECT * FROM users",
            "SELECT * INTO backup FROM users",
            "CREATE TABLE t (id int)",
            "DROP TABLE users",
            "ALTER TABLE users ADD COLUMN x int",
            "TRUNCATE users",
            "SET search_path = public",
            "COPY users TO '/tmp/x'",
            "GRANT SELECT ON users TO bob",
            "BEGIN",
            "COMMIT",
            "CALL do_thing()",
            "CREATE INDEX i ON users (id)",
        ] {
            assert!(matches!(kind(sql, DbType::Postgres), Err(GuardError::Forbidden(_))), "{sql}");
        }
        assert!(matches!(kind("PRAGMA foreign_keys = 0", DbType::Sqlite), Err(GuardError::Forbidden(_))));
        assert!(matches!(kind("SHOW TABLES", DbType::MySql), Err(GuardError::Forbidden(_))));
        assert!(matches!(kind("USE other", DbType::MySql), Err(GuardError::Forbidden(_))));
    }

    // --- full check --------------------------------------------------------

    #[test]
    fn read_only_share_rejects_writes_on_allowed_tables() {
        assert_eq!(check(&pg_ro(), "UPDATE users SET name = 'x'").unwrap_err(), GuardError::WriteInReadOnly);
        assert_eq!(check(&pg_rw(), "UPDATE users SET name = 'x'").unwrap().kind, Kind::Write);
    }

    #[test]
    fn rejects_tables_outside_the_allowlist() {
        let err = check(&pg_rw(), "UPDATE payments SET amount = 0").unwrap_err();
        assert_eq!(
            err,
            GuardError::TableNotAllowed { table: "payments".into(), shared: "users, orders".into() }
        );
        assert!(matches!(
            check(&pg_ro(), "SELECT * FROM users u JOIN payments p ON p.user_id = u.id"),
            Err(GuardError::TableNotAllowed { .. })
        ));
        assert!(matches!(
            check(&pg_ro(), "SELECT * FROM information_schema.tables"),
            Err(GuardError::TableNotAllowed { .. })
        ));
    }

    #[test]
    fn matches_case_insensitively_and_across_qualification() {
        let share = pg_ro();
        assert!(check(&share, "SELECT * FROM USERS").is_ok());
        assert!(check(&share, "SELECT * FROM \"Users\"").is_ok());
        assert!(check(&share, "SELECT * FROM public.users").is_ok());
        assert!(check(&share, "SELECT * FROM app.public.users").is_ok());
        assert!(check(&share, "SELECT * FROM sales.invoices").is_ok());
        assert!(matches!(check(&share, "SELECT * FROM invoices"), Err(GuardError::TableNotAllowed { .. })));
        assert!(matches!(
            check(&share, "SELECT * FROM otherdb.public.users"),
            Err(GuardError::UnsupportedQualifier(_))
        ));
    }

    #[test]
    fn sqlite_and_mysql_qualifiers() {
        let sqlite = share(DbType::Sqlite, true, &[("", "users")]);
        assert!(check(&sqlite, "SELECT * FROM main.users").is_ok());
        assert!(matches!(check(&sqlite, "SELECT * FROM temp.users"), Err(GuardError::UnsupportedQualifier(_))));

        let mysql = share(DbType::MySql, true, &[("", "users")]);
        assert!(check(&mysql, "SELECT * FROM `app`.`users`").is_ok());
        assert!(matches!(check(&mysql, "SELECT * FROM otherdb.users"), Err(GuardError::TableNotAllowed { .. })));
    }

    #[test]
    fn denies_side_effect_functions() {
        assert_eq!(check(&pg_ro(), "SELECT pg_sleep(10)").unwrap_err(), GuardError::FunctionNotAllowed("pg_sleep".into()));
        assert_eq!(
            check(&pg_ro(), "SELECT * FROM users WHERE pg_terminate_backend(1)").unwrap_err(),
            GuardError::FunctionNotAllowed("pg_terminate_backend".into())
        );
        assert!(check(&pg_ro(), "SELECT count(*), now() FROM users").is_ok());
    }

    #[test]
    fn cte_shadowing_still_checks_the_body() {
        // The CTE named `payments` is fine; its body reads `orders`, which is shared.
        assert!(check(&pg_ro(), "WITH payments AS (SELECT * FROM orders) SELECT * FROM payments").is_ok());
        // But the body reading a non-shared table is rejected.
        assert!(matches!(
            check(&pg_ro(), "WITH x AS (SELECT * FROM secrets) SELECT * FROM x"),
            Err(GuardError::TableNotAllowed { .. })
        ));
    }

    #[test]
    fn resolves_raw_table_refs() {
        let share = pg_ro();
        assert_eq!(resolve_table_ref(&share, "users").unwrap(), TableKey::new("public", "users"));
        assert_eq!(resolve_table_ref(&share, "\"sales\".\"Invoices\"").unwrap(), TableKey::new("sales", "invoices"));
        assert!(matches!(resolve_table_ref(&share, "payments"), Err(GuardError::TableNotAllowed { .. })));
        assert_eq!(resolve_table_ref(&share, ""), Err(GuardError::Empty));
    }
}
