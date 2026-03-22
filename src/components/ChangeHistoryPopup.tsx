import { useCallback, useEffect, useRef, useState } from "react";
import { Save, Undo2, X, Loader2 } from "lucide-react";
import { useEditStore, SqlExpression, type CellChange, type RowKey } from "../lib/editStore";
import { useExecutionQueue } from "../lib/executionQueue";

interface ChangeHistoryPopupProps {
  onClose: () => void;
}

export function ChangeHistoryPopup({ onClose }: ChangeHistoryPopupProps) {
  const changes = useEditStore((s) => s.changes);
  const allChanges = useEditStore.getState().getAllChanges();
  const popupRef = useRef<HTMLDivElement>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  // Group changes by row
  const groupedByRow = groupChangesByRow(allChanges);

  const execQueue = useExecutionQueue((s) => s.execute);
  const buildRowUpdate = useEditStore.getState().buildRowUpdate;
  const removeRow = useEditStore.getState().removeRow;
  const revertRow = useEditStore.getState().revertRow;
  const revertAll = useEditStore.getState().revertAll;
  const revertCell = useEditStore.getState().revertCell;

  const handleSaveRow = useCallback(async (rowKey: RowKey) => {
    const sql = buildRowUpdate(rowKey);
    if (!sql) return;
    setSaving(true);
    setError(null);
    try {
      await execQueue(rowKey.connectionId, sql, rowKey.db);
      removeRow(rowKey);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [execQueue, buildRowUpdate, removeRow]);

  const handleSaveAll = useCallback(async () => {
    const updates = useEditStore.getState().buildAllUpdates();
    if (updates.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      for (const { sql, rowKey } of updates) {
        await execQueue(rowKey.connectionId, sql, rowKey.db);
        removeRow(rowKey);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [execQueue, removeRow]);

  const handleRevertAll = useCallback(() => {
    revertAll();
  }, [revertAll]);

  if (changes.size === 0) {
    onClose();
    return null;
  }

  return (
    <div
      ref={popupRef}
      className="absolute right-12 top-10 w-[420px] max-h-[480px] rounded-lg border border-border bg-bg-primary shadow-2xl z-[100] flex flex-col"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-bg-secondary rounded-t-lg">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-semibold text-text-primary">
            Pending Changes
          </span>
          <span className="text-[10px] text-text-muted px-1.5 py-0.5 rounded-full bg-warning/15 text-warning font-semibold">
            {changes.size}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleRevertAll}
            disabled={saving}
            className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer disabled:opacity-40"
          >
            <Undo2 size={10} />
            Revert All
          </button>
          <button
            onClick={handleSaveAll}
            disabled={saving}
            className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium text-success hover:bg-success/10 transition-colors cursor-pointer disabled:opacity-40"
          >
            {saving ? <Loader2 size={10} className="animate-spin" /> : <Save size={10} />}
            Save All
          </button>
          <button
            onClick={onClose}
            className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
          >
            <X size={12} />
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
        {groupedByRow.map((group) => (
          <RowChangeGroup
            key={rowGroupKey(group.rowKey)}
            rowKey={group.rowKey}
            changes={group.changes}
            onSave={() => handleSaveRow(group.rowKey)}
            onRevert={() => revertRow(group.rowKey)}
            onRevertCell={(col) => revertCell(group.rowKey, col)}
            saving={saving}
          />
        ))}
      </div>
    </div>
  );
}

/* ── Row Change Group ─────────────────────────────────── */

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
      {/* Row header */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-bg-secondary/50">
        <div className="flex items-center gap-1.5 min-w-0">
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

      {/* Individual field changes */}
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
