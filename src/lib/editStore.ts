import { create } from "zustand";

/* ── Types ─────────────────────────────────────────────── */

/** Identifies a specific row by its primary key values */
export interface RowKey {
  connectionId: string;
  db: string;
  schema: string;
  table: string;
  /** PK column names → values for this row */
  pkValues: Record<string, unknown>;
}

export interface CellChange {
  rowKey: RowKey;
  column: string;
  originalValue: unknown;
  newValue: unknown;
  /** Timestamp of the change */
  timestamp: number;
}

/** Serialize a RowKey into a stable string for Map keys */
function rowKeyId(rk: RowKey): string {
  const pkStr = Object.entries(rk.pkValues)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v === null ? "NULL" : String(v)}`)
    .join("&");
  return `${rk.connectionId}:${rk.db}:${rk.schema}:${rk.table}:${pkStr}`;
}

/** Serialize a cell change into a unique key */
function cellKey(rk: RowKey, column: string): string {
  return `${rowKeyId(rk)}:${column}`;
}

/* ── Store ─────────────────────────────────────────────── */

interface EditStoreState {
  /** All pending cell changes, keyed by cellKey */
  changes: Map<string, CellChange>;

  /** Set a cell change. If newValue equals originalValue, removes the change. */
  setChange: (rowKey: RowKey, column: string, originalValue: unknown, newValue: unknown) => void;

  /** Get the pending value for a cell, or undefined if not changed */
  getChange: (rowKey: RowKey, column: string) => CellChange | undefined;

  /** Get all changes for a specific row */
  getRowChanges: (rowKey: RowKey) => CellChange[];

  /** Check if a specific cell is dirty */
  isCellDirty: (rowKey: RowKey, column: string) => boolean;

  /** Check if a specific row is dirty */
  isRowDirty: (rowKey: RowKey) => boolean;

  /** Check if a specific table has any changes */
  isTableDirty: (connectionId: string, db: string, schema: string, table: string) => boolean;

  /** Get all changes */
  getAllChanges: () => CellChange[];

  /** Get total change count */
  changeCount: () => number;

  /** Revert a single cell change */
  revertCell: (rowKey: RowKey, column: string) => void;

  /** Revert all changes for a row */
  revertRow: (rowKey: RowKey) => void;

  /** Revert all changes */
  revertAll: () => void;

  /** Revert the most recent change (by timestamp) */
  revertLast: () => void;

  /** Remove changes for a row (after successful save) */
  removeRow: (rowKey: RowKey) => void;

  /** Remove all changes (after successful save all) */
  removeAll: () => void;

  /** Build UPDATE SQL for a single row */
  buildRowUpdate: (rowKey: RowKey) => string | null;

  /** Build all UPDATE SQLs */
  buildAllUpdates: () => { sql: string; rowKey: RowKey }[];
}

/** Sentinel for raw SQL expressions (DEFAULT, NOW(), etc.) */
export class SqlExpression {
  expr: string;
  label: string;
  constructor(expr: string, label: string) {
    this.expr = expr;
    this.label = label;
  }
}

/** Compare values for equality (handles null, numbers, strings, booleans) */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (b instanceof SqlExpression) return false; // Expression is always a change
  if (a === null && b === "NULL") return true;
  if (a === "NULL" && b === null) return true;
  if (typeof a === "number" && typeof b === "string") return String(a) === b;
  if (typeof a === "string" && typeof b === "number") return a === String(b);
  return false;
}

/** Escape a value for SQL */
function sqlValue(val: unknown): string {
  if (val instanceof SqlExpression) return val.expr;
  if (val === null || val === undefined || val === "NULL") return "NULL";
  if (typeof val === "number") return String(val);
  if (typeof val === "boolean") return val ? "TRUE" : "FALSE";
  // Escape single quotes
  return `'${String(val).replace(/'/g, "''")}'`;
}

