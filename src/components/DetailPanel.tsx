import { useCallback, useEffect, useRef, useState } from "react";
import { Save, Undo2 } from "lucide-react";
import type { CellSelection } from "./ResultGrid";
import { useEditStore, buildRowKey, SqlExpression, type RowKey } from "../lib/editStore";
import { useExecutionQueue } from "../lib/executionQueue";
import { useQueryLog } from "../lib/queryLog";

/* ── Detail Panel ──────────────────────────────────────── */

interface DetailPanelProps {
  selection: CellSelection | null;
  /** Was the panel already visible before the selection changed? */
  wasAlreadyOpen?: boolean;
}

export function DetailPanel({ selection, wasAlreadyOpen }: DetailPanelProps) {
  // Subscribe for reactivity on changes
  const _editChanges = useEditStore((s) => s.changes);
  const _editInserts = useEditStore((s) => s.inserts);
  void _editChanges; // subscribe for re-render
  void _editInserts;
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const isInsertRow = !!selection?.insertId;

  // Derive row key if we have table context (not for insert rows)
  const rowKey: RowKey | null =
    selection?.tableContext && !isInsertRow
      ? buildRowKey(
          selection.tableContext.connectionId,
          selection.tableContext.connectionType,
          selection.tableContext.db,
          selection.tableContext.schema,
          selection.tableContext.table,
          selection.columns,
          selection.row,
          selection.tableContext.pkColumns,
        )
      : null;

  // For insert rows, get the current values from the store
  const insertData = isInsertRow
    ? useEditStore.getState().inserts.find((i) => i.id === selection.insertId)
    : null;

  const rowDirty = rowKey ? useEditStore.getState().isRowDirty(rowKey) : false;
  const rowChanges = rowKey ? useEditStore.getState().getRowChanges(rowKey) : [];
  const canEdit = !!rowKey || isInsertRow;

  // Build column meta lookup
  const columnMeta = selection?.tableContext?.columnMeta;

  // Scroll to selected column field
  useEffect(() => {
    if (!selection || selection.colIndex < 0) return;
    const container = scrollContainerRef.current;
    if (!container) return;

    // Wait a tick for DOM
    requestAnimationFrame(() => {
      const fieldEl = container.querySelector(`[data-field-index="${selection.colIndex}"]`) as HTMLElement | null;
      if (!fieldEl) return;

      fieldEl.scrollIntoView({ behavior: "smooth", block: "nearest" });

      // Focus the input only if pane was just opened
      if (!wasAlreadyOpen) {
        const input = fieldEl.querySelector("input, textarea, select") as HTMLElement | null;
        input?.focus();
      }
    });
  }, [selection?.rowIndex, selection?.colIndex, wasAlreadyOpen]);

  if (!selection) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted text-xs px-4 text-center">
        Click a row to view details
      </div>
    );
  }

  const { columns } = selection;
  // For insert rows, use the store's current values; for regular rows, use the selection data
  const row = isInsertRow && insertData
    ? columns.map((col) => insertData.values[col] ?? null)
    : selection.row;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center h-9 px-3 border-b border-border-light bg-bg-secondary shrink-0">
        <span className={`text-[12px] font-bold ${isInsertRow ? "text-row-insert" : "text-text-primary"}`}>
          {isInsertRow ? "New Row" : "Row Details"}
        </span>
        <span className="ml-2 text-[10px] font-medium text-text-secondary">
          ({columns.length} fields)
        </span>
        {rowDirty && (
          <span className="ml-2 text-[10px] font-semibold text-warning">
            • Modified ({rowChanges.length})
          </span>
        )}
        <div className="flex-1" />
        {rowDirty && rowKey && (
          <div className="flex items-center gap-1">
            <RevertRowButton rowKey={rowKey} />
            <SaveRowButton rowKey={rowKey} />
          </div>
        )}
      </div>

      {/* Field list */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 pb-4 selectable">
        {columns.map((col, i) => {
          const value = (row as unknown[])[i];
          const meta = columnMeta?.find((m) => m.name === col);
          return (
            <FieldRow
              key={col}
              index={i}
              name={col}
              value={value}
              rowKey={rowKey}
              canEdit={canEdit}
              dataType={meta?.udtName || meta?.dataType || ""}
              defaultValue={meta?.defaultValue ?? null}
              insertId={isInsertRow ? selection.insertId : undefined}
            />
          );
        })}
      </div>
    </div>
  );
}

