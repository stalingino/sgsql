import type { ConnectionProfile } from "../lib/types";
import {
  getConnection,
  setConnection,
  closeConnection,
  hasConnection,
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
      setConnection(profile.id, { type: "postgres", client: sql });
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
      setConnection(profile.id, { type: "mysql", client: conn });
    } else if (profile.type === "sqlite") {
      const { Database } = await import("bun:sqlite");
      const db = new Database(profile.database, { readonly: false });
      const row = db.query("SELECT sqlite_version() AS v").get() as any;
      serverVersion = row?.v ?? "";
      setConnection(profile.id, { type: "sqlite", client: db });
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

  const entry = getConnection(connId);
  if (!entry) {
    return errorResponse("Connection not found. Call /connections/open first.", headers, 404);
  }

  const url = new URL(req.url);
  const db = url.searchParams.get("db") ?? undefined;
  const schema = url.searchParams.get("schema") ?? undefined;
  const table = url.searchParams.get("table") ?? undefined;

  try {
    switch (action) {
      case "databases":
        return json(await getDatabases(entry), headers);
      case "schemas":
        return json(await getSchemas(entry, db), headers);
      case "tables":
        return json(await getTables(entry, db, schema), headers);
      case "columns":
        if (!table) return errorResponse("Missing ?table= param", headers, 400);
        return json(await getColumns(entry, db, schema, table), headers);
      case "indexes":
        if (!table) return errorResponse("Missing ?table= param", headers, 400);
        return json(await getIndexes(entry, db, schema, table), headers);
      case "fks":
        if (!table) return errorResponse("Missing ?table= param", headers, 400);
        return json(await getForeignKeys(entry, db, schema, table), headers);
      default:
        return errorResponse(`Unknown schema action: ${action}`, headers, 404);
    }
  } catch (e: unknown) {
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
        SELECT column_name, data_type, udt_name, is_nullable, column_default, ordinal_position
        FROM information_schema.columns
        WHERE table_schema = ${s} AND table_name = ${table!}
        ORDER BY ordinal_position
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
