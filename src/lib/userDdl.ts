import type { DatabaseGrant, DbUser, SchemaGrant, ScopedGrant, TableGrant, UserGrants } from "./schema";
import { quoteIdent } from "./schemaDdl";

/* ── Types ──────────────────────────────────────────────── */

export type UserDialect = "postgres" | "mysql" | "oracle";

export type GrantScope = "global" | "database" | "schema" | "table";

/** Account attributes that map to CREATE/ALTER USER|ROLE options. */
export interface AccountAttributes {
  canLogin: boolean;
  superuser: boolean;
  locked: boolean;
  inherit: boolean;
  createRole: boolean;
  createDb: boolean;
  replication: boolean;
  bypassRls: boolean;
  /** null = unlimited. */
  connLimit: number | null;
  /** ISO-ish timestamp accepted by the server, or null = never expires. */
  validUntil: string | null;
}

/** The grant scopes the wizard can edit; column/routine grants stay read-only. */
export interface EditableGrants {
  global: ScopedGrant;
  databases: DatabaseGrant[];
  schemas: SchemaGrant[];
  tables: TableGrant[];
}

export interface AccountDraft {
  name: string;
  /** MySQL only. */
  host: string;
  /** Empty = leave unchanged (edit) / no password (create). */
  password: string;
  attrs: AccountAttributes;
  roles: string[];
  grants: EditableGrants;
}

/* ── Privilege vocabularies ─────────────────────────────── */

export const PRIVILEGES: Record<UserDialect, Record<GrantScope, string[]>> = {
  mysql: {
    global: [
      "SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER", "INDEX", "REFERENCES",
      "CREATE VIEW", "SHOW VIEW", "TRIGGER", "EVENT", "EXECUTE", "CREATE ROUTINE", "ALTER ROUTINE",
      "CREATE TEMPORARY TABLES", "LOCK TABLES", "CREATE USER", "CREATE ROLE", "DROP ROLE",
      "RELOAD", "PROCESS", "FILE", "SHOW DATABASES", "SUPER", "SHUTDOWN", "CREATE TABLESPACE",
      "REPLICATION CLIENT", "REPLICATION SLAVE",
    ],
    database: [
      "SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER", "INDEX", "REFERENCES",
      "CREATE VIEW", "SHOW VIEW", "TRIGGER", "EVENT", "EXECUTE", "CREATE ROUTINE", "ALTER ROUTINE",
      "CREATE TEMPORARY TABLES", "LOCK TABLES",
    ],
    schema: [],
    table: [
      "SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER", "INDEX", "REFERENCES",
      "CREATE VIEW", "SHOW VIEW", "TRIGGER",
    ],
  },
  postgres: {
    global: [],
    database: ["CONNECT", "CREATE", "TEMPORARY"],
    schema: ["USAGE", "CREATE"],
    table: ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"],
  },
  // Oracle: "global" holds system privileges; one database, no schema grants.
  oracle: {
    global: [
      "CREATE SESSION", "CREATE TABLE", "CREATE VIEW", "CREATE SEQUENCE", "CREATE PROCEDURE", "CREATE TRIGGER",
      "CREATE TYPE", "CREATE SYNONYM", "CREATE MATERIALIZED VIEW", "CREATE JOB", "UNLIMITED TABLESPACE",
      "SELECT ANY TABLE", "INSERT ANY TABLE", "UPDATE ANY TABLE", "DELETE ANY TABLE", "EXECUTE ANY PROCEDURE",
      "SELECT ANY DICTIONARY", "CREATE USER", "ALTER USER", "DROP USER", "CREATE ROLE", "GRANT ANY ROLE",
      "GRANT ANY PRIVILEGE", "ALTER SYSTEM", "ALTER SESSION",
    ],
    database: [],
    schema: [],
    table: ["SELECT", "READ", "INSERT", "UPDATE", "DELETE", "ALTER", "INDEX", "REFERENCES", "DEBUG"],
  },
};

