import type { Sql } from "postgres";
import type { Connection } from "mysql2/promise";
import { Database } from "bun:sqlite";

export type PoolEntry =
  | { type: "postgres"; client: Sql }
  | { type: "mysql"; client: Connection }
  | { type: "sqlite"; client: Database };

const pool = new Map<string, PoolEntry>();

export function getConnection(id: string): PoolEntry | undefined {
  return pool.get(id);
}

export function setConnection(id: string, entry: PoolEntry): void {
  pool.set(id, entry);
}

export async function closeConnection(id: string): Promise<boolean> {
  const entry = pool.get(id);
  if (!entry) return false;

  try {
    switch (entry.type) {
      case "postgres":
        await entry.client.end();
        break;
      case "mysql":
        await entry.client.end();
        break;
      case "sqlite":
        entry.client.close();
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
