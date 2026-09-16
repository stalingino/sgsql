//! Account / privilege introspection for the User Management view.
//!
//! Both actions are read-only and hang off the `/schema/:connId/:action`
//! dispatcher. Mutations (CREATE USER, GRANT, …) are plain SQL built by the
//! frontend and applied through `/schema/:connId/apply`.

use serde_json::{json, Value};
use std::collections::BTreeMap;

use crate::db::{self, DbClient};
use crate::error::SidecarError;

use super::schema::s_of;

fn bool_of(v: &Value, key: &str) -> bool {
    match v.get(key).or_else(|| {
        v.as_object()?
            .iter()
            .find_map(|(candidate, value)| candidate.eq_ignore_ascii_case(key).then_some(value))
    }) {
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_i64().unwrap_or(0) != 0,
        Some(other) => {
            let text = s_of(&json!({ "v": other }), "v");
            matches!(text.to_ascii_lowercase().as_str(), "y" | "yes" | "t" | "true" | "1")
        }
        None => false,
    }
}

fn int_of(v: &Value, key: &str) -> Option<i64> {
    match v.get(key) {
        Some(Value::Number(n)) => n.as_i64(),
        Some(other) => s_of(&json!({ "v": other }), "v").parse().ok(),
        None => None,
    }
}

/// MySQL string literal (used for SHOW GRANTS, which cannot be prepared).
fn mysql_literal(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "\\'"))
}

/// `information_schema.*_PRIVILEGES.GRANTEE` is stored as `'user'@'host'`.
fn mysql_grantee(user: &str, host: &str) -> String {
    format!("'{}'@'{}'", user.replace('\'', "\\'"), host.replace('\'', "\\'"))
}

/// Split a GRANTEE of the form `'user'@'host'` back into its parts.
fn split_grantee(grantee: &str) -> (String, String) {
    let unquote = |s: &str| s.trim().trim_matches('\'').replace("\\'", "'");
    match grantee.rfind("'@'") {
        Some(idx) => (unquote(&grantee[..idx + 1]), unquote(&grantee[idx + 2..])),
        None => (unquote(grantee), "%".to_string()),
    }
}

/// Group `(target, privilege, grantable)` rows into one entry per target.
struct GrantAcc {
    privileges: Vec<String>,
    with_grant: bool,
}

fn push_grant(acc: &mut BTreeMap<String, GrantAcc>, key: String, privilege: String, grantable: bool) {
    let entry = acc.entry(key).or_insert(GrantAcc { privileges: Vec::new(), with_grant: false });
    if !privilege.is_empty() && !entry.privileges.contains(&privilege) {
        entry.privileges.push(privilege);
    }
    entry.with_grant |= grantable;
}

// ---------------------------------------------------------------------------
// GET /schema/:connId/users
// ---------------------------------------------------------------------------

pub async fn get_users(client: &DbClient, conn_id: &str, trace_db: &str) -> Result<Value, SidecarError> {
    match client {
        DbClient::MySql { .. } => mysql_users(client, conn_id, trace_db).await,
        DbClient::Postgres { .. } => pg_users(client, conn_id, trace_db).await,
        DbClient::Sqlite { .. } => Ok(json!({ "users": [], "partial": false })),
    }
}

