import type { Sql } from "postgres";
import type { Connection } from "mysql2/promise";
import { Database } from "bun:sqlite";
import type { ConnectionProfile } from "./types";

export type PoolEntry =
  | { type: "postgres"; client: Sql }
  | { type: "mysql"; client: Connection }
  | { type: "sqlite"; client: Database };

interface PoolRecord {
  entry: PoolEntry;
  profile: ConnectionProfile;
}

const pool = new Map<string, PoolRecord>();

export function getConnection(id: string): PoolEntry | undefined {
  return pool.get(id)?.entry;
}

export function getProfile(id: string): ConnectionProfile | undefined {
  return pool.get(id)?.profile;
}

export function setConnection(id: string, entry: PoolEntry, profile: ConnectionProfile): void {
  pool.set(id, { entry, profile });
}

export async function closeConnection(id: string): Promise<boolean> {
  const record = pool.get(id);
  if (!record) return false;

  try {
    switch (record.entry.type) {
      case "postgres":
        await record.entry.client.end();
        break;
      case "mysql":
        await record.entry.client.end();
        break;
      case "sqlite":
        record.entry.client.close();
        break;
    }
  } catch (e) {
    console.error(`[pool] error closing connection ${id}:`, e);
  }

  pool.delete(id);
  return true;
}

export function hasConnection(id: string): boolean {
  return pool.has(id);
}

export function poolSize(): number {
  return pool.size;
}

/** Check if an error indicates a dead/stale connection that could benefit from reconnect. */
export function isConnectionError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const msg = e.message.toLowerCase();
  const code = (e as NodeJS.ErrnoException).code?.toLowerCase() ?? "";

  // Check error chain too
  const cause = (e as Error & { cause?: unknown }).cause;
  const causeMsg = cause instanceof Error ? cause.message.toLowerCase() : "";
  const causeCode = cause instanceof Error ? ((cause as NodeJS.ErrnoException).code?.toLowerCase() ?? "") : "";

  const all = `${msg} ${code} ${causeMsg} ${causeCode}`;

  return (
    all.includes("econnreset") ||
    all.includes("epipe") ||
    all.includes("closed state") ||
    all.includes("closed connection") ||
    all.includes("connection lost") ||
    all.includes("connection closed") ||
    all.includes("connection was closed") ||
    all.includes("has been closed") ||
    all.includes("can't add new command") ||
    all.includes("cannot execute") ||
    all.includes("connection terminated") ||
    all.includes("connection unexpectedly") ||
    all.includes("socket has been ended") ||
    all.includes("socket hang up") ||
    all.includes("broken pipe") ||
    all.includes("read econnreset") ||
    all.includes("etimedout")
  );
}

/** Reconnect a dead connection using its stored profile. Returns new entry or throws. */
export async function reconnect(id: string): Promise<PoolEntry> {
  const record = pool.get(id);
  if (!record) throw new Error("Connection not found");

  const profile = record.profile;
  console.log(`[pool] reconnecting ${id} (${profile.type} ${profile.host}:${profile.port}/${profile.database})`);

  // Try to close the old one silently
  try {
    switch (record.entry.type) {
      case "postgres": await record.entry.client.end(); break;
      case "mysql": await record.entry.client.end(); break;
      case "sqlite": record.entry.client.close(); break;
    }
  } catch { /* ignore */ }

  // Create new connection
  let newEntry: PoolEntry;

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
    // Verify connection is alive
    await sql`SELECT 1`;
    newEntry = { type: "postgres", client: sql };
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
    newEntry = { type: "mysql", client: conn };
  } else {
    const { Database } = await import("bun:sqlite");
    const db = new Database(profile.database, { readonly: false });
    newEntry = { type: "sqlite", client: db };
  }

  pool.set(id, { entry: newEntry, profile });
  console.log(`[pool] reconnected ${id} successfully`);
  return newEntry;
}