/** Quick presets offered per scope row in the wizard. */
export function presetPrivileges(dialect: UserDialect, scope: GrantScope, preset: "read" | "readwrite" | "all"): string[] {
  const vocab = PRIVILEGES[dialect][scope];
  if (preset === "all") return [...vocab];
  if (dialect === "oracle") {
    if (scope === "global") {
      return preset === "read" ? ["CREATE SESSION"] : ["CREATE SESSION", "CREATE TABLE", "CREATE VIEW", "CREATE SEQUENCE", "CREATE PROCEDURE"];
    }
    return preset === "read" ? ["SELECT"] : ["SELECT", "INSERT", "UPDATE", "DELETE"];
  }
  if (dialect === "postgres") {
    if (scope === "database") return preset === "read" ? ["CONNECT"] : ["CONNECT", "TEMPORARY"];
    if (scope === "schema") return preset === "read" ? ["USAGE"] : ["USAGE", "CREATE"];
    return preset === "read" ? ["SELECT"] : ["SELECT", "INSERT", "UPDATE", "DELETE"];
  }
  const read = ["SELECT", "SHOW VIEW"].filter((p) => vocab.includes(p));
  return preset === "read" ? read : [...read, "INSERT", "UPDATE", "DELETE"];
}

/* ── Quoting helpers ────────────────────────────────────── */

