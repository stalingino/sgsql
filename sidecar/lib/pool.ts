import type { Sql } from "postgres";
import type { Connection } from "mysql2/promise";
import { Database } from "bun:sqlite";
import type { ConnectionProfile } from "./types";
import { createSshTunnel, type SshTunnel } from "./sshTunnel";

export type PoolEntry =
  | { type: "postgres"; client: Sql; tunnel?: SshTunnel }
  | { type: "mysql"; client: Connection; tunnel?: SshTunnel }
  | { type: "sqlite"; client: Database; tunnel?: never };

interface PoolRecord {
  entry: PoolEntry;
  profile: ConnectionProfile;
  lastUsedAt: number;
}

const pool = new Map<string, PoolRecord>();
const reconnecting = new Map<string, Promise<PoolEntry>>();
const IDLE_CHECK_AFTER_MS = 30_000;
const HEALTH_CHECK_TIMEOUT_MS = 3_000;

export function getConnection(id: string): PoolEntry | undefined {
  return pool.get(id)?.entry;
}

export function getProfile(id: string): ConnectionProfile | undefined {
  return pool.get(id)?.profile;
}

export function setConnection(id: string, entry: PoolEntry, profile: ConnectionProfile): void {
  pool.set(id, { entry, profile, lastUsedAt: Date.now() });
}

export function markConnectionUsed(id: string): void {
  const record = pool.get(id);
  if (record) record.lastUsedAt = Date.now();
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

  await record.entry.tunnel?.close().catch(() => {});

  // A new connection with the same profile id may have been opened while the
  // old client's asynchronous shutdown was in progress. Never delete that
  // replacement from the pool.
  if (pool.get(id) === record) pool.delete(id);
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
  const active = reconnecting.get(id);
  if (active) return active;

  const attempt = reconnectInternal(id).finally(() => reconnecting.delete(id));
  reconnecting.set(id, attempt);
  return attempt;
}

async function reconnectInternal(id: string): Promise<PoolEntry> {
  const record = pool.get(id);
  if (!record) throw new Error("Connection not found");

  const profile = record.profile;
  console.log(`[pool] reconnecting ${id} (${profile.type} ${profile.host}:${profile.port}/${profile.database})`);

  // Try to close the old one silently
  try {
    switch (record.entry.type) {
      case "postgres": await withTimeout(record.entry.client.end({ timeout: 1 }), 1_500, "Closing stale PostgreSQL connection timed out"); break;
      case "mysql": record.entry.client.destroy(); break;
      case "sqlite": record.entry.client.close(); break;
    }
  } catch { /* ignore */ }
  await record.entry.tunnel?.close().catch(() => {});

  // Create new connection
  let newEntry: PoolEntry;
  const tunnel = await createSshTunnel(profile);
  const connectHost = tunnel?.host ?? profile.host;
  const connectPort = tunnel?.port ?? profile.port;

  try {
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
      // Verify connection is alive
      await sql`SELECT 1`;
      newEntry = { type: "postgres", client: sql, tunnel: tunnel ?? undefined };
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
      newEntry = { type: "mysql", client: conn, tunnel: tunnel ?? undefined };
    } else {
      const { Database } = await import("bun:sqlite");
      const db = new Database(profile.database, { readonly: false });
      newEntry = { type: "sqlite", client: db };
    }
  } catch (error) {
    await tunnel?.close().catch(() => {});
    throw error;
  }

  pool.set(id, { entry: newEntry, profile, lastUsedAt: Date.now() });
  console.log(`[pool] reconnected ${id} successfully`);
  return newEntry;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(message) as Error & { code?: string };
      error.code = "ETIMEDOUT";
      reject(error);
    }, timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/**
 * Check connections that have been idle long enough to plausibly have crossed
 * a server timeout or device sleep. A stuck ping is bounded, then the existing
 * profile is used to reconnect before the caller sends real work.
 */
export async function ensureConnectionAlive(
  id: string,
  force = false,
): Promise<{ entry: PoolEntry; reconnected: boolean }> {
  const record = pool.get(id);
  if (!record) throw new Error("Connection not found");
  if (record.entry.type === "sqlite") {
    record.lastUsedAt = Date.now();
    return { entry: record.entry, reconnected: false };
  }

  if (!force && Date.now() - record.lastUsedAt < IDLE_CHECK_AFTER_MS) {
    record.lastUsedAt = Date.now();
    return { entry: record.entry, reconnected: false };
  }

  try {
    if (record.entry.type === "postgres") {
      await withTimeout(record.entry.client`SELECT 1`, HEALTH_CHECK_TIMEOUT_MS, "PostgreSQL connection health check timed out");
    } else {
      await withTimeout(record.entry.client.ping(), HEALTH_CHECK_TIMEOUT_MS, "MySQL connection health check timed out");
    }
    record.lastUsedAt = Date.now();
    return { entry: record.entry, reconnected: false };
  } catch (error) {
    console.log(`[pool] idle connection check failed for ${id}: ${error instanceof Error ? error.message : String(error)}`);
    const entry = await reconnect(id);
    return { entry, reconnected: true };
  }
}