/* ── Save Row Button ─────────────────────────────────── */

function SaveRowButton({ rowKey }: { rowKey: RowKey }) {
  const execQueue = useExecutionQueue((s) => s.execute);
  const buildRowUpdate = useEditStore((s) => s.buildRowUpdate);
  const removeRow = useEditStore((s) => s.removeRow);
  const requestDataRefresh = useEditStore((s) => s.requestDataRefresh);

  const handleSave = useCallback(async () => {
    const sql = buildRowUpdate(rowKey);
    if (!sql) return;
    const startedAt = performance.now();
    try {
      const result = await execQueue(rowKey.connectionId, sql, rowKey.db);
      useQueryLog.getState().addEntry({
        timestamp: new Date(),
        query: sql,
        db: rowKey.db,
        schema: rowKey.schema,
        table: rowKey.table,
        duration: result.duration,
        rowCount: result.affectedRows ?? result.rowCount,
      });
      removeRow(rowKey);
      requestDataRefresh([rowKey]);
    } catch (err) {
      useQueryLog.getState().addEntry({
        timestamp: new Date(),
        query: sql,
        db: rowKey.db,
        schema: rowKey.schema,
        table: rowKey.table,
        duration: performance.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
      console.error("Failed to save row:", err);
    }
  }, [rowKey, execQueue, buildRowUpdate, removeRow, requestDataRefresh]);

  return (
    <button
      onClick={handleSave}
      title="Save this row"
      className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium text-success hover:bg-success/10 transition-colors cursor-pointer"
    >
      <Save size={10} />
      Save
    </button>
  );
}

/* ── Revert Row Button ────────────────────────────────── */

function RevertRowButton({ rowKey }: { rowKey: RowKey }) {
  const revertRow = useEditStore((s) => s.revertRow);

  return (
    <button
      onClick={() => revertRow(rowKey)}
      title="Revert changes to this row"
      className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
    >
      <Undo2 size={10} />
      Revert
    </button>
  );
}

/* ── Date/time type detection ─────────────────────────── */

const DATE_TIME_TYPES = new Set([
  "date", "datetime", "datetime2", "timestamp", "timestamptz",
  "timestamp without time zone", "timestamp with time zone",
  "time", "timetz", "time without time zone", "time with time zone",
]);

function isDateTimeType(dataType: string): boolean {
  return DATE_TIME_TYPES.has(dataType.toLowerCase());
}

/* ── Quick-set select ──────────────────────────────────── */

function QuickSetSelect({
  rowKey,
  column,
  originalValue,
  dataType,
  defaultValue,
  insertId,
}: {
  rowKey: RowKey | null;
  column: string;
  originalValue: unknown;
  dataType: string;
  defaultValue: string | null;
  insertId?: string;
}) {
  const showNow = isDateTimeType(dataType);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    if (!v) return;
    let newVal: unknown;
    if (v === "__null__") newVal = null;
    else if (v === "__empty__") newVal = "";
    else if (v === "__default__") newVal = new SqlExpression("DEFAULT", "DEFAULT");
    else if (v === "__now__") newVal = new SqlExpression("NOW()", "NOW()");
    else return;

    if (insertId) {
      useEditStore.getState().updateInsertValue(insertId, column, newVal);
    } else if (rowKey) {
      useEditStore.getState().setChange(rowKey, column, originalValue, newVal);
    }
    e.target.value = "";
  }, [rowKey, column, originalValue, insertId]);

  return (
    <select
      onChange={handleChange}
      defaultValue=""
      className="text-[9px] text-text-primary bg-transparent border-none outline-none cursor-pointer pl-1 pr-0 w-4"
      title="Set value..."
    >
      <option value="" disabled hidden></option>
      <option value="__null__">NULL</option>
      <option value="__empty__">EMPTY ''</option>
      {defaultValue !== null && <option value="__default__">DEFAULT ({defaultValue})</option>}
      {showNow && <option value="__now__">NOW()</option>}
    </select>
  );
}