async fn mysql_users(client: &DbClient, conn_id: &str, trace_db: &str) -> Result<Value, SidecarError> {
    // Roles (MySQL 8+). Missing table on older servers is not an error.
    let mut roles: BTreeMap<(String, String), Vec<String>> = BTreeMap::new();
    if let Ok(rows) = db::mysql_fetch(
        client,
        conn_id,
        trace_db,
        "SELECT FROM_USER, FROM_HOST, TO_USER, TO_HOST FROM mysql.role_edges",
        &[],
    )
    .await
    {
        for row in &rows {
            let key = (s_of(row, "TO_USER"), s_of(row, "TO_HOST"));
            let from_host = s_of(row, "FROM_HOST");
            let role = if from_host == "%" { s_of(row, "FROM_USER") } else { format!("{}@{}", s_of(row, "FROM_USER"), from_host) };
            roles.entry(key).or_default().push(role);
        }
    }

    let full = db::mysql_fetch(
        client,
        conn_id,
        trace_db,
        "SELECT User, Host, Super_priv, account_locked, password_expired, plugin, max_user_connections \
         FROM mysql.user ORDER BY User, Host",
        &[],
    )
    .await;

    match full {
        Ok(rows) => {
            let users: Vec<Value> = rows
                .iter()
                .map(|row| {
                    let name = s_of(row, "User");
                    let host = s_of(row, "Host");
                    let user_roles = roles.get(&(name.clone(), host.clone())).cloned().unwrap_or_default();
                    let conn_limit = int_of(row, "max_user_connections").unwrap_or(0);
                    json!({
                        "name": name,
                        "host": host,
                        "canLogin": true,
                        "superuser": bool_of(row, "Super_priv"),
                        "locked": bool_of(row, "account_locked"),
                        "passwordExpired": bool_of(row, "password_expired"),
                        "authPlugin": s_of(row, "plugin"),
                        "connLimit": if conn_limit > 0 { Value::from(conn_limit) } else { Value::Null },
                        "roles": user_roles,
                    })
                })
                .collect();
            Ok(json!({ "users": users, "partial": false }))
        }
        Err(error) => {
            // No SELECT on mysql.user: fall back to the accounts visible through
            // information_schema, which every login can read for itself and for
            // any account it has privileges over.
            println!("[sidecar] mysql.user not readable ({error}), using information_schema fallback");
            let rows = db::mysql_fetch(
                client,
                conn_id,
                trace_db,
                "SELECT DISTINCT GRANTEE FROM information_schema.USER_PRIVILEGES ORDER BY GRANTEE",
                &[],
            )
            .await?;
            let users: Vec<Value> = rows
                .iter()
                .map(|row| {
                    let (name, host) = split_grantee(&s_of(row, "GRANTEE"));
                    let user_roles = roles.get(&(name.clone(), host.clone())).cloned().unwrap_or_default();
                    json!({
                        "name": name,
                        "host": host,
                        "canLogin": true,
                        "superuser": false,
                        "locked": false,
                        "roles": user_roles,
                    })
                })
                .collect();
            Ok(json!({ "users": users, "partial": true }))
        }
    }
}

async fn pg_users(client: &DbClient, conn_id: &str, trace_db: &str) -> Result<Value, SidecarError> {
    let rows = db::pg_fetch(
        client,
        conn_id,
        trace_db,
        "SELECT r.rolname, r.rolsuper, r.rolinherit, r.rolcreaterole, r.rolcreatedb, r.rolcanlogin, \
                r.rolreplication, r.rolbypassrls, r.rolconnlimit, r.rolvaliduntil::text AS valid_until, \
                array_to_string(ARRAY( \
                  SELECT g.rolname FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid \
                  WHERE m.member = r.oid ORDER BY g.rolname), E'\\n') AS member_of, \
                array_to_string(ARRAY( \
                  SELECT g.rolname FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid \
                  WHERE m.member = r.oid AND m.admin_option ORDER BY g.rolname), E'\\n') AS admin_of \
         FROM pg_roles r WHERE r.rolname NOT LIKE 'pg\\_%' ORDER BY r.rolname",
        &[],
    )
    .await?;

    let split_lines = |text: String| -> Vec<String> { text.lines().filter(|l| !l.is_empty()).map(str::to_string).collect() };

    let users: Vec<Value> = rows
        .iter()
        .map(|row| {
            let conn_limit = int_of(row, "rolconnlimit").unwrap_or(-1);
            let valid_until = s_of(row, "valid_until");
            let can_login = bool_of(row, "rolcanlogin");
            json!({
                "name": s_of(row, "rolname"),
                "canLogin": can_login,
                "superuser": bool_of(row, "rolsuper"),
                "locked": false,
                "inherit": bool_of(row, "rolinherit"),
                "createRole": bool_of(row, "rolcreaterole"),
                "createDb": bool_of(row, "rolcreatedb"),
                "replication": bool_of(row, "rolreplication"),
                "bypassRls": bool_of(row, "rolbypassrls"),
                "connLimit": if conn_limit >= 0 { Value::from(conn_limit) } else { Value::Null },
                "validUntil": if valid_until.is_empty() || valid_until == "infinity" { Value::Null } else { Value::from(valid_until) },
                "roles": split_lines(s_of(row, "member_of")),
                "adminOf": split_lines(s_of(row, "admin_of")),
            })
        })
        .collect();
    Ok(json!({ "users": users, "partial": false }))
}

