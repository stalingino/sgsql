import type { ConnectionProfile } from "../lib/types";
import { createSshTunnel, type SshTunnel } from "../lib/sshTunnel";
import {
  getConnection,
  getProfile,
  setConnection,
  closeConnection,
  hasConnection,
  isConnectionError,
  reconnect,
  ensureConnectionAlive,
  markConnectionUsed,
  type PoolEntry,
} from "../lib/pool";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(data: unknown, headers: Record<string, string>, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers });
}

function errorResponse(message: string, headers: Record<string, string>, status = 500): Response {
  return json({ error: message }, headers, status);
}

function withConnectionStatus<T extends object>(
  data: T,
  connectionId: string,
  reconnected: boolean,
): T & { _connection?: { connectionId: string; reconnected: true } } {
  return reconnected
    ? { ...data, _connection: { connectionId, reconnected: true } }
    : data;
}

import { friendlyError } from "../lib/friendlyError";
import { instrumentConnection } from "../lib/queryTrace";

function extractConnId(path: string): string | null {
  // /schema/:connId/...
  const parts = path.split("/");
  // ["", "schema", connId, action]
  if (parts.length >= 4 && parts[1] === "schema") {
    return parts[2];
  }
  return null;
}

function extractAction(path: string): string | null {
  const parts = path.split("/");
  if (parts.length >= 4 && parts[1] === "schema") {
    return parts[3];
  }
  return null;
}

// ---------------------------------------------------------------------------
// POST /connections/open
// ---------------------------------------------------------------------------

export async function handleOpenConnection(
  req: Request,
  headers: Record<string, string>,
): Promise<Response> {
  let profile: ConnectionProfile;
  try {
    profile = await req.json();
  } catch {
    return errorResponse("Invalid JSON body", headers, 400);
  }

  console.log(`[sidecar] opening connection: id=${profile.id}, type=${profile.type}, user=${profile.username}, hasPassword=${!!profile.password}, host=${profile.host}:${profile.port}/${profile.database}`);

  if (!profile.id || !profile.type) {
    return errorResponse("Missing id or type in profile", headers, 400);
  }

  // If already open, close old one first
  if (hasConnection(profile.id)) {
    await closeConnection(profile.id);
  }

  let tunnel: SshTunnel | null = null;
  try {
    let serverVersion = "";

    tunnel = await createSshTunnel(profile);
    const connectHost = tunnel?.host ?? profile.host;
    const connectPort = tunnel?.port ?? profile.port;

    if (profile.type === "postgres") {
      const postgres = (await import("postgres")).default;
      const sql = postgres({
        hostname: connectHost,
        port: connectPort,
        database: profile.database,
        username: profile.username,
        password: profile.password,
        ssl: profile.ssl ? "require" : false,
        connect_timeout: 5,
        max: 4,
      });
      const entry = instrumentConnection(profile.id, profile.database, { type: "postgres", client: sql, tunnel: tunnel ?? undefined });
      if (entry.type !== "postgres") throw new Error("Unexpected connection type");
      const [row] = await entry.client`SHOW server_version`;
      serverVersion = row?.server_version ?? "";
      setConnection(profile.id, entry, profile);
    } else if (profile.type === "mysql") {
      const mysql = await import("mysql2/promise");
      const conn = await mysql.createConnection({
        host: connectHost,
        port: connectPort,
        user: profile.username,
        password: profile.password,
        database: profile.database,
        ssl: profile.ssl ? {} : undefined,
        connectTimeout: 5000,
      });
      const entry = instrumentConnection(profile.id, profile.database, { type: "mysql", client: conn, tunnel: tunnel ?? undefined });
      if (entry.type !== "mysql") throw new Error("Unexpected connection type");
      const [rows] = await entry.client.query("SELECT version() AS v");
      serverVersion = (rows as any)?.[0]?.v ?? "";
      setConnection(profile.id, entry, profile);
    } else if (profile.type === "sqlite") {
      const { Database } = await import("bun:sqlite");
      const db = new Database(profile.database, { readonly: false });
      const entry = instrumentConnection(profile.id, profile.database, { type: "sqlite", client: db });
      if (entry.type !== "sqlite") throw new Error("Unexpected connection type");
      const row = entry.client.query("SELECT sqlite_version() AS v").get() as any;
      serverVersion = row?.v ?? "";
      setConnection(profile.id, entry, profile);
    } else {
      return errorResponse(`Unsupported connection type: ${(profile as any).type}`, headers, 400);
    }

    return json({ connectionId: profile.id, serverVersion }, headers);
  } catch (e: unknown) {
    await tunnel?.close().catch(() => {});
    const baseMessage = friendlyError(e);
    const message = profile.useSsh && tunnel && !baseMessage.startsWith("SSH ")
      ? `SSH tunnel established, but the database at ${profile.host}:${profile.port} could not be reached. ${baseMessage}`
      : baseMessage;
    console.error(`[sidecar] open connection failed: ${message}`);
    return errorResponse(message, headers);
  }
}

// ---------------------------------------------------------------------------
// POST /connections/close
// ---------------------------------------------------------------------------

export async function handleCloseConnection(
  req: Request,
  headers: Record<string, string>,
): Promise<Response> {
  let body: { connectionId?: string };
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON body", headers, 400);
  }

  if (!body.connectionId) {
    return errorResponse("Missing connectionId", headers, 400);
  }

  const closed = await closeConnection(body.connectionId);
  if (!closed) {
    return errorResponse("Connection not found", headers, 404);
  }

  return json({ ok: true }, headers);
}

