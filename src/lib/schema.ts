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

export interface TableRowsResult {
  columns: string[];
  rows: unknown[][];
  totalEstimate: number;
  query: string;
}

export async function fetchTableRows(
  connId: string,
  db: string,
  schema: string,
  table: string,
  limit = 50,
  offset = 0,
  orderBy?: string,
): Promise<TableRowsResult> {
  let url = `/schema/${connId}/rows?db=${encodeURIComponent(db)}&schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(table)}&limit=${limit}&offset=${offset}`;
  if (orderBy) url += `&orderBy=${encodeURIComponent(orderBy)}`;
  return sidecarFetch<TableRowsResult>(url);
}

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  query: string;
  duration: number;
  affectedRows?: number;
}

export async function executeQuery(
  connId: string,
  sql: string,
): Promise<QueryResult> {
  return sidecarFetch<QueryResult>("/query", {
    method: "POST",
    body: JSON.stringify({ connectionId: connId, sql }),
  });
}

export async function fetchColumns(
  connId: string,
  db: string,
  schema: string,
  table: string,
): Promise<ColumnInfo[]> {
  const res = await sidecarFetch<{ columns: any[] }>(
    `/schema/${connId}/columns?db=${encodeURIComponent(db)}&schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(table)}`,
  );
  return res.columns.map((c: any) => ({
    name: c.column_name ?? c.name ?? "",
    dataType: c.data_type ?? c.dataType ?? "",
    udtName: c.udt_name ?? c.udtName ?? c.column_type ?? "",
    nullable: (c.is_nullable ?? c.nullable ?? "YES") === "YES",
    defaultValue: c.column_default ?? c.defaultValue ?? null,
    isPk: c.column_key === "PRI" || c.isPk === true,
    isFk: c.column_key === "MUL" || c.isFk === true,
    position: c.ordinal_position ?? c.position ?? 0,
  }));
}
