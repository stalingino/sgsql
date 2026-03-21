import { sidecarFetch } from "./sidecar";
import type { ConnectionProfile } from "./types";

/* ── Response / domain types ─────────────────────────────── */

export interface TableInfo {
  name: string;
  type: "table" | "view";
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  udtName: string;
  nullable: boolean;
  defaultValue: string | null;
  isPk: boolean;
  isFk: boolean;
  position: number;
}

/* ── Sidecar API calls ───────────────────────────────────── */

export async function openConnection(
  profile: ConnectionProfile,
): Promise<{ connectionId: string; serverVersion: string }> {
  return sidecarFetch<{ connectionId: string; serverVersion: string }>("/connections/open", {
    method: "POST",
    body: JSON.stringify(profile),
  });
}

export async function closeConnection(connectionId: string): Promise<void> {
  await sidecarFetch("/connections/close", {
    method: "POST",
    body: JSON.stringify({ connectionId }),
  });
}

export async function fetchDatabases(connId: string): Promise<string[]> {
  const res = await sidecarFetch<{ databases: string[] }>(
    `/schema/${connId}/databases`,
  );
  return res.databases;
}

export async function fetchSchemas(
  connId: string,
  db: string,
): Promise<string[]> {
  const res = await sidecarFetch<{ schemas: string[] }>(
    `/schema/${connId}/schemas?db=${encodeURIComponent(db)}`,
  );
  return res.schemas;
}

export async function fetchTables(
  connId: string,
  db: string,
  schema: string,
): Promise<TableInfo[]> {
  const res = await sidecarFetch<{ tables: TableInfo[] }>(
    `/schema/${connId}/tables?db=${encodeURIComponent(db)}&schema=${encodeURIComponent(schema)}`,
  );
  return res.tables;
}

export async function fetchColumns(
  connId: string,
  db: string,
  schema: string,
  table: string,
): Promise<ColumnInfo[]> {
  const res = await sidecarFetch<{ columns: ColumnInfo[] }>(
    `/schema/${connId}/columns?db=${encodeURIComponent(db)}&schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(table)}`,
  );
  return res.columns;
}
