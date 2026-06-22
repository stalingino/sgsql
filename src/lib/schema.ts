import { SidecarHttpError, sidecarFetch } from "./sidecar";
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
  unique?: boolean;
  extra?: string;
  comment?: string;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  definition?: string;
  primary?: boolean;
  method?: string;
  predicate?: string;
  includeColumns?: string[];
  expressionSql?: string;
}

export interface ForeignKeyInfo {
  name: string;
  column: string;
  foreignSchema: string;
  foreignTable: string;
  foreignColumn: string;
  columns?: string[];
  foreignColumns?: string[];
  onUpdate?: string;
  onDelete?: string;
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

export async function reloadConnection(connectionId: string): Promise<void> {
  await sidecarFetch("/connections/reload", {
    method: "POST",
    body: JSON.stringify({ connectionId }),
  });
}

export async function ensureConnection(
  connectionId: string,
): Promise<{ ok: boolean; reconnected: boolean }> {
  try {
    return await sidecarFetch<{ ok: boolean; reconnected: boolean }>("/connections/ensure", {
      method: "POST",
      body: JSON.stringify({ connectionId }),
    });
  } catch (error) {
    // Vite can hot-reload a newer frontend while the already-running Tauri
    // sidecar still serves the previous route set. Let the legacy /query path
    // proceed until the application is restarted with the rebuilt sidecar.
    if (error instanceof SidecarHttpError && error.status === 404) {
      console.warn("[sidecar] running sidecar does not support connection preflight; restart SG SQL to activate it");
      return { ok: true, reconnected: false };
    }
    throw error;
  }
}

export async function cancelQuery(connectionId: string): Promise<{ ok: boolean; detail?: string }> {
  return sidecarFetch<{ ok: boolean; detail?: string }>("/cancel", {
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
  return res.tables.map((table) => ({
    ...table,
    type: String(table.type).toUpperCase().includes("VIEW") ? "view" : "table",
  }));
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
  where?: string,
): Promise<TableRowsResult> {
  let url = `/schema/${connId}/rows?db=${encodeURIComponent(db)}&schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(table)}&limit=${limit}&offset=${offset}`;
  if (orderBy) url += `&orderBy=${encodeURIComponent(orderBy)}`;
  if (where) url += `&where=${encodeURIComponent(where)}`;
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
  db?: string,
  signal?: AbortSignal,
): Promise<QueryResult> {
  return sidecarFetch<QueryResult>("/query", {
    method: "POST",
    body: JSON.stringify({ connectionId: connId, sql, db: db || undefined }),
    signal,
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
    udtName: c.formatted_type ?? c.udt_name ?? c.udtName ?? c.column_type ?? "",
    nullable: (c.is_nullable ?? c.nullable ?? "YES") === "YES",
    defaultValue: c.column_default ?? c.defaultValue ?? null,
    isPk: c.column_key === "PRI" || c.isPk === true,
    isFk: c.column_key === "MUL" || c.isFk === true,
    position: c.ordinal_position ?? c.position ?? 0,
    unique: c.column_key === "UNI" || c.isUnique === true,
    extra: c.extra ?? [c.collation_name ? `COLLATE ${c.collation_name}` : "", c.identity_clause ?? "", c.generation_clause ?? ""].filter(Boolean).join(" "),
    comment: c.comment ?? c.column_comment ?? "",
  }));
}

function schemaUrl(connId: string, action: string, db: string, schema: string, table: string) {
  return `/schema/${connId}/${action}?db=${encodeURIComponent(db)}&schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(table)}`;
}

export async function fetchIndexes(connId: string, db: string, schema: string, table: string): Promise<IndexInfo[]> {
  const res = await sidecarFetch<{ indexes: any[] }>(schemaUrl(connId, "indexes", db, schema, table));
  return res.indexes.map((index: any) => {
    const definition = index.indexdef ?? index.definition;
    const definitionColumns = typeof definition === "string"
      ? definition.match(/\((.*)\)/)?.[1]?.split(",").map((part: string) => part.trim().replace(/^['"`]|['"`]$/g, "")) ?? []
      : [];
    return {
      name: index.indexname ?? index.Key_name ?? index.name ?? "",
      columns: index.columns ?? (index.Column_name ? [index.Column_name] : definitionColumns),
      unique: index.unique === true || index.Non_unique === 0 || /CREATE\s+UNIQUE\s+INDEX/i.test(definition ?? ""),
      primary: index.primary === true || index.Key_name === "PRIMARY" || index.origin === "pk",
      definition,
      method: index.method ?? index.Index_type ?? (typeof definition === "string" ? /\bUSING\s+(\w+)/i.exec(definition)?.[1] : undefined),
      predicate: index.predicate ?? (typeof definition === "string" ? /\bWHERE\s+([\s\S]+)$/i.exec(definition)?.[1] : undefined),
      includeColumns: index.include_columns ?? (typeof definition === "string" ? /\bINCLUDE\s*\(([^)]+)\)/i.exec(definition)?.[1]?.split(",").map((part: string) => part.trim().replace(/^['"`]|['"`]$/g, "")) : undefined),
      expressionSql: index.expression_sql ?? index.Expression ?? undefined,
    };
  }).reduce<IndexInfo[]>((all, index) => {
    const existing = all.find((item) => item.name === index.name);
    if (existing) existing.columns.push(...index.columns.filter((column: string) => !existing.columns.includes(column)));
    else all.push(index);
    return all;
  }, []);
}

export async function fetchForeignKeys(connId: string, db: string, schema: string, table: string): Promise<ForeignKeyInfo[]> {
  const res = await sidecarFetch<{ foreignKeys: any[] }>(schemaUrl(connId, "fks", db, schema, table));
  return res.foreignKeys.map((fk: any) => ({
    name: fk.constraint_name ?? `fk_${table}_${fk.id ?? fk.column_name ?? ""}`,
    column: fk.column_name ?? "",
    foreignSchema: fk.foreign_table_schema ?? schema,
    foreignTable: fk.foreign_table_name ?? "",
    foreignColumn: fk.foreign_column_name ?? "",
    onUpdate: fk.on_update,
    onDelete: fk.on_delete,
  })).reduce<ForeignKeyInfo[]>((all, fk) => {
    const existing = all.find((item) => item.name === fk.name);
    if (existing) {
      existing.columns = [...(existing.columns ?? [existing.column]), fk.column];
      existing.foreignColumns = [...(existing.foreignColumns ?? [existing.foreignColumn]), fk.foreignColumn];
    } else {
      all.push({ ...fk, columns: [fk.column], foreignColumns: [fk.foreignColumn] });
    }
    return all;
  }, []);
}

export async function fetchTableDdl(connId: string, db: string, schema: string, table: string): Promise<string> {
  const res = await sidecarFetch<{ ddl: string }>(schemaUrl(connId, "ddl", db, schema, table));
  return res.ddl;
}

export async function fetchTableArtifacts(connId: string, db: string, schema: string, table: string): Promise<{ triggers: string[] }> {
  return sidecarFetch(schemaUrl(connId, "artifacts", db, schema, table));
}

export async function applySchemaChanges(connId: string, db: string, statements: string[], disableForeignKeys = false): Promise<{ ok: boolean; applied: number; atomic: boolean; duration: number }> {
  return sidecarFetch(`/schema/${connId}/apply`, {
    method: "POST",
    body: JSON.stringify({ statements, db, disableForeignKeys }),
  });
}