// ---------------------------------------------------------------------------
// GET /schema/:connId/user-grants?user=&host=
// ---------------------------------------------------------------------------

pub async fn get_user_grants(
    client: &DbClient,
    conn_id: &str,
    trace_db: &str,
    user: &str,
    host: Option<&str>,
) -> Result<Value, SidecarError> {
    match client {
        DbClient::MySql { .. } => mysql_user_grants(client, conn_id, trace_db, user, host.unwrap_or("%")).await,
        DbClient::Postgres { .. } => pg_user_grants(client, conn_id, trace_db, user).await,
        DbClient::Sqlite { .. } => Err(SidecarError::msg("SQLite has no user accounts")),
    }
}

async fn mysql_user_grants(
    client: &DbClient,
    conn_id: &str,
    trace_db: &str,
    user: &str,
    host: &str,
) -> Result<Value, SidecarError> {
    let grantee = mysql_grantee(user, host);

    // Global (*.*)
    let rows = db::mysql_fetch(
        client,
        conn_id,
        trace_db,
        "SELECT PRIVILEGE_TYPE, IS_GRANTABLE FROM information_schema.USER_PRIVILEGES WHERE GRANTEE = ? ORDER BY PRIVILEGE_TYPE",
        &[&grantee],
    )
    .await?;
    let mut global = GrantAcc { privileges: Vec::new(), with_grant: false };
    for row in &rows {
        let privilege = s_of(row, "PRIVILEGE_TYPE");
        // USAGE is MySQL's "no privileges" placeholder, not something to edit.
        if privilege != "USAGE" {
            global.privileges.push(privilege);
        }
        global.with_grant |= bool_of(row, "IS_GRANTABLE");
    }

    // Database (db.*)
    let rows = db::mysql_fetch(
        client,
        conn_id,
        trace_db,
        "SELECT TABLE_SCHEMA, PRIVILEGE_TYPE, IS_GRANTABLE FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE = ? ORDER BY TABLE_SCHEMA, PRIVILEGE_TYPE",
        &[&grantee],
    )
    .await?;
    let mut databases: BTreeMap<String, GrantAcc> = BTreeMap::new();
    for row in &rows {
        push_grant(&mut databases, s_of(row, "TABLE_SCHEMA"), s_of(row, "PRIVILEGE_TYPE"), bool_of(row, "IS_GRANTABLE"));
    }

    // Table (db.tbl)
    let rows = db::mysql_fetch(
        client,
        conn_id,
        trace_db,
        "SELECT TABLE_SCHEMA, TABLE_NAME, PRIVILEGE_TYPE, IS_GRANTABLE FROM information_schema.TABLE_PRIVILEGES WHERE GRANTEE = ? ORDER BY TABLE_SCHEMA, TABLE_NAME, PRIVILEGE_TYPE",
        &[&grantee],
    )
    .await?;
    let mut tables: BTreeMap<String, GrantAcc> = BTreeMap::new();
    for row in &rows {
        let key = format!("{}\u{0}{}", s_of(row, "TABLE_SCHEMA"), s_of(row, "TABLE_NAME"));
        push_grant(&mut tables, key, s_of(row, "PRIVILEGE_TYPE"), bool_of(row, "IS_GRANTABLE"));
    }

    // Column (read-only in the UI)
    let rows = db::mysql_fetch(
        client,
        conn_id,
        trace_db,
        "SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, PRIVILEGE_TYPE FROM information_schema.COLUMN_PRIVILEGES WHERE GRANTEE = ? ORDER BY TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, PRIVILEGE_TYPE",
        &[&grantee],
    )
    .await?;
    let mut columns: BTreeMap<String, GrantAcc> = BTreeMap::new();
    for row in &rows {
        let key = format!("{}\u{0}{}\u{0}{}", s_of(row, "TABLE_SCHEMA"), s_of(row, "TABLE_NAME"), s_of(row, "COLUMN_NAME"));
        push_grant(&mut columns, key, s_of(row, "PRIVILEGE_TYPE"), false);
    }

    // Routines (read-only; mysql.procs_priv may not be readable)
    let mut routines: Vec<Value> = Vec::new();
    if let Ok(rows) = db::mysql_fetch(
        client,
        conn_id,
        trace_db,
        "SELECT Db, Routine_name, Routine_type, Proc_priv FROM mysql.procs_priv WHERE User = ? AND Host = ? ORDER BY Db, Routine_name",
        &[user, host],
    )
    .await
    {
        for row in &rows {
            let privileges: Vec<String> = s_of(row, "Proc_priv")
                .split(',')
                .map(|p| p.trim().to_ascii_uppercase())
                .filter(|p| !p.is_empty())
                .collect();
            routines.push(json!({
                "db": s_of(row, "Db"),
                "name": s_of(row, "Routine_name"),
                "kind": s_of(row, "Routine_type"),
                "privileges": privileges,
            }));
        }
    }

    // Raw SHOW GRANTS (single dynamic column)
    let show = format!("SHOW GRANTS FOR {}@{}", mysql_literal(user), mysql_literal(host));
    let raw: Vec<String> = match db::fetch_raw(client, conn_id, trace_db, &show).await {
        Ok(output) => output
            .rows
            .into_iter()
            .filter_map(|row| row.into_iter().next())
            .map(|cell| s_of(&json!({ "v": cell }), "v"))
            .collect(),
        Err(_) => Vec::new(),
    };

    let split2 = |key: &str| -> (String, String) {
        let mut parts = key.splitn(2, '\u{0}');
        (parts.next().unwrap_or_default().to_string(), parts.next().unwrap_or_default().to_string())
    };

    Ok(json!({
        "global": { "privileges": global.privileges, "withGrant": global.with_grant },
        "databases": databases.iter().map(|(db, acc)| json!({ "db": db, "privileges": acc.privileges, "withGrant": acc.with_grant })).collect::<Vec<_>>(),
        "schemas": [],
        "tables": tables.iter().map(|(key, acc)| { let (db, table) = split2(key); json!({ "db": db, "schema": "", "table": table, "privileges": acc.privileges, "withGrant": acc.with_grant }) }).collect::<Vec<_>>(),
        "columns": columns.iter().map(|(key, acc)| {
            let mut parts = key.splitn(3, '\u{0}');
            let db = parts.next().unwrap_or_default();
            let table = parts.next().unwrap_or_default();
            let column = parts.next().unwrap_or_default();
            json!({ "db": db, "schema": "", "table": table, "column": column, "privileges": acc.privileges })
        }).collect::<Vec<_>>(),
        "routines": routines,
        "raw": raw,
        "hostAccess": Value::Null,
        "objectScope": Value::Null,
    }))
}

