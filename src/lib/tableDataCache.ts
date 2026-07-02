import type { ColumnInfo, TableRowsResult } from "./schema";

const MAX_ENTRIES = 100;
const rows = new Map<string, TableRowsResult>();
const columns = new Map<string, ColumnInfo[]>();

export interface TableRowsCacheTarget {
  connectionId: string;
  db: string;
  schema: string;
  table: string;
  offset: number;
  orderBy?: string;
  where?: string;
  tableRevision: number;
}

export interface TableColumnsCacheTarget {
  connectionId: string;
  db: string;
  schema: string;
  table: string;
}

function key(parts: unknown[]): string {
  return JSON.stringify(parts);
}

function rowsKey(target: TableRowsCacheTarget): string {
  return key([
    target.connectionId,
    target.db,
    target.schema,
    target.table,
    target.offset,
    target.orderBy ?? "",
    target.where ?? "",
    target.tableRevision,
  ]);
}

function columnsKey(target: TableColumnsCacheTarget): string {
  return key([target.connectionId, target.db, target.schema, target.table]);
}

function getLru<K, V>(cache: Map<K, V>, cacheKey: K): V | undefined {
  const value = cache.get(cacheKey);
  if (value === undefined) return undefined;
  cache.delete(cacheKey);
  cache.set(cacheKey, value);
  return value;
}

function setLru<K, V>(cache: Map<K, V>, cacheKey: K, value: V): void {
  cache.delete(cacheKey);
  cache.set(cacheKey, value);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function getCachedTableRows(target: TableRowsCacheTarget): TableRowsResult | undefined {
  return getLru(rows, rowsKey(target));
}

export function cacheTableRows(target: TableRowsCacheTarget, value: TableRowsResult): void {
  setLru(rows, rowsKey(target), value);
}

export function getCachedTableColumns(target: TableColumnsCacheTarget): ColumnInfo[] | undefined {
  return getLru(columns, columnsKey(target));
}

export function cacheTableColumns(target: TableColumnsCacheTarget, value: ColumnInfo[]): void {
  setLru(columns, columnsKey(target), value);
}

export function clearTableDataCache(): void {
  rows.clear();
  columns.clear();
}