// ---------------------------------------------------------------------------
// POST /connections/ensure — bounded idle health check + reconnect
// ---------------------------------------------------------------------------

export async function handleEnsureConnection(
  req: Request,
  headers: Record<string, string>,
): Promise<Response> {
  let body: { connectionId?: string };
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON body", headers, 400);
  }
  if (!body.connectionId) return errorResponse("Missing connectionId", headers, 400);

  try {
    const ensured = await ensureConnectionAlive(body.connectionId);
    return json(withConnectionStatus({ ok: true, reconnected: ensured.reconnected }, body.connectionId, ensured.reconnected), headers);
  } catch (error) {
    const message = friendlyError(error);
    console.error(`[sidecar] connection ensure failed: ${message}`);
    return errorResponse(message, headers);
  }
}

// ---------------------------------------------------------------------------
// POST /connections/reload — force a fresh connection using the saved profile
// ---------------------------------------------------------------------------

export async function handleReloadConnection(
  req: Request,
  headers: Record<string, string>,
): Promise<Response> {
  let body: { connectionId?: string };
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON body", headers, 400);
  }
  if (!body.connectionId) return errorResponse("Missing connectionId", headers, 400);

  try {
    await reconnect(body.connectionId);
    return json({ ok: true }, headers);
  } catch (error) {
    const message = friendlyError(error);
    console.error(`[sidecar] connection reload failed: ${message}`);
    return errorResponse(message, headers);
  }
}

// ---------------------------------------------------------------------------
// GET /schema/:connId/:action  — dispatcher
// ---------------------------------------------------------------------------

async function dispatchSchemaAction(
  entry: PoolEntry,
  action: string,
  db?: string,
  schema?: string,
  table?: string,
  limit = 50,
  offset = 0,
  orderBy?: string,
  where?: string,
): Promise<unknown> {
  switch (action) {
    case "databases": return getDatabases(entry);
    case "catalog": return getCatalog(entry, db);
    case "schemas": return getSchemas(entry, db);
    case "tables": return getTables(entry, db, schema);
    case "columns":
      if (!table) throw new Error("Missing ?table= param");
      return getColumns(entry, db, schema, table);
    case "indexes":
      if (!table) throw new Error("Missing ?table= param");
      return getIndexes(entry, db, schema, table);
    case "fks":
      if (!table) throw new Error("Missing ?table= param");
      return getForeignKeys(entry, db, schema, table);
    case "ddl":
      if (!table) throw new Error("Missing ?table= param");
      return getTableDdl(entry, db, schema, table);
    case "artifacts":
      if (!table) throw new Error("Missing ?table= param");
      return getTableArtifacts(entry, db, schema, table);
    case "rows":
      if (!table) throw new Error("Missing ?table= param");
      return getRows(entry, db, schema, table, limit, offset, orderBy, where);
    default:
      throw new Error(`Unknown schema action: ${action}`);
  }
}

async function getTableArtifacts(entry: PoolEntry, _db?: string, _schema?: string, table?: string): Promise<{ triggers: string[] }> {
  if (entry.type !== "sqlite") return { triggers: [] };
  const rows = entry.client.query("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name").all(table) as any[];
  return { triggers: rows.map((row) => String(row.sql)) };
}