/** Quote a column/table identifier */
function quoteIdent(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

export const useEditStore = create<EditStoreState>((set, get) => ({
  changes: new Map(),

  setChange(rowKey, column, originalValue, newValue) {
    set((state) => {
      const next = new Map(state.changes);
      const key = cellKey(rowKey, column);

      if (valuesEqual(originalValue, newValue)) {
        // Value reverted to original — remove the change
        next.delete(key);
      } else {
        next.set(key, {
          rowKey,
          column,
          originalValue,
          newValue,
          timestamp: Date.now(),
        });
      }
      return { changes: next };
    });
  },

  getChange(rowKey, column) {
    return get().changes.get(cellKey(rowKey, column));
  },

  getRowChanges(rowKey) {
    const prefix = rowKeyId(rowKey);
    const result: CellChange[] = [];
    for (const [key, change] of get().changes) {
      if (key.startsWith(prefix + ":")) {
        result.push(change);
      }
    }
    return result;
  },

  isCellDirty(rowKey, column) {
    return get().changes.has(cellKey(rowKey, column));
  },

  isRowDirty(rowKey) {
    const prefix = rowKeyId(rowKey);
    for (const key of get().changes.keys()) {
      if (key.startsWith(prefix + ":")) return true;
    }
    return false;
  },

  isTableDirty(connectionId, db, schema, table) {
    const prefix = `${connectionId}:${db}:${schema}:${table}:`;
    for (const key of get().changes.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  },

  getAllChanges() {
    return Array.from(get().changes.values()).sort((a, b) => a.timestamp - b.timestamp);
  },

  changeCount() {
    return get().changes.size;
  },

  revertCell(rowKey, column) {
    set((state) => {
      const next = new Map(state.changes);
      next.delete(cellKey(rowKey, column));
      return { changes: next };
    });
  },

  revertRow(rowKey) {
    set((state) => {
      const next = new Map(state.changes);
      const prefix = rowKeyId(rowKey);
      for (const key of next.keys()) {
        if (key.startsWith(prefix + ":")) next.delete(key);
      }
      return { changes: next };
    });
  },

  revertAll() {
    set({ changes: new Map() });
  },

  revertLast() {
    const changes = get().changes;
    if (changes.size === 0) return;

    // Find the change with the highest timestamp
    let latestKey: string | null = null;
    let latestTs = -1;
    for (const [key, change] of changes) {
      if (change.timestamp > latestTs) {
        latestTs = change.timestamp;
        latestKey = key;
      }
    }

    if (latestKey) {
      set((state) => {
        const next = new Map(state.changes);
        next.delete(latestKey);
        return { changes: next };
      });
    }
  },

  removeRow(rowKey) {
    get().revertRow(rowKey); // Same operation — just removes from store
  },

  removeAll() {
    set({ changes: new Map() });
  },

  buildRowUpdate(rowKey) {
    const changes = get().getRowChanges(rowKey);
    if (changes.length === 0) return null;

    const setClauses = changes.map((c) =>
      `${quoteIdent(c.column)} = ${sqlValue(c.newValue)}`
    );

    const whereClauses = Object.entries(rowKey.pkValues).map(([col, val]) =>
      val === null
        ? `${quoteIdent(col)} IS NULL`
        : `${quoteIdent(col)} = ${sqlValue(val)}`
    );

    return `UPDATE ${quoteIdent(rowKey.table)} SET ${setClauses.join(", ")} WHERE ${whereClauses.join(" AND ")}`;
  },

  buildAllUpdates() {
    // Group changes by row
    const rowMap = new Map<string, { rowKey: RowKey; changes: CellChange[] }>();
    for (const change of get().changes.values()) {
      const id = rowKeyId(change.rowKey);
      if (!rowMap.has(id)) {
        rowMap.set(id, { rowKey: change.rowKey, changes: [] });
      }
      rowMap.get(id)!.changes.push(change);
    }

    const updates: { sql: string; rowKey: RowKey }[] = [];
    for (const { rowKey } of rowMap.values()) {
      const sql = get().buildRowUpdate(rowKey);
      if (sql) updates.push({ sql, rowKey });
    }
    return updates;
  },
}));

/* ── Helpers ───────────────────────────────────────────── */

/** Build a RowKey from context + row data */
export function buildRowKey(
  connectionId: string,
  db: string,
  schema: string,
  table: string,
  columns: string[],
  row: unknown[],
  pkColumns: string[],
): RowKey {
  const pkValues: Record<string, unknown> = {};
  for (const pk of pkColumns) {
    const idx = columns.indexOf(pk);
    pkValues[pk] = idx >= 0 ? row[idx] : null;
  }
  return { connectionId, db, schema, table, pkValues };
}
