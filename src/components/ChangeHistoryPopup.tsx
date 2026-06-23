import { useCallback, useEffect, useState } from "react";
import { Save, Undo2, Loader2, Plus, Trash2 } from "lucide-react";
import { useEditStore, SqlExpression, type CellChange, type RowKey, type PendingInsert, type PendingDelete } from "../lib/editStore";
import { useExecutionQueue } from "../lib/executionQueue";

export function ChangeHistoryPanel() {
  const changes = useEditStore((s) => s.changes);
  const inserts = useEditStore((s) => s.inserts);
  const deletes = useEditStore((s) => s.deletes);
  const allChanges = useEditStore.getState().getAllChanges();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Global saves run outside this component. Once the pending set changes,
  // the failure no longer describes the current edits.
  useEffect(() => {
    if (error) setError(null);
  }, [changes, inserts, deletes]);

  // Group cell changes by row
  const groupedByRow = groupChangesByRow(allChanges);

  const execQueue = useExecutionQueue((s) => s.execute);
  const store = useEditStore.getState();

  const handleSaveRow = useCallback(async (rowKey: RowKey) => {
    const sql = store.buildRowUpdate(rowKey);
    if (!sql) return;
    setSaving(true);
    setError(null);
    try {
      await execQueue(rowKey.connectionId, sql, rowKey.db);
      store.removeRow(rowKey);
      store.requestDataRefresh([rowKey]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [execQueue, store]);

  const handleSaveAll = useCallback(async () => {
    const statements = useEditStore.getState().buildAllSql();
    if (statements.length === 0) return;
    setSaving(true);
    setError(null);
    const refreshedTables = [];
    try {
      for (const { sql, type, id, connectionId, db, schema, table, rowKey } of statements) {
        const s = useEditStore.getState();
        await execQueue(connectionId, sql, db);

        // Remove from store
        if (type === "update") {
          if (rowKey) s.removeRow(rowKey);
        } else if (type === "insert") {
          s.removeInsert(id);
        } else if (type === "delete") {
          if (rowKey) s.removeDelete(rowKey);
        }
        refreshedTables.push({ connectionId, db, schema, table });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (refreshedTables.length > 0) {
        useEditStore.getState().requestDataRefresh(refreshedTables);
      }
      setSaving(false);
    }
  }, [execQueue]);

  const handleRevertAll = useCallback(() => {
    useEditStore.getState().revertAll();
  }, []);

  const totalCount = changes.size + inserts.length + deletes.size;

  return (
    <div className="flex flex-col h-full min-h-0 selectable bg-bg-primary">
      {/* Header */}
      <div className="flex items-center justify-between h-8 px-3 border-b border-border bg-bg-secondary shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold text-text-secondary uppercase tracking-wider">
            Pending Changes
          </span>
          <span className="text-[10px] text-text-muted px-1.5 py-0.5 rounded-full bg-warning/15 text-warning font-semibold">
            {totalCount}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleRevertAll}
            disabled={saving || totalCount === 0}
            className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer disabled:opacity-40"
          >
            <Undo2 size={10} />
            Revert All
          </button>
          <button
            onClick={handleSaveAll}
            disabled={saving || totalCount === 0}
            className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium text-success hover:bg-success/10 transition-colors cursor-pointer disabled:opacity-40"
          >
            {saving ? <Loader2 size={10} className="animate-spin" /> : <Save size={10} />}
            Save All
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="px-3 py-2 text-[11px] text-error bg-error/5 border-b border-border">
          {error}
        </div>
      )}

      {/* Changes list */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {totalCount === 0 && (
          <div className="flex items-center justify-center h-full text-text-muted text-[11px]">
            No pending changes
          </div>
        )}
        {/* Cell changes grouped by row */}
        {groupedByRow.map((group) => (
          <RowChangeGroup
            key={rowGroupKey(group.rowKey)}
            rowKey={group.rowKey}
            changes={group.changes}
            onSave={() => handleSaveRow(group.rowKey)}
            onRevert={() => store.revertRow(group.rowKey)}
            onRevertCell={(col) => store.revertCell(group.rowKey, col)}
            saving={saving}
          />
        ))}

        {/* Pending inserts */}
        {inserts.map((ins) => (
          <InsertGroup
            key={ins.id}
            insert={ins}
            onRevert={() => store.removeInsert(ins.id)}
            saving={saving}
          />
        ))}

        {/* Pending deletes */}
        {Array.from(deletes.values()).map((del) => (
          <DeleteGroup
            key={del.id}
            del={del}
            onRevert={() => store.removeDelete(del.rowKey)}
            saving={saving}
          />
        ))}
      </div>
    </div>
  );
}

/* ── Row Change Group (updates) ──────────────────────── */

function RowChangeGroup({
  rowKey,
  changes,
  onSave,
  onRevert,
  onRevertCell,
  saving,
}: {
  rowKey: RowKey;
  changes: CellChange[];
  onSave: () => void;
  onRevert: () => void;
  onRevertCell: (col: string) => void;
  saving: boolean;
}) {
  const pkDisplay = Object.entries(rowKey.pkValues)
    .map(([k, v]) => `${k}=${v === null ? "NULL" : String(v)}`)
    .join(", ");

  return (
    <div className="border-b border-border/50">
      <div className="flex items-center justify-between px-3 py-1.5 bg-bg-secondary/50">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-[10px] font-bold text-warning uppercase">UPD</span>
          <span className="text-[11px] font-semibold text-text-secondary truncate">
            {rowKey.table}
          </span>
          <span className="text-[10px] text-text-muted truncate">
            ({pkDisplay})
          </span>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            onClick={onRevert}
            disabled={saving}
            title="Revert row"
            className="p-0.5 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer disabled:opacity-40"
          >
            <Undo2 size={10} />
          </button>
          <button
            onClick={onSave}
            disabled={saving}
            title="Save row"
            className="p-0.5 rounded text-success hover:bg-success/10 transition-colors cursor-pointer disabled:opacity-40"
          >
            <Save size={10} />
          </button>
        </div>
      </div>

      {changes.map((change) => (
        <div key={change.column} className="flex items-center gap-2 px-3 py-1 text-[11px] font-mono hover:bg-bg-hover/50 group">
          <span className="text-text-muted w-[100px] truncate shrink-0" title={change.column}>
            {change.column}
          </span>
          <span className="text-text-muted/50 line-through truncate max-w-[100px]" title={formatVal(change.originalValue)}>
            {formatVal(change.originalValue)}
          </span>
          <span className="text-text-muted/50">→</span>
          <span className="text-warning truncate flex-1" title={formatVal(change.newValue)}>
            {formatVal(change.newValue)}
          </span>
          <button
            onClick={() => onRevertCell(change.column)}
            className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-text-muted hover:text-text-primary transition-all cursor-pointer"
            title="Revert this field"
          >
            <Undo2 size={9} />
          </button>
        </div>
      ))}
    </div>
  );
}

/* ── Insert Group ─────────────────────────────────────── */

function InsertGroup({
  insert,
  onRevert,
  saving,
}: {
  insert: PendingInsert;
  onRevert: () => void;
  saving: boolean;
}) {
  const nonNullValues = Object.entries(insert.values).filter(([, v]) => v !== null && v !== undefined);

  return (
    <div className="border-b border-border/50">
      <div className="flex items-center justify-between px-3 py-1.5 bg-success/5">
        <div className="flex items-center gap-1.5 min-w-0">
          <Plus size={10} className="text-success shrink-0" />
          <span className="text-[10px] font-bold text-success uppercase">INS</span>
          <span className="text-[11px] font-semibold text-text-secondary truncate">
            {insert.table}
          </span>
          <span className="text-[10px] text-text-muted">
            ({nonNullValues.length} field{nonNullValues.length !== 1 ? "s" : ""})
          </span>
        </div>
        <button
          onClick={onRevert}
          disabled={saving}
          title="Remove insert"
          className="p-0.5 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer disabled:opacity-40"
        >
          <Undo2 size={10} />
        </button>
      </div>
      {nonNullValues.length > 0 && (
        <div className="px-3 py-1 text-[11px] font-mono text-success/80 truncate">
          {nonNullValues.map(([k, v]) => `${k}=${formatVal(v)}`).join(", ")}
        </div>
      )}
    </div>
  );
}

/* ── Delete Group ─────────────────────────────────────── */

function DeleteGroup({
  del,
  onRevert,
  saving,
}: {
  del: PendingDelete;
  onRevert: () => void;
  saving: boolean;
}) {
  const pkDisplay = Object.entries(del.rowKey.pkValues)
    .map(([k, v]) => `${k}=${v === null ? "NULL" : String(v)}`)
    .join(", ");

  return (
    <div className="border-b border-border/50">
      <div className="flex items-center justify-between px-3 py-1.5 bg-row-delete/5">
        <div className="flex items-center gap-1.5 min-w-0">
          <Trash2 size={10} className="text-row-delete shrink-0" />
          <span className="text-[10px] font-bold text-row-delete uppercase">DEL</span>
          <span className="text-[11px] font-semibold text-text-secondary truncate">
            {del.rowKey.table}
          </span>
          <span className="text-[10px] text-text-muted truncate">
            ({pkDisplay})
          </span>
        </div>
        <button
          onClick={onRevert}
          disabled={saving}
          title="Undo delete"
          className="p-0.5 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer disabled:opacity-40"
        >
          <Undo2 size={10} />
        </button>
      </div>
    </div>
  );
}

/* ── Helpers ───────────────────────────────────────────── */

function formatVal(v: unknown): string {
  if (v instanceof SqlExpression) return v.label;
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function rowGroupKey(rk: RowKey): string {
  const pkStr = Object.entries(rk.pkValues)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return `${rk.connectionId}:${rk.db}:${rk.schema}:${rk.table}:${pkStr}`;
}

interface RowGroup {
  rowKey: RowKey;
  changes: CellChange[];
}

function groupChangesByRow(changes: CellChange[]): RowGroup[] {
  const map = new Map<string, RowGroup>();
  for (const change of changes) {
    const key = rowGroupKey(change.rowKey);
    if (!map.has(key)) {
      map.set(key, { rowKey: change.rowKey, changes: [] });
    }
    map.get(key)!.changes.push(change);
  }
  return Array.from(map.values());
}