async function getTableDdl(
  entry: PoolEntry,
  db?: string,
  schema?: string,
  table?: string,
): Promise<{ ddl: string }> {
  switch (entry.type) {
    case "postgres": {
      const s = schema || "public";
      const [view] = await entry.client`
        SELECT c.relkind, CASE WHEN c.relkind IN ('v', 'm') THEN pg_get_viewdef(c.oid, true) END AS definition
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ${s} AND c.relname = ${table!}
      `;
      if (view?.relkind === "v" || view?.relkind === "m") {
        const kind = view.relkind === "m" ? "MATERIALIZED VIEW" : "VIEW";
        return { ddl: `CREATE ${kind} "${s.replace(/"/g, '""')}"."${table!.replace(/"/g, '""')}" AS\n${view.definition};` };
      }
      const columns = await entry.client`
        SELECT a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
          a.attnotnull, pg_get_expr(d.adbin, d.adrelid) AS default_value
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
        WHERE n.nspname = ${s} AND c.relname = ${table!} AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum
      `;
      const constraints = await entry.client`
        SELECT con.conname, pg_get_constraintdef(con.oid, true) AS definition
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ${s} AND c.relname = ${table!}
      `;
      const indexes = await entry.client`
        SELECT pg_get_indexdef(i.indexrelid) AS definition
        FROM pg_index i
        JOIN pg_class rel ON rel.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = rel.relnamespace
        LEFT JOIN pg_constraint con ON con.conindid = i.indexrelid
        WHERE n.nspname = ${s} AND rel.relname = ${table!} AND con.oid IS NULL
      `;
      const triggers = await entry.client`
        SELECT pg_get_triggerdef(t.oid, true) AS definition
        FROM pg_trigger t JOIN pg_class rel ON rel.oid = t.tgrelid JOIN pg_namespace n ON n.oid = rel.relnamespace
        WHERE n.nspname = ${s} AND rel.relname = ${table!} AND NOT t.tgisinternal
      `;
      const comments = await entry.client`
        SELECT a.attname, col_description(rel.oid, a.attnum) AS comment
        FROM pg_class rel JOIN pg_namespace n ON n.oid = rel.relnamespace
        LEFT JOIN pg_attribute a ON a.attrelid = rel.oid AND a.attnum > 0 AND NOT a.attisdropped
        WHERE n.nspname = ${s} AND rel.relname = ${table!}
      `;
      const [tableMeta] = await entry.client`
        SELECT obj_description(rel.oid, 'pg_class') AS comment,
          CASE WHEN rel.relkind = 'p' THEN pg_get_partkeydef(rel.oid) END AS partition_key,
          rel.reloptions, ts.spcname AS tablespace
        FROM pg_class rel JOIN pg_namespace n ON n.oid = rel.relnamespace
        LEFT JOIN pg_tablespace ts ON ts.oid = rel.reltablespace
        WHERE n.nspname = ${s} AND rel.relname = ${table!}
      `;
      const grants = await entry.client`
        SELECT grantee, string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privileges
        FROM information_schema.role_table_grants
        WHERE table_schema = ${s} AND table_name = ${table!}
        GROUP BY grantee
      `;
      const lines = [
        ...columns.map((column: any) => `  "${String(column.attname).replace(/"/g, '""')}" ${column.type}${column.default_value ? ` DEFAULT ${column.default_value}` : ""}${column.attnotnull ? " NOT NULL" : ""}`),
        ...constraints.map((constraint: any) => `  CONSTRAINT "${String(constraint.conname).replace(/"/g, '""')}" ${constraint.definition}`),
      ];
      const qualified = `"${s.replace(/"/g, '""')}"."${table!.replace(/"/g, '""')}"`;
      const suffix = `${tableMeta?.partition_key ? ` PARTITION BY ${tableMeta.partition_key}` : ""}${tableMeta?.reloptions?.length ? ` WITH (${tableMeta.reloptions.join(", ")})` : ""}${tableMeta?.tablespace ? ` TABLESPACE "${String(tableMeta.tablespace).replace(/"/g, '""')}"` : ""}`;
      const quoteLiteral = (value: unknown) => `'${String(value).replace(/'/g, "''")}'`;
      const extras = [
        ...indexes.map((row: any) => `${row.definition};`),
        ...triggers.map((row: any) => `${row.definition};`),
        ...(tableMeta?.comment ? [`COMMENT ON TABLE ${qualified} IS ${quoteLiteral(tableMeta.comment)};`] : []),
        ...comments.filter((row: any) => row.comment).map((row: any) => `COMMENT ON COLUMN ${qualified}."${String(row.attname).replace(/"/g, '""')}" IS ${quoteLiteral(row.comment)};`),
        ...grants.map((row: any) => `GRANT ${row.privileges} ON TABLE ${qualified} TO "${String(row.grantee).replace(/"/g, '""')}";`),
      ];
      return { ddl: `CREATE TABLE ${qualified} (\n${lines.join(",\n")}\n)${suffix};${extras.length ? `\n\n${extras.join("\n")}` : ""}` };
    }
    case "mysql": {
      const d = db || "information_schema";
      const [rows] = await entry.client.query(`SHOW CREATE TABLE \`${d.replace(/`/g, "``")}\`.\`${table!.replace(/`/g, "``")}\``);
      const row = (rows as any[])[0] ?? {};
      return { ddl: row["Create Table"] ?? row["Create View"] ?? "" };
    }
    case "sqlite": {
      const row = entry.client.query("SELECT sql FROM sqlite_master WHERE name = ? AND type IN ('table', 'view')").get(table) as any;
      return { ddl: row?.sql ? `${row.sql};` : "" };
    }
  }
}

export async function handleSchemaRequest(
  req: Request,
  path: string,
  headers: Record<string, string>,
): Promise<Response> {
  const connId = extractConnId(path);
  const action = extractAction(path);

  if (!connId || !action) {
    return errorResponse("Invalid schema path", headers, 400);
  }

  let entry = getConnection(connId);
  if (!entry) {
    return errorResponse("Connection not found. Call /connections/open first.", headers, 404);
  }

  const url = new URL(req.url);
  const db = url.searchParams.get("db") ?? undefined;
  const schema = url.searchParams.get("schema") ?? undefined;
  const table = url.searchParams.get("table") ?? undefined;
  const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
  const orderBy = url.searchParams.get("orderBy") ?? undefined;
  const where = url.searchParams.get("where") ?? undefined;

  try {
    const ensured = await ensureConnectionAlive(connId);
    entry = ensured.entry;
    const result = await dispatchSchemaAction(entry, action, db, schema, table, limit, offset, orderBy, where);
    markConnectionUsed(connId);
    return json(withConnectionStatus(result, connId, ensured.reconnected), headers);
  } catch (e: unknown) {
    // Auto-reconnect once on connection errors
    if (isConnectionError(e)) {
      console.log(`[sidecar] connection error in schema/${action}, attempting reconnect for ${connId}...`);
      try {
        entry = await reconnect(connId);
        const result = await dispatchSchemaAction(entry, action, db, schema, table, limit, offset, orderBy, where);
        markConnectionUsed(connId);
        return json(withConnectionStatus(result, connId, true), headers);
      } catch (retryErr: unknown) {
        const message = friendlyError(retryErr);
        console.error(`[sidecar] reconnect+retry failed for schema/${action}: ${message}`);
        return errorResponse(message, headers);
      }
    }
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error(`[sidecar] schema/${action} error: ${message}`);
    return errorResponse(message, headers);
  }
}