async fn pg_user_grants(client: &DbClient, conn_id: &str, trace_db: &str, role: &str) -> Result<Value, SidecarError> {
    // Database-level ACLs are cluster-wide, so every database is visible here.
    let rows = db::pg_fetch(
        client,
        conn_id,
        trace_db,
        "SELECT d.datname, a.privilege_type, a.is_grantable \
         FROM pg_database d, aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) a \
         JOIN pg_roles g ON g.oid = a.grantee \
         WHERE NOT d.datistemplate AND g.rolname = $1 \
         ORDER BY d.datname, a.privilege_type",
        &[role],
    )
    .await?;
    let mut databases: BTreeMap<String, GrantAcc> = BTreeMap::new();
    for row in &rows {
        push_grant(&mut databases, s_of(row, "datname"), s_of(row, "privilege_type"), bool_of(row, "is_grantable"));
    }

    // Schema / table / column / routine grants exist only in the connected
    // database's catalog.
    let current_db_row = db::pg_fetch(client, conn_id, trace_db, "SELECT current_database() AS db", &[]).await?;
    let current_db = current_db_row.first().map(|r| s_of(r, "db")).unwrap_or_default();

    let rows = db::pg_fetch(
        client,
        conn_id,
        trace_db,
        "SELECT n.nspname, a.privilege_type, a.is_grantable \
         FROM pg_namespace n, aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) a \
         JOIN pg_roles g ON g.oid = a.grantee \
         WHERE g.rolname = $1 AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND n.nspname NOT LIKE 'pg\\_temp%' \
         ORDER BY n.nspname, a.privilege_type",
        &[role],
    )
    .await?;
    let mut schemas: BTreeMap<String, GrantAcc> = BTreeMap::new();
    for row in &rows {
        push_grant(&mut schemas, s_of(row, "nspname"), s_of(row, "privilege_type"), bool_of(row, "is_grantable"));
    }

    let rows = db::pg_fetch(
        client,
        conn_id,
        trace_db,
        "SELECT table_schema, table_name, privilege_type, is_grantable \
         FROM information_schema.role_table_grants \
         WHERE grantee = $1 AND table_schema NOT IN ('pg_catalog', 'information_schema') \
         ORDER BY table_schema, table_name, privilege_type",
        &[role],
    )
    .await?;
    let mut tables: BTreeMap<String, GrantAcc> = BTreeMap::new();
    for row in &rows {
        let key = format!("{}\u{0}{}", s_of(row, "table_schema"), s_of(row, "table_name"));
        push_grant(&mut tables, key, s_of(row, "privilege_type"), bool_of(row, "is_grantable"));
    }

    let rows = db::pg_fetch(
        client,
        conn_id,
        trace_db,
        "SELECT table_schema, table_name, column_name, privilege_type \
         FROM information_schema.role_column_grants \
         WHERE grantee = $1 AND table_schema NOT IN ('pg_catalog', 'information_schema') \
         ORDER BY table_schema, table_name, column_name, privilege_type",
        &[role],
    )
    .await?;
    let mut columns: BTreeMap<String, GrantAcc> = BTreeMap::new();
    for row in &rows {
        let key = format!("{}\u{0}{}\u{0}{}", s_of(row, "table_schema"), s_of(row, "table_name"), s_of(row, "column_name"));
        push_grant(&mut columns, key, s_of(row, "privilege_type"), false);
    }

    let rows = db::pg_fetch(
        client,
        conn_id,
        trace_db,
        "SELECT routine_schema, routine_name, privilege_type \
         FROM information_schema.role_routine_grants \
         WHERE grantee = $1 AND routine_schema NOT IN ('pg_catalog', 'information_schema') \
         ORDER BY routine_schema, routine_name",
        &[role],
    )
    .await?;
    let mut routines: BTreeMap<String, GrantAcc> = BTreeMap::new();
    for row in &rows {
        let key = format!("{}\u{0}{}", s_of(row, "routine_schema"), s_of(row, "routine_name"));
        push_grant(&mut routines, key, s_of(row, "privilege_type"), false);
    }

    // pg_hba rules need superuser / pg_read_server_files; absent otherwise.
    let host_access: Value = match db::pg_fetch(
        client,
        conn_id,
        trace_db,
        "SELECT type, array_to_string(database, ',') AS database, array_to_string(user_name, ',') AS user_name, \
                COALESCE(address, '') AS address, COALESCE(netmask, '') AS netmask, auth_method \
         FROM pg_hba_file_rules WHERE error IS NULL ORDER BY line_number",
        &[],
    )
    .await
    {
        Ok(rows) => Value::Array(
            rows.iter()
                .filter(|row| {
                    let users = s_of(row, "user_name");
                    users.split(',').any(|u| u == "all" || u == role || u.trim_start_matches('+') == role)
                })
                .map(|row| {
                    json!({
                        "type": s_of(row, "type"),
                        "database": s_of(row, "database"),
                        "user": s_of(row, "user_name"),
                        "address": s_of(row, "address"),
                        "netmask": s_of(row, "netmask"),
                        "method": s_of(row, "auth_method"),
                    })
                })
                .collect(),
        ),
        Err(_) => Value::Null,
    };

    // Rebuild GRANT statements for the raw tab.
    let qi = |s: &str| format!("\"{}\"", s.replace('"', "\"\""));
    let mut raw: Vec<String> = Vec::new();
    let grant_line = |privs: &[String], target: String, with_grant: bool| {
        format!(
            "GRANT {} ON {} TO {}{};",
            privs.join(", "),
            target,
            qi(role),
            if with_grant { " WITH GRANT OPTION" } else { "" }
        )
    };
    for (db, acc) in &databases {
        raw.push(grant_line(&acc.privileges, format!("DATABASE {}", qi(db)), acc.with_grant));
    }
    for (schema, acc) in &schemas {
        raw.push(grant_line(&acc.privileges, format!("SCHEMA {}", qi(schema)), acc.with_grant));
    }
    for (key, acc) in &tables {
        let mut parts = key.splitn(2, '\u{0}');
        let schema = parts.next().unwrap_or_default();
        let table = parts.next().unwrap_or_default();
        raw.push(grant_line(&acc.privileges, format!("TABLE {}.{}", qi(schema), qi(table)), acc.with_grant));
    }

    let split2 = |key: &str| -> (String, String) {
        let mut parts = key.splitn(2, '\u{0}');
        (parts.next().unwrap_or_default().to_string(), parts.next().unwrap_or_default().to_string())
    };

    Ok(json!({
        "global": { "privileges": [], "withGrant": false },
        "databases": databases.iter().map(|(db, acc)| json!({ "db": db, "privileges": acc.privileges, "withGrant": acc.with_grant })).collect::<Vec<_>>(),
        "schemas": schemas.iter().map(|(schema, acc)| json!({ "db": current_db, "schema": schema, "privileges": acc.privileges, "withGrant": acc.with_grant })).collect::<Vec<_>>(),
        "tables": tables.iter().map(|(key, acc)| { let (schema, table) = split2(key); json!({ "db": current_db, "schema": schema, "table": table, "privileges": acc.privileges, "withGrant": acc.with_grant }) }).collect::<Vec<_>>(),
        "columns": columns.iter().map(|(key, acc)| {
            let mut parts = key.splitn(3, '\u{0}');
            let schema = parts.next().unwrap_or_default();
            let table = parts.next().unwrap_or_default();
            let column = parts.next().unwrap_or_default();
            json!({ "db": current_db, "schema": schema, "table": table, "column": column, "privileges": acc.privileges })
        }).collect::<Vec<_>>(),
        "routines": routines.iter().map(|(key, acc)| { let (schema, name) = split2(key); json!({ "db": current_db, "schema": schema, "name": name, "kind": "ROUTINE", "privileges": acc.privileges }) }).collect::<Vec<_>>(),
        "raw": raw,
        "hostAccess": host_access,
        "objectScope": current_db,
    }))
}