/* ── Individual field row ──────────────────────────────── */

function FieldRow({
  index,
  name,
  value,
  rowKey,
  canEdit,
  dataType,
  defaultValue,
  insertId,
}: {
  index: number;
  name: string;
  value: unknown;
  rowKey: RowKey | null;
  canEdit: boolean;
  dataType: string;
  defaultValue: string | null;
  insertId?: string;
}) {
  const isNull = value === null || value === undefined;
  const isBoolean = typeof value === "boolean";
  const _editChanges = useEditStore((s) => s.changes);
  void _editChanges; // subscribe for re-render

  // Get pending edit value from store
  const pendingChange = rowKey ? useEditStore.getState().getChange(rowKey, name) : undefined;
  const isDirty = insertId ? (value !== null && value !== undefined) : !!pendingChange;
  const effectiveValue = insertId ? value : (pendingChange?.newValue ?? value);

  // Check if the pending value is a SqlExpression
  const isSqlExpr = effectiveValue instanceof SqlExpression;

  // For NULL fields: show placeholder instead of "NULL" as editable text
  const isCurrentlyNull = effectiveValue === null || effectiveValue === undefined;

  // Track whether a NULL field is being actively edited
  const [nullEditing, setNullEditing] = useState(false);
  const [nullEditText, setNullEditText] = useState("");

  const displayValue = isSqlExpr
    ? (effectiveValue as SqlExpression).label
    : isCurrentlyNull && !nullEditing
      ? ""
      : formatValue(effectiveValue);

  const handleChange = useCallback((newVal: string) => {
    if (!canEdit) return;

    // Convert typed value back
    let parsed: unknown = newVal;
    if (newVal === "" && (isNull || isCurrentlyNull)) {
      parsed = null;
    } else if (isBoolean) {
      parsed = newVal === "true";
    } else if (typeof value === "number" && !isNaN(Number(newVal)) && newVal !== "") {
      parsed = Number(newVal);
    }

    if (insertId) {
      // For insert rows, update the insert store
      useEditStore.getState().updateInsertValue(insertId, name, parsed);
    } else if (rowKey) {
      useEditStore.getState().setChange(rowKey, name, value, parsed);
    }
  }, [rowKey, name, value, canEdit, isBoolean, isNull, isCurrentlyNull, insertId]);

  const handleNullFocus = useCallback(() => {
    if (isCurrentlyNull) {
      setNullEditing(true);
      setNullEditText("");
    }
  }, [isCurrentlyNull]);

  const handleNullBlur = useCallback(() => {
    if (nullEditing && nullEditText === "") {
      setNullEditing(false);
    }
  }, [nullEditing, nullEditText]);

  const handleNullChange = useCallback((newVal: string) => {
    setNullEditText(newVal);
    handleChange(newVal);
  }, [handleChange]);

  const fieldClasses = `px-3 py-2 border-b border-border/70 ${isDirty ? (insertId ? "bg-row-insert/8 border-l-2 border-l-row-insert" : "bg-warning/8 border-l-2 border-l-warning") : ""}`;
  const inputBorder = isDirty ? (insertId ? "border-row-insert/60" : "border-warning/60") : "border-border-light";

  return (
    <div className={fieldClasses} data-field-index={index}>
      {/* Column name + quick-set */}
      <div className="flex items-center gap-1 min-w-0">
        <div className="flex items-baseline gap-1 min-w-0 flex-1 overflow-hidden">
          <span className={`text-[12px] font-bold cursor-text truncate shrink-0 ${isDirty ? (insertId ? "text-row-insert" : "text-warning") : "text-text-primary"}`}>
            {name}
            {isDirty && !insertId && <span className="ml-1 text-[9px] text-warning/70">modified</span>}
          </span>
          <span className="text-[10px] font-medium text-text-secondary font-mono truncate">{dataType}</span>
        </div>
        {canEdit && (rowKey || insertId) && (
          <QuickSetSelect
            rowKey={rowKey}
            column={name}
            originalValue={value}
            dataType={dataType}
            defaultValue={defaultValue}
            insertId={insertId}
          />
        )}
      </div>

      {/* Value — editable */}
      <div className="mt-1">
        {isSqlExpr ? (
          /* Show SQL expression as read-only styled badge */
          <div
            className={`w-full px-2 py-1 text-[12px] font-mono font-semibold text-accent bg-accent/8 border rounded ${inputBorder}`}
          >
            {displayValue}
          </div>
        ) : isCurrentlyNull && !nullEditing ? (
          <input
            type="text"
            value=""
            placeholder="NULL"
            onFocus={handleNullFocus}
            onChange={(e) => handleNullChange(e.target.value)}
            readOnly={!canEdit}
            className={`w-full px-2.5 py-1.5 text-[12px] font-mono italic placeholder:text-text-muted text-text-secondary bg-bg-primary border rounded-md outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors ${inputBorder}`}
          />
        ) : nullEditing ? (
          <input
            type="text"
            value={nullEditText}
            onChange={(e) => handleNullChange(e.target.value)}
            onBlur={handleNullBlur}
            autoFocus
            className={`w-full px-2.5 py-1.5 text-[12px] font-mono text-text-primary bg-bg-primary border rounded-md outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors ${inputBorder}`}
          />
        ) : isBoolean ? (
          <select
            value={displayValue}
            onChange={(e) => handleChange(e.target.value)}
            disabled={!canEdit}
            className={`w-full px-2.5 py-1.5 text-[12px] font-mono text-text-primary bg-bg-primary border rounded-md outline-none cursor-pointer focus:border-accent transition-colors ${inputBorder}`}
          >
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        ) : typeof value === "object" && value !== null ? (
          <textarea
            value={displayValue}
            onChange={(e) => handleChange(e.target.value)}
            readOnly={!canEdit}
            style={{ fieldSizing: "content" as any, minHeight: "2lh", maxHeight: "12lh" }}
            className={`w-full px-2.5 py-1.5 text-[12px] font-mono text-text-primary bg-bg-primary border rounded-md outline-none resize-y focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors ${inputBorder}`}
          />
        ) : typeof value === "number" || (!insertId && typeof pendingChange?.originalValue === "number") ? (
          <input
            type="text"
            value={displayValue}
            onChange={(e) => handleChange(e.target.value)}
            readOnly={!canEdit}
            className={`w-full px-2.5 py-1.5 text-[12px] font-mono font-medium tabular-nums text-accent bg-bg-primary border rounded-md outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors ${inputBorder}`}
          />
        ) : (
          /* String / default */
          String(displayValue).length > 80 ? (
            <textarea
              value={displayValue}
              onChange={(e) => handleChange(e.target.value)}
              readOnly={!canEdit}
              style={{ fieldSizing: "content" as any, minHeight: "2lh", maxHeight: "12lh" }}
              className={`w-full px-2.5 py-1.5 text-[12px] font-mono text-text-primary bg-bg-primary border rounded-md outline-none resize-y focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors ${inputBorder}`}
            />
          ) : (
            <input
              type="text"
              value={displayValue}
              onChange={(e) => handleChange(e.target.value)}
              readOnly={!canEdit}
              className={`w-full px-2.5 py-1.5 text-[12px] font-mono text-text-primary bg-bg-primary border rounded-md outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors ${inputBorder}`}
            />
          )
        )}
      </div>
    </div>
  );
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}