export async function handleSchemaApply(
  req: Request,
  path: string,
  headers: Record<string, string>,
): Promise<Response> {
  const connectionId = extractConnId(path);
  if (!connectionId) return errorResponse("Invalid schema path", headers, 400);

  let body: { statements?: string[]; db?: string; disableForeignKeys?: boolean };
  try { body = await req.json(); } catch { return errorResponse("Invalid JSON body", headers, 400); }
  const statements = body.statements?.map((statement) => statement.trim()).filter(Boolean) ?? [];
  if (statements.length === 0) return errorResponse("No DDL statements supplied", headers, 400);
  if (statements.length > 100) return errorResponse("Schema batches are limited to 100 statements", headers, 400);

  let entry = getConnection(connectionId);
  if (!entry) return errorResponse("Connection not found. Call /connections/open first.", headers, 404);

  const started = performance.now();
  let applied = 0;
  try {
    const ensured = await ensureConnectionAlive(connectionId);
    entry = ensured.entry;
    if (body.db) await switchDb(entry, body.db);

    if (entry.type === "postgres") {
      await entry.client.begin(async (transaction) => {
        for (const statement of statements) {
          await transaction.unsafe(statement);
          applied += 1;
        }
      });
    } else if (entry.type === "sqlite") {
      if (body.disableForeignKeys) entry.client.run("PRAGMA foreign_keys = OFF");
      try {
        const apply = entry.client.transaction((batch: string[]) => {
          for (const statement of batch) {
            entry.client.run(statement);
            applied += 1;
          }
          if (body.disableForeignKeys) {
            const violations = entry.client.query("PRAGMA foreign_key_check").all() as any[];
            if (violations.length > 0) throw new Error(`Foreign-key validation failed for ${violations.length} row${violations.length === 1 ? "" : "s"}`);
          }
        });
        apply(statements);
      } finally {
        if (body.disableForeignKeys) entry.client.run("PRAGMA foreign_keys = ON");
      }
    } else {
      // MySQL implicitly commits most DDL. Execute in order and report exactly
      // how many statements committed if a later statement fails.
      for (const statement of statements) {
        await entry.client.query(statement);
        applied += 1;
      }
    }

    markConnectionUsed(connectionId);
    return json(withConnectionStatus({ ok: true, applied, atomic: entry.type !== "mysql", duration: performance.now() - started }, connectionId, ensured.reconnected), headers);
  } catch (cause) {
    const message = friendlyError(cause);
    const suffix = entry.type === "mysql" && applied > 0 ? ` (${applied} statement${applied === 1 ? "" : "s"} already committed)` : "";
    console.error(`[sidecar] schema apply failed after ${applied} statements: ${message}`);
    return errorResponse(`${message}${suffix}`, headers);
  }
}

// ---------------------------------------------------------------------------
// Introspection: Databases
// ---------------------------------------------------------------------------

async function getDatabases(entry: PoolEntry): Promise<{ databases: string[] }> {
  switch (entry.type) {
    case "postgres": {
      const rows = await entry.client`
        SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname
      `;
      return { databases: rows.map((r: any) => r.datname) };
    }
    case "mysql": {
      const [rows] = await entry.client.query("SHOW DATABASES");
      return { databases: (rows as any[]).map((r: any) => r.Database) };
    }
    case "sqlite": {
      // SQLite has no concept of multiple databases
      return { databases: ["main"] };
    }
  }
}

// ---------------------------------------------------------------------------
// Search catalog: all searchable relations without one request per database
// ---------------------------------------------------------------------------