/** Oracle stores unquoted names upper-case; keep simple new names that way. */
function oracleAccountName(name: string): string {
  return /^[A-Za-z][A-Za-z0-9_$#]*$/.test(name) ? name.toUpperCase() : name;
}

/** Oracle passwords are quoted as identifiers and may not contain `"`. */
function oraclePassword(password: string): string {
  if (password.includes('"')) throw new Error("Oracle passwords cannot contain double quotes.");
  return `"${password}"`;
}

export function quoteLiteral(dialect: UserDialect, value: string): string {
  return dialect === "mysql"
    ? `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`
    : `'${value.replace(/'/g, "''")}'`;
}

/** `'user'@'host'` (MySQL) or `"role"` (Postgres). */
export function accountRef(dialect: UserDialect, name: string, host = "%"): string {
  return dialect === "mysql"
    ? `${quoteLiteral(dialect, name)}@${quoteLiteral(dialect, host || "%")}`
    : quoteIdent(dialect, name);
}

/** Role references: MySQL roles are also accounts (`'r'@'%'`). */
function roleRef(dialect: UserDialect, role: string): string {
  if (dialect === "postgres" || dialect === "oracle") return quoteIdent(dialect, role);
  const at = role.lastIndexOf("@");
  return at > 0 ? accountRef(dialect, role.slice(0, at), role.slice(at + 1)) : accountRef(dialect, role, "%");
}

function grantTarget(dialect: UserDialect, scope: GrantScope, target: { db?: string; schema?: string; table?: string }): string {
  if (dialect === "mysql") {
    if (scope === "global") return "*.*";
    if (scope === "database") return `${quoteIdent(dialect, target.db ?? "")}.*`;
    return `${quoteIdent(dialect, target.db ?? "")}.${quoteIdent(dialect, target.table ?? "")}`;
  }
  if (dialect === "oracle") {
    // System privileges have no target; table grants name the object.
    if (scope === "global") return "";
    return target.schema
      ? `${quoteIdent(dialect, target.schema)}.${quoteIdent(dialect, target.table ?? "")}`
      : quoteIdent(dialect, target.table ?? "");
  }
  if (scope === "database") return `DATABASE ${quoteIdent(dialect, target.db ?? "")}`;
  if (scope === "schema") return `SCHEMA ${quoteIdent(dialect, target.schema ?? "")}`;
  return `TABLE ${quoteIdent(dialect, target.schema || "public")}.${quoteIdent(dialect, target.table ?? "")}`;
}

/* ── Attribute helpers ──────────────────────────────────── */

export function attributesOf(user: DbUser | null, dialect: UserDialect): AccountAttributes {
  return {
    canLogin: user?.canLogin ?? true,
    superuser: user?.superuser ?? false,
    locked: dialect === "postgres" ? !(user?.canLogin ?? true) : (user?.locked ?? false),
    inherit: user?.inherit ?? true,
    createRole: user?.createRole ?? false,
    createDb: user?.createDb ?? false,
    replication: user?.replication ?? false,
    bypassRls: user?.bypassRls ?? false,
    connLimit: user?.connLimit ?? null,
    validUntil: user?.validUntil ?? null,
  };
}

export function editableGrantsOf(grants: UserGrants | null): EditableGrants {
  return {
    global: { privileges: [...(grants?.global.privileges ?? [])], withGrant: grants?.global.withGrant ?? false },
    databases: (grants?.databases ?? []).map((g) => ({ ...g, privileges: [...g.privileges] })),
    schemas: (grants?.schemas ?? []).map((g) => ({ ...g, privileges: [...g.privileges] })),
    tables: (grants?.tables ?? []).map((g) => ({ ...g, privileges: [...g.privileges] })),
  };
}

export function emptyGrants(): EditableGrants {
  return { global: { privileges: [], withGrant: false }, databases: [], schemas: [], tables: [] };
}

/* ── Statement builders ─────────────────────────────────── */

function pgRoleOptions(attrs: AccountAttributes, before?: AccountAttributes): string[] {
  const changed = (key: keyof AccountAttributes) => !before || before[key] !== attrs[key];
  const options: string[] = [];
  if (changed("canLogin")) options.push(attrs.canLogin ? "LOGIN" : "NOLOGIN");
  if (changed("superuser")) options.push(attrs.superuser ? "SUPERUSER" : "NOSUPERUSER");
  if (changed("createDb")) options.push(attrs.createDb ? "CREATEDB" : "NOCREATEDB");
  if (changed("createRole")) options.push(attrs.createRole ? "CREATEROLE" : "NOCREATEROLE");
  if (changed("replication")) options.push(attrs.replication ? "REPLICATION" : "NOREPLICATION");
  if (changed("bypassRls")) options.push(attrs.bypassRls ? "BYPASSRLS" : "NOBYPASSRLS");
  if (changed("inherit")) options.push(attrs.inherit ? "INHERIT" : "NOINHERIT");
  if (changed("connLimit")) options.push(`CONNECTION LIMIT ${attrs.connLimit ?? -1}`);
  if (changed("validUntil")) options.push(`VALID UNTIL ${quoteLiteral("postgres", attrs.validUntil || "infinity")}`);
  return options;
}

export function buildCreateAccount(dialect: UserDialect, draft: AccountDraft): string[] {
  const name = dialect === "oracle" ? oracleAccountName(draft.name.trim()) : draft.name.trim();
  if (!name) throw new Error("User name is required");
  const ref = accountRef(dialect, name, draft.host);
  if (dialect === "oracle") {
    const auth = draft.password ? `IDENTIFIED BY ${oraclePassword(draft.password)}` : "NO AUTHENTICATION";
    return [`CREATE USER ${ref} ${auth}${draft.attrs.locked ? " ACCOUNT LOCK" : ""}`];
  }
  if (dialect === "mysql") {
    let sql = `CREATE USER ${ref}`;
    if (draft.password) sql += ` IDENTIFIED BY ${quoteLiteral(dialect, draft.password)}`;
    if (draft.attrs.connLimit != null && draft.attrs.connLimit > 0) sql += ` WITH MAX_USER_CONNECTIONS ${draft.attrs.connLimit}`;
    if (draft.attrs.locked) sql += " ACCOUNT LOCK";
    return [sql];
  }
  // Postgres: defaults for a fresh role are NOLOGIN/NOSUPERUSER/…; only spell
  // out what differs so the statement stays readable.
  const defaults: AccountAttributes = {
    canLogin: false, superuser: false, locked: false, inherit: true, createRole: false, createDb: false,
    replication: false, bypassRls: false, connLimit: null, validUntil: null,
  };
  const attrs = { ...draft.attrs, canLogin: draft.attrs.canLogin && !draft.attrs.locked };
  const options = pgRoleOptions(attrs, defaults);
  if (draft.password) options.push(`PASSWORD ${quoteLiteral(dialect, draft.password)}`);
  return [`CREATE ROLE ${ref}${options.length ? ` ${options.join(" ")}` : ""}`];
}

export function buildAlterAttributes(dialect: UserDialect, ref: string, before: AccountAttributes, after: AccountAttributes): string[] {
  if (dialect === "oracle") {
    return before.locked !== after.locked ? [`ALTER USER ${ref} ACCOUNT ${after.locked ? "LOCK" : "UNLOCK"}`] : [];
  }
  if (dialect === "mysql") {
    const parts: string[] = [];
    const limitBefore = before.connLimit ?? 0;
    const limitAfter = after.connLimit ?? 0;
    if (limitBefore !== limitAfter) parts.push(`WITH MAX_USER_CONNECTIONS ${limitAfter}`);
    if (before.locked !== after.locked) parts.push(after.locked ? "ACCOUNT LOCK" : "ACCOUNT UNLOCK");
    return parts.length ? [`ALTER USER ${ref} ${parts.join(" ")}`] : [];
  }
  const effectiveBefore = { ...before, canLogin: before.canLogin && !before.locked };
  const effectiveAfter = { ...after, canLogin: after.canLogin && !after.locked };
  const options = pgRoleOptions(effectiveAfter, effectiveBefore);
  return options.length ? [`ALTER ROLE ${ref} ${options.join(" ")}`] : [];
}

export function buildSetPassword(dialect: UserDialect, ref: string, password: string): string[] {
  if (!password) return [];
  if (dialect === "oracle") return [`ALTER USER ${ref} IDENTIFIED BY ${oraclePassword(password)}`];
  return dialect === "mysql"
    ? [`ALTER USER ${ref} IDENTIFIED BY ${quoteLiteral(dialect, password)}`]
    : [`ALTER ROLE ${ref} PASSWORD ${quoteLiteral(dialect, password)}`];
}

export function buildExpirePassword(dialect: UserDialect, ref: string): string[] {
  return dialect === "mysql" || dialect === "oracle"
    ? [`ALTER USER ${ref} PASSWORD EXPIRE`]
    : [`ALTER ROLE ${ref} VALID UNTIL 'now'`];
}

export function buildDropAccount(dialect: UserDialect, ref: string, options: { reassignTo?: string; isRole?: boolean } = {}): string[] {
  if (dialect === "mysql") return [`DROP USER ${ref}`];
  // Oracle refuses to drop a user who owns objects; that error is shown as-is.
  if (dialect === "oracle") return [options.isRole ? `DROP ROLE ${ref}` : `DROP USER ${ref}`];
  const statements: string[] = [];
  if (options.reassignTo) {
    statements.push(`REASSIGN OWNED BY ${ref} TO ${quoteIdent(dialect, options.reassignTo)}`);
    statements.push(`DROP OWNED BY ${ref}`);
  }
  statements.push(`DROP ROLE ${ref}`);
  return statements;
}

export function buildRoleDiff(dialect: UserDialect, ref: string, before: string[], after: string[]): string[] {
  const statements: string[] = [];
  const added = after.filter((role) => !before.includes(role));
  const removed = before.filter((role) => !after.includes(role));
  if (added.length) statements.push(`GRANT ${added.map((r) => roleRef(dialect, r)).join(", ")} TO ${ref}`);
  if (removed.length) statements.push(`REVOKE ${removed.map((r) => roleRef(dialect, r)).join(", ")} FROM ${ref}`);
  return statements;
}

/**
 * Oracle: system privileges (no target) use WITH ADMIN OPTION, object
 * privileges WITH GRANT OPTION. Neither option can be revoked on its own,
 * so dropping it means revoking and granting again without it.
 */
function diffScopedOracle(ref: string, target: string, before: ScopedGrant | undefined, after: ScopedGrant | undefined): string[] {
  const beforePrivs = before?.privileges ?? [];
  const afterPrivs = after?.privileges ?? [];
  const beforeOption = (before?.withGrant ?? false) && beforePrivs.length > 0;
  const afterOption = (after?.withGrant ?? false) && afterPrivs.length > 0;
  const on = target ? ` ON ${target}` : "";
  const option = target ? " WITH GRANT OPTION" : " WITH ADMIN OPTION";
  const statements: string[] = [];
  const optionChanged = beforeOption !== afterOption;
  const revoke = optionChanged ? beforePrivs : beforePrivs.filter((p) => !afterPrivs.includes(p));
  const grant = optionChanged ? afterPrivs : afterPrivs.filter((p) => !beforePrivs.includes(p));
  if (revoke.length) statements.push(`REVOKE ${revoke.join(", ")}${on} FROM ${ref}`);
  if (grant.length) statements.push(`GRANT ${grant.join(", ")}${on} TO ${ref}${afterOption ? option : ""}`);
  return statements;
}

function diffScoped(dialect: UserDialect, ref: string, target: string, before: ScopedGrant | undefined, after: ScopedGrant | undefined): string[] {
  if (dialect === "oracle") return diffScopedOracle(ref, target, before, after);
  const beforePrivs = before?.privileges ?? [];
  const afterPrivs = after?.privileges ?? [];
  const beforeGrant = (before?.withGrant ?? false) && beforePrivs.length > 0;
  const afterGrant = (after?.withGrant ?? false) && afterPrivs.length > 0;
  const added = afterPrivs.filter((p) => !beforePrivs.includes(p));
  const removed = beforePrivs.filter((p) => !afterPrivs.includes(p));
  const statements: string[] = [];

  if (removed.length) {
    statements.push(`REVOKE ${removed.join(", ")} ON ${target} FROM ${ref}`);
  }
  if (afterGrant && !beforeGrant) {
    // Turning the grant option on re-grants everything the account keeps, so
    // the option applies uniformly; this also covers newly added privileges.
    statements.push(`GRANT ${afterPrivs.join(", ")} ON ${target} TO ${ref} WITH GRANT OPTION`);
  } else if (added.length) {
    statements.push(`GRANT ${added.join(", ")} ON ${target} TO ${ref}${afterGrant ? " WITH GRANT OPTION" : ""}`);
  }
  if (beforeGrant && !afterGrant && afterPrivs.length) {
    statements.push(dialect === "mysql"
      ? `REVOKE GRANT OPTION ON ${target} FROM ${ref}`
      : `REVOKE GRANT OPTION FOR ${afterPrivs.join(", ")} ON ${target} FROM ${ref}`);
  }
  if (dialect === "mysql" && beforeGrant && afterPrivs.length === 0 && beforePrivs.length > 0) {
    statements.push(`REVOKE GRANT OPTION ON ${target} FROM ${ref}`);
  }
  return statements;
}

export function buildGrantDiff(dialect: UserDialect, ref: string, before: EditableGrants, after: EditableGrants): string[] {
  const statements: string[] = [];

  if (dialect === "mysql" || dialect === "oracle") {
    statements.push(...diffScoped(dialect, ref, grantTarget(dialect, "global", {}), before.global, after.global));
  }

  const byKey = <T extends ScopedGrant>(items: T[], key: (item: T) => string) => new Map(items.map((item) => [key(item), item]));
  const walk = <T extends ScopedGrant>(beforeItems: T[], afterItems: T[], key: (item: T) => string, target: (item: T) => string) => {
    const beforeMap = byKey(beforeItems, key);
    const afterMap = byKey(afterItems, key);
    const keys = [...new Set([...beforeMap.keys(), ...afterMap.keys()])];
    for (const k of keys) {
      const item = afterMap.get(k) ?? beforeMap.get(k)!;
      statements.push(...diffScoped(dialect, ref, target(item), beforeMap.get(k), afterMap.get(k)));
    }
  };

  walk(before.databases, after.databases, (g) => g.db, (g) => grantTarget(dialect, "database", g));
  if (dialect === "postgres") {
    walk(before.schemas, after.schemas, (g) => `${g.db}\u0000${g.schema}`, (g) => grantTarget(dialect, "schema", g));
  }
  walk(before.tables, after.tables, (g) => `${g.db}\u0000${g.schema}\u0000${g.table}`, (g) => grantTarget(dialect, "table", g));
  return statements;
}

/**
 * Everything the wizard needs: a create or an edit turned into an ordered
 * statement list. `before` is null when creating.
 */
export function buildAccountChanges(
  dialect: UserDialect,
  before: AccountDraft | null,
  after: AccountDraft,
): string[] {
  const name = dialect === "oracle" && !before ? oracleAccountName(after.name.trim()) : after.name.trim();
  const ref = accountRef(dialect, name, after.host);
  const statements: string[] = [];
  if (!before) {
    statements.push(...buildCreateAccount(dialect, after));
    statements.push(...buildRoleDiff(dialect, ref, [], after.roles));
    statements.push(...buildGrantDiff(dialect, ref, emptyGrants(), after.grants));
    return statements;
  }
  statements.push(...buildAlterAttributes(dialect, ref, before.attrs, after.attrs));
  statements.push(...buildSetPassword(dialect, ref, after.password));
  statements.push(...buildRoleDiff(dialect, ref, before.roles, after.roles));
  statements.push(...buildGrantDiff(dialect, ref, before.grants, after.grants));
  return statements;
}

/** Hide secrets when statements are displayed for review. */
export function maskPasswords(statements: string[]): string[] {
  return statements.map((sql) =>
    sql
      .replace(/\b(IDENTIFIED BY|PASSWORD)\s+'(?:[^'\\]|\\.|'')*'/g, "$1 '••••••••'")
      .replace(/\b(IDENTIFIED BY)\s+"[^"]*"/g, '$1 "••••••••"'),
  );
}
