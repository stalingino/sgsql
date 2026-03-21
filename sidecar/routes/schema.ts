import type { ConnectionProfile } from "../lib/types";
import {
  getConnection,
  setConnection,
  closeConnection,
  hasConnection,
  isConnectionError,
  reconnect,
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

import { friendlyError } from "../lib/friendlyError";

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

  try {
    let serverVersion = "";

    if (profile.type === "postgres") {
      const postgres = (await import("postgres")).default;
      const sql = postgres({
        hostname: profile.host,
        port: profile.port,
        database: profile.database,
        username: profile.username,
        password: profile.password,
        ssl: profile.ssl ? "require" : false,
        connect_timeout: 5,
        max: 4,
      });
      const [row] = await sql`SHOW server_version`;
      serverVersion = row?.server_version ?? "";
      setConnection(profile.id, { type: "postgres", client: sql }, profile);
    } else if (profile.type === "mysql") {
      const mysql = await import("mysql2/promise");
      const conn = await mysql.createConnection({
        host: profile.host,
        port: profile.port,
        user: profile.username,
        password: profile.password,
        database: profile.database,
        ssl: profile.ssl ? {} : undefined,
        connectTimeout: 5000,
      });
      const [rows] = await conn.query("SELECT version() AS v");
      serverVersion = (rows as any)?.[0]?.v ?? "";
      setConnection(profile.id, { type: "mysql", client: conn }, profile);
    } else if (profile.type === "sqlite") {
      const { Database } = await import("bun:sqlite");
      const db = new Database(profile.database, { readonly: false });
      const row = db.query("SELECT sqlite_version() AS v").get() as any;
      serverVersion = row?.v ?? "";
      setConnection(profile.id, { type: "sqlite", client: db }, profile);
    } else {
      return errorResponse(`Unsupported connection type: ${(profile as any).type}`, headers, 400);
    }

    return json({ connectionId: profile.id, serverVersion }, headers);
  } catch (e: unknown) {
    const message = friendlyError(e);
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
// GET /schema/:connId/:action  — dispatcher
// ---------------------------------------------------------------------------

async function dispatchSchemaAction(
  entry: PoolEntry,
  action: string,
  db?: string,
  schema?: string,
  table?: string,
  limit = 100,
  offset = 0,
): Promise<unknown> {
  switch (action) {
    case "databases": return getDatabases(entry);
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
    case "rows":
      if (!table) throw new Error("Missing ?table= param");
      return getRows(entry, db, schema, table, limit, offset);
    default:
      throw new Error(`Unknown schema action: ${action}`);
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
  const limit = parseInt(url.searchParams.get("limit") ?? "100", 10);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

  try {
    const result = await dispatchSchemaAction(entry, action, db, schema, table, limit, offset);
    return json(result, headers);
  } catch (e: unknown) {
    // Auto-reconnect once on connection errors
    if (isConnectionError(e)) {
      console.log(`[sidecar] connection error in schema/${action}, attempting reconnect for ${connId}...`);
      try {
        entry = await reconnect(connId);
        const result = await dispatchSchemaAction(entry, action, db, schema, table, limit, offset);
        return json(result, headers);
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
          c.is_nullable,
          c.column_default,
          c.ordinal_position,
          CASE WHEN pk.column_name IS NOT NULL THEN 'PRI' ELSE '' END AS column_key
        FROM information_schema.columns c
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
        WHERE c.table_schema = ${s} AND c.table_name = ${table!}
        ORDER BY c.ordinal_position
      `;
      return { columns: rows.map((r: any) => ({ ...r })) };
    }
    case "mysql": {
      const d = db || "information_schema";
      const [rows] = await entry.client.query(
        `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, ORDINAL_POSITION, COLUMN_KEY, EXTRA
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
          extra: r.EXTRA,
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
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = ${s} AND tablename = ${table!}
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
          columns: cols.map((c: any) => c.name),
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
          ccu.table_schema AS foreign_table_schema,
          ccu.table_name AS foreign_table_name,
          ccu.column_name AS foreign_column_name
        FROM information_schema.table_constraints AS tc
        JOIN information_schema.key_column_usage AS kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage AS ccu
          ON ccu.constraint_name = tc.constraint_name
          AND ccu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_schema = ${s}
          AND tc.table_name = ${table!}
      `;
      return { foreignKeys: rows.map((r: any) => ({ ...r })) };
    }
    case "mysql": {
      const d = db || "information_schema";
      const [rows] = await entry.client.query(
        `SELECT
           CONSTRAINT_NAME,
           COLUMN_NAME,
           REFERENCED_TABLE_SCHEMA,
           REFERENCED_TABLE_NAME,
           REFERENCED_COLUMN_NAME
         FROM information_schema.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
        [d, table],
      );
      return {
        foreignKeys: (rows as any[]).map((r: any) => ({
          constraint_name: r.CONSTRAINT_NAME,
          column_name: r.COLUMN_NAME,
          foreign_table_schema: r.REFERENCED_TABLE_SCHEMA,
          foreign_table_name: r.REFERENCED_TABLE_NAME,
          foreign_column_name: r.REFERENCED_COLUMN_NAME,
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

export async function handleQuery(
  req: Request,
  headers: Record<string, string>,
): Promise<Response> {
  let body: { connectionId?: string; sql?: string };
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON body", headers, 400);
  }

  const { connectionId, sql } = body;
  if (!connectionId || !sql) {
    return errorResponse("Missing connectionId or sql", headers, 400);
  }

  let entry = getConnection(connectionId);
  if (!entry) {
    return errorResponse("Connection not found. Call /connections/open first.", headers, 404);
  }

  const isSelect = SELECT_RE.test(sql);

  try {
    const t0 = performance.now();
    const result = await executeSQL(entry, sql, isSelect);
    return json({ ...result, duration: performance.now() - t0 }, headers);
  } catch (e: unknown) {
    // Auto-reconnect once on connection errors
    if (isConnectionError(e)) {
      console.log(`[sidecar] connection error detected, attempting reconnect for ${connectionId}...`);
      try {
        entry = await reconnect(connectionId);
        const t0 = performance.now();
        const result = await executeSQL(entry, sql, isSelect);
        return json({ ...result, duration: performance.now() - t0 }, headers);
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
  limit = 100,
  offset = 0,
): Promise<{ columns: string[]; rows: any[][]; totalEstimate: number; query: string }> {
  const safeLimit = Math.min(Math.max(limit, 1), 1000);

  switch (entry.type) {
    case "postgres": {
      const s = schema || "public";
      const qualified = `"${s}"."${table}"`;
      const query = `SELECT * FROM ${qualified} LIMIT ${safeLimit} OFFSET ${offset}`;
      // Get estimated row count
      const [countRow] = await entry.client`
        SELECT reltuples::bigint AS estimate
        FROM pg_class
        WHERE oid = ${`${s}.${table}`}::regclass
      `;
      const totalEstimate = Number(countRow?.estimate ?? 0);
      const rows = await entry.client.unsafe(query);
      const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
      return {
        columns,
        rows: rows.map((r: any) => columns.map((c) => r[c])),
        totalEstimate,
        query,
      };
    }
    case "mysql": {
      const d = db || "information_schema";
      const query = `SELECT * FROM \`${d}\`.\`${table}\` LIMIT ${safeLimit} OFFSET ${offset}`;
      // Get estimated row count
      const [countRows] = await entry.client.query(
        `SELECT TABLE_ROWS AS estimate FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
        [d, table],
      );
      const totalEstimate = Number((countRows as any[])?.[0]?.estimate ?? 0);
      const [dataRows] = await entry.client.query(query);
      const arr = dataRows as any[];
      const columns = arr.length > 0 ? Object.keys(arr[0]) : [];
      return {
        columns,
        rows: arr.map((r: any) => columns.map((c) => r[c])),
        totalEstimate,
        query,
      };
    }
    case "sqlite": {
      const query = `SELECT * FROM "${table}" LIMIT ${safeLimit} OFFSET ${offset}`;
      // Get row count
      const countRow = entry.client
        .query(`SELECT COUNT(*) AS cnt FROM "${table}"`)
        .get() as any;
      const totalEstimate = Number(countRow?.cnt ?? 0);
      const dataRows = entry.client
        .query(query)
        .all() as any[];
      const columns = dataRows.length > 0 ? Object.keys(dataRows[0]) : [];
      return {
        columns,
        rows: dataRows.map((r: any) => columns.map((c) => r[c])),
        totalEstimate,
        query,
      };
    }
  }
}