async function getCatalog(
  entry: PoolEntry,
  currentDb?: string,
): Promise<{ databases: string[]; tables: { db: string; schema: string; name: string; type: string }[] }> {
  const { databases } = await getDatabases(entry);
  switch (entry.type) {
    case "postgres": {
      const rows = await entry.client`
        SELECT table_catalog, table_schema, table_name, table_type
        FROM information_schema.tables
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
        ORDER BY table_schema, table_name
      `;
      return {
        databases,
        tables: rows.map((row: any) => ({
          db: currentDb || row.table_catalog || databases[0] || "",
          schema: row.table_schema,
          name: row.table_name,
          type: row.table_type,
        })),
      };
    }
    case "mysql": {
      const [rows] = await entry.client.query(
        "SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES ORDER BY TABLE_SCHEMA, TABLE_NAME",
      );
      return {
        databases,
        tables: (rows as any[]).map((row: any) => ({
          db: row.TABLE_SCHEMA,
          schema: "",
          name: row.TABLE_NAME,
          type: row.TABLE_TYPE,
        })),
      };
    }
    case "sqlite": {
      const rows = entry.client.query(
        "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ).all() as any[];
      return {
        databases,
        tables: rows.map((row) => ({
          db: currentDb || "main",
          schema: "main",
          name: row.name,
          type: row.type === "view" ? "VIEW" : "BASE TABLE",
        })),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Introspection: Schemas
// ---------------------------------------------------------------------------

async function getSchemas(
  entry: PoolEntry,
  _db?: string,
): Promise<{ schemas: string[] }> {
  switch (entry.type) {
    case "postgres": {
      const rows = await entry.client`
        SELECT schema_name FROM information_schema.schemata
        WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
        ORDER BY schema_name
      `;
      return { schemas: rows.map((r: any) => r.schema_name) };
    }
    case "mysql": {
      // MySQL doesn't have schemas separate from databases
      return { schemas: [] };
    }
    case "sqlite": {
      // SQLite doesn't have schemas
      return { schemas: ["main"] };
    }
  }
}

// ---------------------------------------------------------------------------
// Introspection: Tables
// ---------------------------------------------------------------------------

async function getTables(
  entry: PoolEntry,
  db?: string,
  schema?: string,
): Promise<{ tables: { name: string; type: string }[] }> {
  switch (entry.type) {
    case "postgres": {
      const s = schema || "public";
      const rows = await entry.client`
        SELECT table_name, table_type
        FROM information_schema.tables
        WHERE table_schema = ${s}
        ORDER BY table_name
      `;
      return {
        tables: rows.map((r: any) => ({
          name: r.table_name,
          type: r.table_type,
        })),
      };
    }
    case "mysql": {
      const d = db || "information_schema";
      const [rows] = await entry.client.query(
        "SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
        [d],
      );
      return {
        tables: (rows as any[]).map((r: any) => ({
          name: r.TABLE_NAME,
          type: r.TABLE_TYPE,
        })),
      };
    }
    case "sqlite": {
      const rows = entry.client
        .query(
          "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all();
      return {
        tables: (rows as any[]).map((r: any) => ({
          name: r.name,
          type: r.type === "table" ? "BASE TABLE" : "VIEW",
        })),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Introspection: Columns
// ---------------------------------------------------------------------------

async function getColumns(
  entry: PoolEntry,
  db?: string,
  schema?: string,
  table?: string,
): Promise<{ columns: any[] }> {
  switch (entry.type) {
    case "postgres": {
      const s = schema || "public";
      const rows = await entry.client`
        SELECT
          c.column_name,
          c.data_type,
          c.udt_name,
          pg_catalog.format_type(a.atttypid, a.atttypmod) AS formatted_type,
          ARRAY(
            SELECT enumlabel
            FROM pg_enum
            WHERE enumtypid = a.atttypid
            ORDER BY enumsortorder
          ) AS enum_values,
          c.is_nullable,
          c.column_default,
          col_description(cls.oid, a.attnum) AS comment,
          c.collation_name,
          CASE WHEN c.is_identity = 'YES' THEN 'GENERATED ' || c.identity_generation || ' AS IDENTITY' ELSE '' END AS identity_clause,
          CASE WHEN c.is_generated <> 'NEVER' THEN 'GENERATED ALWAYS AS (' || c.generation_expression || ') STORED' ELSE '' END AS generation_clause,
          c.ordinal_position,
          CASE WHEN pk.column_name IS NOT NULL THEN 'PRI' WHEN uq.column_name IS NOT NULL THEN 'UNI' ELSE '' END AS column_key
        FROM information_schema.columns c
        JOIN pg_namespace ns ON ns.nspname = c.table_schema
        JOIN pg_class cls ON cls.relnamespace = ns.oid AND cls.relname = c.table_name
        JOIN pg_attribute a ON a.attrelid = cls.oid AND a.attname = c.column_name AND a.attnum > 0
        LEFT JOIN (
          SELECT kcu.column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
          WHERE tc.constraint_type = 'PRIMARY KEY'
            AND tc.table_schema = ${s}
            AND tc.table_name = ${table!}
        ) pk ON pk.column_name = c.column_name
        LEFT JOIN (
          SELECT max(kcu.column_name) AS column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
          WHERE tc.constraint_type = 'UNIQUE' AND tc.table_schema = ${s} AND tc.table_name = ${table!}
          GROUP BY tc.constraint_name
          HAVING COUNT(*) = 1
        ) uq ON uq.column_name = c.column_name
        WHERE c.table_schema = ${s} AND c.table_name = ${table!}
        ORDER BY c.ordinal_position
      `;
      return { columns: rows.map((r: any) => ({ ...r })) };
    }
    case "mysql": {
      const d = db || "information_schema";
      const [rows] = await entry.client.query(
        `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, ORDINAL_POSITION, COLUMN_KEY, EXTRA, COLLATION_NAME, GENERATION_EXPRESSION, COLUMN_COMMENT
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
         ORDER BY ORDINAL_POSITION`,
        [d, table],
      );
      return {
        columns: (rows as any[]).map((r: any) => ({
          column_name: r.COLUMN_NAME,
          data_type: r.DATA_TYPE,
          column_type: r.COLUMN_TYPE,
          is_nullable: r.IS_NULLABLE,
          column_default: r.COLUMN_DEFAULT,
          ordinal_position: r.ORDINAL_POSITION,
          column_key: r.COLUMN_KEY,
          extra: [r.COLLATION_NAME ? `COLLATE ${r.COLLATION_NAME}` : "", r.GENERATION_EXPRESSION ? `GENERATED ALWAYS AS (${r.GENERATION_EXPRESSION}) STORED` : r.EXTRA].filter(Boolean).join(" "),
          collation_name: r.COLLATION_NAME,
          generation_expression: r.GENERATION_EXPRESSION,
          column_comment: r.COLUMN_COMMENT,
        })),
      };
    }
    case "sqlite": {
      const rows = entry.client.query(`PRAGMA table_info("${table}")`).all();
      return {
        columns: (rows as any[]).map((r: any) => ({
          column_name: r.name,
          data_type: r.type,
          is_nullable: r.notnull === 0 ? "YES" : "NO",
          column_default: r.dflt_value,
          ordinal_position: r.cid + 1,
          column_key: r.pk === 1 ? "PRI" : "",
        })),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Introspection: Indexes
// ---------------------------------------------------------------------------

async function getIndexes(
  entry: PoolEntry,
  db?: string,
  schema?: string,
  table?: string,
): Promise<{ indexes: any[] }> {
  switch (entry.type) {
    case "postgres": {
      const s = schema || "public";
      const rows = await entry.client`
        SELECT idx.relname AS indexname, pg_get_indexdef(idx.oid) AS indexdef,
          ix.indisprimary AS primary, am.amname AS method,
          pg_get_expr(ix.indexprs, ix.indrelid) AS expression_sql,
          pg_get_expr(ix.indpred, ix.indrelid) AS predicate,
          ARRAY(SELECT att.attname FROM unnest(ix.indkey) WITH ORDINALITY AS key(attnum, ord) JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = key.attnum WHERE key.attnum > 0 AND key.ord <= ix.indnkeyatts ORDER BY key.ord) AS columns,
          ARRAY(SELECT att.attname FROM unnest(ix.indkey) WITH ORDINALITY AS key(attnum, ord) JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = key.attnum WHERE key.attnum > 0 AND key.ord > ix.indnkeyatts ORDER BY key.ord) AS include_columns
        FROM pg_class rel
        JOIN pg_namespace ns ON ns.oid = rel.relnamespace
        JOIN pg_index ix ON ix.indrelid = rel.oid
        JOIN pg_class idx ON idx.oid = ix.indexrelid
        JOIN pg_am am ON am.oid = idx.relam
        WHERE ns.nspname = ${s} AND rel.relname = ${table!}
      `;
      return { indexes: rows.map((r: any) => ({ ...r })) };
    }
    case "mysql": {
      const d = db || "information_schema";
      const [rows] = await entry.client.query(
        `SHOW INDEX FROM \`${table}\` FROM \`${d}\``,
      );
      return { indexes: rows as any[] };
    }
    case "sqlite": {
      const indexList = entry.client
        .query(`PRAGMA index_list("${table}")`)
        .all() as any[];
      const indexes = [];
      for (const idx of indexList) {
        const cols = entry.client
          .query(`PRAGMA index_info("${idx.name}")`)
          .all() as any[];
        indexes.push({
          name: idx.name,
          unique: idx.unique === 1,
          primary: idx.origin === "pk",
          columns: cols.map((c: any) => c.name),
          definition: (entry.client.query("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(idx.name) as any)?.sql ?? undefined,
        });
      }
      return { indexes };
    }
  }
}

// ---------------------------------------------------------------------------
// Introspection: Foreign Keys
// ---------------------------------------------------------------------------

async function getForeignKeys(
  entry: PoolEntry,
  db?: string,
  schema?: string,
  table?: string,
): Promise<{ foreignKeys: any[] }> {
  switch (entry.type) {
    case "postgres": {
      const s = schema || "public";
      const rows = await entry.client`
        SELECT
          tc.constraint_name,
          kcu.column_name,
          ref.table_schema AS foreign_table_schema,
          ref.table_name AS foreign_table_name,
          ref.column_name AS foreign_column_name,
          rc.update_rule AS on_update,
          rc.delete_rule AS on_delete,
          kcu.ordinal_position
        FROM information_schema.table_constraints AS tc
        JOIN information_schema.key_column_usage AS kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        JOIN information_schema.referential_constraints rc
          ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
        JOIN information_schema.key_column_usage ref
          ON ref.constraint_schema = rc.unique_constraint_schema
          AND ref.constraint_name = rc.unique_constraint_name
          AND ref.ordinal_position = kcu.position_in_unique_constraint
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_schema = ${s}
          AND tc.table_name = ${table!}
        ORDER BY tc.constraint_name, kcu.ordinal_position
      `;
      return { foreignKeys: rows.map((r: any) => ({ ...r })) };
    }
    case "mysql": {
      const d = db || "information_schema";
      const [rows] = await entry.client.query(
        `SELECT
           kcu.CONSTRAINT_NAME,
           kcu.COLUMN_NAME,
           kcu.REFERENCED_TABLE_SCHEMA,
           kcu.REFERENCED_TABLE_NAME,
           kcu.REFERENCED_COLUMN_NAME,
           rc.UPDATE_RULE,
           rc.DELETE_RULE,
           kcu.ORDINAL_POSITION
         FROM information_schema.KEY_COLUMN_USAGE
         AS kcu JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
           ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
         WHERE kcu.TABLE_SCHEMA = ? AND kcu.TABLE_NAME = ? AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
         ORDER BY kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`,
        [d, table],
      );
      return {
        foreignKeys: (rows as any[]).map((r: any) => ({
          constraint_name: r.CONSTRAINT_NAME,
          column_name: r.COLUMN_NAME,
          foreign_table_schema: r.REFERENCED_TABLE_SCHEMA,
          foreign_table_name: r.REFERENCED_TABLE_NAME,
          foreign_column_name: r.REFERENCED_COLUMN_NAME,
          on_update: r.UPDATE_RULE,
          on_delete: r.DELETE_RULE,
        })),
      };
    }
    case "sqlite": {
      const rows = entry.client
        .query(`PRAGMA foreign_key_list("${table}")`)
        .all() as any[];
      return {
        foreignKeys: rows.map((r: any) => ({
          id: r.id,
          column_name: r.from,
          foreign_table_name: r.table,
          foreign_column_name: r.to,
          on_update: r.on_update,
          on_delete: r.on_delete,
        })),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Query: Table rows
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// POST /query — arbitrary SQL execution
// ---------------------------------------------------------------------------

const SELECT_RE = /^\s*(SELECT|SHOW|DESCRIBE|EXPLAIN)/i;

async function executeSQL(entry: PoolEntry, sql: string, isSelect: boolean) {
  if (isSelect) {
    let rawRows: any[];
    switch (entry.type) {
      case "postgres": rawRows = await entry.client.unsafe(sql); break;
      case "mysql": { const [rows] = await entry.client.query(sql); rawRows = rows as any[]; break; }
      case "sqlite": rawRows = entry.client.query(sql).all() as any[]; break;
    }
    const columns = rawRows.length > 0 ? Object.keys(rawRows[0]) : [];
    return {
      columns,
      rows: rawRows.map((r: any) => columns.map((c) => r[c])),
      rowCount: rawRows.length,
      query: sql,
    };
  } else {
    let affectedRows = 0;
    switch (entry.type) {
      case "postgres": { const result = await entry.client.unsafe(sql); affectedRows = result.count ?? 0; break; }
      case "mysql": { const [result] = await entry.client.query(sql); affectedRows = (result as any).affectedRows ?? 0; break; }
      case "sqlite": { const result = entry.client.run(sql); affectedRows = result.changes; break; }
    }
    return { affectedRows, query: sql };
  }
}

// ---------------------------------------------------------------------------
// POST /cancel — kill the currently running query on a connection
// ---------------------------------------------------------------------------

export async function handleCancel(
  req: Request,
  headers: Record<string, string>,
): Promise<Response> {
  let body: { connectionId?: string };
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON body", headers, 400);
  }

  const { connectionId } = body;
  if (!connectionId) {
    return errorResponse("Missing connectionId", headers, 400);
  }

  const entry = getConnection(connectionId);
  if (!entry) {
    return errorResponse("Connection not found", headers, 404);
  }

  const profile = getProfile(connectionId);

  let detail = "";
  try {
    switch (entry.type) {
      case "mysql": {
        // Get the thread ID of the running query connection
        const threadId = (entry.client as any).connection?.threadId
          ?? (entry.client as any).threadId;
        if (!threadId) {
          return errorResponse("Cannot determine MySQL thread ID", headers, 500);
        }
        // Open a separate connection to kill the query
        const mysql = await import("mysql2/promise");
        const killer = await mysql.createConnection({
          host: profile?.host ?? "localhost",
          port: profile?.port ?? 3306,
          user: profile?.username ?? "root",
          password: profile?.password ?? "",
          connectTimeout: 5000,
        });
        const killerEntry = instrumentConnection(connectionId, profile?.database ?? "", { type: "mysql", client: killer });
        if (killerEntry.type !== "mysql") throw new Error("Unexpected connection type");
        await killerEntry.client.query(`KILL QUERY ${threadId}`);
        await killerEntry.client.end();
        detail = `Killed MySQL query on thread ${threadId}`;
        console.log(`[sidecar] ${detail}`);
        break;
      }
      case "postgres": {
        // Cancel the current query using pg_cancel_backend
        const [row] = await entry.client`SELECT pg_backend_pid() AS pid`;
        const pid = row?.pid;
        if (pid) {
          await entry.client`SELECT pg_cancel_backend(${pid})`;
          detail = `Killed Postgres query on pid ${pid}`;
          console.log(`[sidecar] ${detail}`);
        }
        break;
      }
      case "sqlite": {
        detail = "SQLite queries cannot be killed server-side";
        break;
      }
    }
    return json({ ok: true, detail }, headers);
  } catch (e: unknown) {
    const message = friendlyError(e);
    console.error(`[sidecar] cancel error: ${message}`);
    return errorResponse(message, headers);
  }
}

/** Switch the active database on a connection (MySQL: USE, Postgres: SET search_path) */
async function switchDb(entry: PoolEntry, db: string): Promise<void> {
  if (!db) return;
  switch (entry.type) {
    case "mysql":
      await entry.client.query(`USE \`${db}\``);
      break;
    case "postgres":
      // For Postgres, switching database is not trivial (requires new connection).
      // The search_path approach only switches schema, not database.
      // For now, no-op — Postgres queries should use qualified names.
      break;
    case "sqlite":
      // SQLite is single-database
      break;
  }
}

export async function handleQuery(
  req: Request,
  headers: Record<string, string>,
): Promise<Response> {
  let body: { connectionId?: string; sql?: string; db?: string };
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON body", headers, 400);
  }

  const { connectionId, sql, db } = body;
  if (!connectionId || !sql) {
    return errorResponse("Missing connectionId or sql", headers, 400);
  }

  let entry = getConnection(connectionId);
  if (!entry) {
    return errorResponse("Connection not found. Call /connections/open first.", headers, 404);
  }

  const isSelect = SELECT_RE.test(sql);

  try {
    const ensured = await ensureConnectionAlive(connectionId);
    entry = ensured.entry;
    // Switch database context if requested
    if (db) await switchDb(entry, db);
    const t0 = performance.now();
    const result = await executeSQL(entry, sql, isSelect);
    markConnectionUsed(connectionId);
    return json(withConnectionStatus({ ...result, duration: performance.now() - t0 }, connectionId, ensured.reconnected), headers);
  } catch (e: unknown) {
    // Auto-reconnect once on connection errors
    if (isConnectionError(e)) {
      console.log(`[sidecar] connection error detected, attempting reconnect for ${connectionId}...`);
      try {
        entry = await reconnect(connectionId);
        if (db) await switchDb(entry, db);
        const t0 = performance.now();
        const result = await executeSQL(entry, sql, isSelect);
        markConnectionUsed(connectionId);
        return json(withConnectionStatus({ ...result, duration: performance.now() - t0 }, connectionId, true), headers);
      } catch (retryErr: unknown) {
        const message = friendlyError(retryErr);
        console.error(`[sidecar] reconnect+retry failed: ${message}`);
        return errorResponse(message, headers);
      }
    }
    const message = friendlyError(e);
    console.error(`[sidecar] query error: ${message}`);
    return errorResponse(message, headers);
  }
}

// ---------------------------------------------------------------------------
// Query: Table rows
// ---------------------------------------------------------------------------

async function getRows(
  entry: PoolEntry,
  db?: string,
  schema?: string,
  table?: string,
  limit = 50,
  offset = 0,
  orderBy?: string,
  where?: string,
): Promise<{ columns: string[]; rows: any[][]; totalEstimate: number; query: string }> {
  const safeLimit = Math.min(Math.max(limit, 1), 1000);

  // Build ORDER BY clause — validate column exists to avoid SQL injection
  const buildOrderClause = (columns: string[], orderStr?: string): string => {
    if (!orderStr?.trim()) return "";
    // Parse "col DIR" format
    const parts = orderStr.trim().split(/\s+/);
    const col = parts[0];
    const dir = (parts[1] || "").toUpperCase();
    const safeDir = dir === "DESC" ? "DESC" : dir === "ASC" ? "ASC" : "";
    // Check if column exists (case-insensitive)
    const found = columns.find((c) => c.toLowerCase() === col.toLowerCase());
    if (!found) return "";
    return ` ORDER BY ${quoteIdent(entry.type, found)}${safeDir ? " " + safeDir : ""}`;
  };

  switch (entry.type) {
    case "postgres": {
      const s = schema || "public";
      const qualified = `"${s}"."${table}"`;
      // First get columns to validate orderBy
      const colQuery = await entry.client.unsafe(`SELECT * FROM ${qualified} LIMIT 0`);
      const allCols = colQuery.columns?.map((c: any) => c.name) ?? [];
      const orderClause = buildOrderClause(allCols.length > 0 ? allCols : [], orderBy);
      const whereClause = where ? ` WHERE ${where}` : "";
      const query = `SELECT * FROM ${qualified}${whereClause}${orderClause} LIMIT ${safeLimit} OFFSET ${offset}`;
      // Get estimated row count
      const [countRow] = await entry.client`
        SELECT reltuples::bigint AS estimate
        FROM pg_class
        WHERE oid = ${`${s}.${table}`}::regclass
      `;
      const totalEstimate = Number(countRow?.estimate ?? 0);
      const rows = await entry.client.unsafe(query);
      const columns = rows.length > 0 ? Object.keys(rows[0]) : allCols;
      return {
        columns,
        rows: rows.map((r: any) => columns.map((c) => r[c])),
        totalEstimate,
        query,
      };
    }
    case "mysql": {
      const d = db || "information_schema";
      // Get columns first to validate orderBy
      const [colRows] = await entry.client.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
        [d, table],
      );
      const allCols = (colRows as any[]).map((r: any) => r.COLUMN_NAME);
      const orderClause = buildOrderClause(allCols, orderBy);
      const whereClause = where ? ` WHERE ${where}` : "";
      const query = `SELECT * FROM \`${d}\`.\`${table}\`${whereClause}${orderClause} LIMIT ${safeLimit} OFFSET ${offset}`;
      // Get estimated row count
      const [countRows] = await entry.client.query(
        `SELECT TABLE_ROWS AS estimate FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
        [d, table],
      );
      const totalEstimate = Number((countRows as any[])?.[0]?.estimate ?? 0);
      const [dataRows] = await entry.client.query(query);
      const arr = dataRows as any[];
      const columns = arr.length > 0 ? Object.keys(arr[0]) : allCols;
      return {
        columns,
        rows: arr.map((r: any) => columns.map((c) => r[c])),
        totalEstimate,
        query,
      };
    }
    case "sqlite": {
      // Get columns first
      const pragmaRows = entry.client.query(`PRAGMA table_info("${table}")`).all() as any[];
      const allCols = pragmaRows.map((r: any) => r.name);
      const orderClause = buildOrderClause(allCols, orderBy);
      const whereClause = where ? ` WHERE ${where}` : "";
      const query = `SELECT * FROM "${table}"${whereClause}${orderClause} LIMIT ${safeLimit} OFFSET ${offset}`;
      // Get row count
      const countRow = entry.client
        .query(`SELECT COUNT(*) AS cnt FROM "${table}"`)
        .get() as any;
      const totalEstimate = Number(countRow?.cnt ?? 0);
      const dataRows = entry.client
        .query(query)
        .all() as any[];
      const columns = dataRows.length > 0 ? Object.keys(dataRows[0]) : allCols;
      return {
        columns,
        rows: dataRows.map((r: any) => columns.map((c) => r[c])),
        totalEstimate,
        query,
      };
    }
  }
}

/** Quote an identifier per dialect */
function quoteIdent(type: "postgres" | "mysql" | "sqlite", name: string): string {
  if (type === "mysql") return `\`${name}\``;
  return `"${name}"`;
}
