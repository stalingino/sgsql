import { create } from "zustand";

/* ── Types ─────────────────────────────────────────────── */

/** Identifies a specific row by its primary key values */
export interface RowKey {
  connectionId: string;
  connectionType: "postgres" | "mysql" | "sqlite";
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

export interface TableRefreshTarget {
  connectionId: string;
  db: string;
  schema: string;
  table: string;
}

export function tableRefreshKey(target: TableRefreshTarget): string {
  return `${target.connectionId}\u0000${target.db}\u0000${target.schema}\u0000${target.table}`;
}

/** Serialize a RowKey into a stable string for Map keys */
export function rowKeyId(rk: RowKey): string {
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

/* ── Row Operations ────────────────────────────────────── */

export interface PendingInsert {
  id: string;
  connectionId: string;
  connectionType: "postgres" | "mysql" | "sqlite";
  db: string;
  schema: string;
  table: string;
  columns: string[];
  values: Record<string, unknown>;
  timestamp: number;
}

export interface PendingDelete {
  id: string;
  rowKey: RowKey;
  /** Original row data for display */
  rowData: unknown[];
  columns: string[];
  timestamp: number;
}

export interface PendingSqlStatement {
  sql: string;
  type: "update" | "insert" | "delete";
  id: string;
  connectionId: string;
  db: string;
  schema: string;
  table: string;
  rowKey?: RowKey;
}

/* ── Store ─────────────────────────────────────────────── */

interface EditStoreState {
  /** All pending cell changes, keyed by cellKey */
  changes: Map<string, CellChange>;
  /** Pending row inserts */
  inserts: PendingInsert[];
  /** Pending row deletes */
  deletes: Map<string, PendingDelete>;

  /** Incremented after mutations so visible table data is refetched. */
  dataRevision: number;

  /** Per-table revisions used to refetch only open tables affected by a commit. */
  tableRevisions: Map<string, number>;

  /** Request a refetch of every open instance of the affected tables. */
  requestDataRefresh: (targets: TableRefreshTarget[]) => void;

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

  /** Get total change count — includes cell changes, inserts, deletes */
  changeCount: () => number;

  /** Revert a single cell change */
  revertCell: (rowKey: RowKey, column: string) => void;

  /** Revert all changes for a row */
  revertRow: (rowKey: RowKey) => void;

  /** Revert all changes */
  revertAll: () => void;

  /** Revert the most recent change (by timestamp) — cell change, insert, or delete */
  revertLast: () => void;

  /** Remove changes for a row (after successful save) */
  removeRow: (rowKey: RowKey) => void;

  /** Remove all changes (after successful save all) */
  removeAll: () => void;

  /** Build UPDATE SQL for a single row */
  buildRowUpdate: (rowKey: RowKey) => string | null;

  /** Build all UPDATE SQLs */
  buildAllUpdates: () => { sql: string; rowKey: RowKey }[];

  /* ── Row operations ─────────────────────────────────── */

  /** Add a new row (pending insert) */
  addInsert: (connectionId: string, connectionType: "postgres" | "mysql" | "sqlite", db: string, schema: string, table: string, columns: string[]) => string;

  /** Mark row(s) for deletion */
  addDelete: (rowKey: RowKey, rowData: unknown[], columns: string[]) => void;

  /** Check if a row is pending deletion */
  isRowDeleted: (rowKey: RowKey) => boolean;

  /** Remove a pending insert */
  removeInsert: (id: string) => void;

  /** Unmark a row from deletion */
  removeDelete: (rowKey: RowKey) => void;

  /** Get inserts for a specific table */
  getTableInserts: (connectionId: string, db: string, schema: string, table: string) => PendingInsert[];

  /** Get deletes for a specific table */
  getTableDeletes: (connectionId: string, db: string, schema: string, table: string) => PendingDelete[];

  /** Update a value in a pending insert */
  updateInsertValue: (id: string, column: string, value: unknown) => void;

  /** Build INSERT SQL for a pending insert */
  buildInsertSql: (id: string) => string | null;

  /** Build DELETE SQL for a pending delete */
  buildDeleteSql: (rowKey: RowKey) => string | null;

  /** Build all SQL statements (updates + inserts + deletes) */
  buildAllSql: () => PendingSqlStatement[];
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
function quoteIdent(type: "postgres" | "mysql" | "sqlite", name: string): string {
  if (type === "mysql") return `\`${name.replace(/`/g, "``")}\``;
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteTableRef(type: "postgres" | "mysql" | "sqlite", schema: string, table: string): string {
  if (!schema) return quoteIdent(type, table);
  return `${quoteIdent(type, schema)}.${quoteIdent(type, table)}`;
}

let insertCounter = 0;

export const useEditStore = create<EditStoreState>((set, get) => ({
  changes: new Map(),
  inserts: [],
  deletes: new Map(),
  dataRevision: 0,
  tableRevisions: new Map(),

  requestDataRefresh(targets) {
    set((state) => {
      const tableRevisions = new Map(state.tableRevisions);
      for (const key of new Set(targets.map(tableRefreshKey))) {
        tableRevisions.set(key, (tableRevisions.get(key) ?? 0) + 1);
      }
      return { dataRevision: state.dataRevision + 1, tableRevisions };
    });
  },

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
    for (const ins of get().inserts) {
      if (ins.connectionId === connectionId && ins.db === db && ins.schema === schema && ins.table === table) return true;
    }
    for (const key of get().deletes.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  },

  getAllChanges() {
    return Array.from(get().changes.values()).sort((a, b) => a.timestamp - b.timestamp);
  },

  changeCount() {
    return get().changes.size + get().inserts.length + get().deletes.size;
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
    set({ changes: new Map(), inserts: [], deletes: new Map() });
  },

  revertLast() {
    const { changes, inserts, deletes } = get();

    // Find the most recent item across all three collections
    let latestTs = -1;
    let latestType: "change" | "insert" | "delete" = "change";
    let latestId = "";

    for (const [key, change] of changes) {
      if (change.timestamp > latestTs) {
        latestTs = change.timestamp;
        latestType = "change";
        latestId = key;
      }
    }
    for (const ins of inserts) {
      if (ins.timestamp > latestTs) {
        latestTs = ins.timestamp;
        latestType = "insert";
        latestId = ins.id;
      }
    }
    for (const [key, del] of deletes) {
      if (del.timestamp > latestTs) {
        latestTs = del.timestamp;
        latestType = "delete";
        latestId = key;
      }
    }

    if (latestTs < 0) return;

    if (latestType === "change") {
      set((state) => {
        const next = new Map(state.changes);
        next.delete(latestId);
        return { changes: next };
      });
    } else if (latestType === "insert") {
      set((state) => ({
        inserts: state.inserts.filter((i) => i.id !== latestId),
      }));
    } else {
      set((state) => {
        const next = new Map(state.deletes);
        next.delete(latestId);
        return { deletes: next };
      });
    }
  },

  removeRow(rowKey) {
    get().revertRow(rowKey); // Same operation — just removes from store
  },

  removeAll() {
    set({ changes: new Map(), inserts: [], deletes: new Map() });
  },

  buildRowUpdate(rowKey) {
    const changes = get().getRowChanges(rowKey);
    if (changes.length === 0) return null;

    const setClauses = changes.map((c) =>
      `${quoteIdent(rowKey.connectionType, c.column)} = ${sqlValue(c.newValue)}`
    );

    const whereClauses = Object.entries(rowKey.pkValues).map(([col, val]) =>
      val === null
        ? `${quoteIdent(rowKey.connectionType, col)} IS NULL`
        : `${quoteIdent(rowKey.connectionType, col)} = ${sqlValue(val)}`
    );

    return `UPDATE ${quoteTableRef(rowKey.connectionType, rowKey.schema, rowKey.table)} SET ${setClauses.join(", ")} WHERE ${whereClauses.join(" AND ")}`;
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

  /* ── Row operations ─────────────────────────────────── */

  addInsert(connectionId, connectionType, db, schema, table, columns) {
    const id = `insert-${++insertCounter}-${Date.now()}`;
    const values: Record<string, unknown> = {};
    for (const col of columns) values[col] = null;
    set((state) => ({
      inserts: [...state.inserts, { id, connectionId, connectionType, db, schema, table, columns, values, timestamp: Date.now() }],
    }));
    return id;
  },

  addDelete(rowKey, rowData, columns) {
    const key = rowKeyId(rowKey);
    set((state) => {
      const next = new Map(state.deletes);
      if (next.has(key)) return {}; // already marked
      next.set(key, {
        id: key,
        rowKey,
        rowData,
        columns,
        timestamp: Date.now(),
      });
      return { deletes: next };
    });
  },

  isRowDeleted(rowKey) {
    return get().deletes.has(rowKeyId(rowKey));
  },

  removeInsert(id) {
    set((state) => ({
      inserts: state.inserts.filter((i) => i.id !== id),
    }));
  },

  removeDelete(rowKey) {
    set((state) => {
      const next = new Map(state.deletes);
      next.delete(rowKeyId(rowKey));
      return { deletes: next };
    });
  },

  getTableInserts(connectionId, db, schema, table) {
    return get().inserts.filter(
      (i) => i.connectionId === connectionId && i.db === db && i.schema === schema && i.table === table,
    );
  },

  getTableDeletes(connectionId, db, schema, table) {
    const prefix = `${connectionId}:${db}:${schema}:${table}:`;
    const result: PendingDelete[] = [];
    for (const [key, del] of get().deletes) {
      if (key.startsWith(prefix)) result.push(del);
    }
    return result;
  },

  updateInsertValue(id, column, value) {
    set((state) => ({
      inserts: state.inserts.map((i) =>
        i.id === id ? { ...i, values: { ...i.values, [column]: value }, timestamp: Date.now() } : i,
      ),
    }));
  },

  buildInsertSql(id) {
    const ins = get().inserts.find((i) => i.id === id);
    if (!ins) return null;
    const cols = ins.columns.filter((c) => ins.values[c] !== null && ins.values[c] !== undefined);
    if (cols.length === 0) {
      if (ins.connectionType === "mysql") {
        return `INSERT INTO ${quoteTableRef(ins.connectionType, ins.schema, ins.table)} () VALUES ()`;
      }
      return `INSERT INTO ${quoteTableRef(ins.connectionType, ins.schema, ins.table)} DEFAULT VALUES`;
    }
    const colList = cols.map((c) => quoteIdent(ins.connectionType, c)).join(", ");
    const valList = cols.map((c) => sqlValue(ins.values[c])).join(", ");
    return `INSERT INTO ${quoteTableRef(ins.connectionType, ins.schema, ins.table)} (${colList}) VALUES (${valList})`;
  },

  buildDeleteSql(rowKey) {
    const whereClauses = Object.entries(rowKey.pkValues).map(([col, val]) =>
      val === null
        ? `${quoteIdent(rowKey.connectionType, col)} IS NULL`
        : `${quoteIdent(rowKey.connectionType, col)} = ${sqlValue(val)}`,
    );
    return `DELETE FROM ${quoteTableRef(rowKey.connectionType, rowKey.schema, rowKey.table)} WHERE ${whereClauses.join(" AND ")}`;
  },

  buildAllSql() {
    const result: PendingSqlStatement[] = [];

    // Updates
    for (const { sql, rowKey } of get().buildAllUpdates()) {
      result.push({ sql, type: "update", id: rowKeyId(rowKey), connectionId: rowKey.connectionId, db: rowKey.db, schema: rowKey.schema, table: rowKey.table, rowKey });
    }

    // Inserts
    for (const ins of get().inserts) {
      const sql = get().buildInsertSql(ins.id);
      if (sql) result.push({ sql, type: "insert", id: ins.id, connectionId: ins.connectionId, db: ins.db, schema: ins.schema, table: ins.table });
    }

    // Deletes
    for (const [key, del] of get().deletes) {
      const sql = get().buildDeleteSql(del.rowKey);
      if (sql) result.push({ sql, type: "delete", id: key, connectionId: del.rowKey.connectionId, db: del.rowKey.db, schema: del.rowKey.schema, table: del.rowKey.table, rowKey: del.rowKey });
    }

    return result;
  },
}));

/* ── Helpers ───────────────────────────────────────────── */

/** Build a RowKey from context + row data */
export function buildRowKey(
  connectionId: string,
  connectionType: "postgres" | "mysql" | "sqlite",
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
  return { connectionId, connectionType, db, schema, table, pkValues };
}
