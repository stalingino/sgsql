import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Save, Search, Undo2, X } from "lucide-react";
import type { CellSelection } from "./ResultGrid";
import { useEditStore, buildRowKey, SqlExpression, type RowKey } from "../lib/editStore";
import { useExecutionQueue } from "../lib/executionQueue";
import { fuzzySearch } from "../lib/fuzzySearch";
import { formatDateTimeValue } from "../lib/formatDateTime";

/* ── Detail Panel ──────────────────────────────────────── */

interface DetailPanelProps {
  selection: CellSelection | null;
  /** Was the panel already visible before the selection changed? */
  wasAlreadyOpen?: boolean;
  /** Reveal the corresponding table cell while leaving focus in this panel. */
  onFieldActivate?: (columnIndex: number) => void;
}

export function DetailPanel({ selection, wasAlreadyOpen, onFieldActivate }: DetailPanelProps) {
  // Subscribe for reactivity on changes
  const _editChanges = useEditStore((s) => s.changes);
  const _editInserts = useEditStore((s) => s.inserts);
  void _editChanges; // subscribe for re-render
  void _editInserts;
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState("");

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
  const visibleFieldIndexes = useMemo(() => {
    if (!selection) return [];
    const fields = selection.columns.map((column, index) => {
      const meta = selection.tableContext?.columnMeta?.find((candidate) => candidate.name === column);
      const originalValue = isInsertRow && insertData
        ? insertData.values[column] ?? null
        : selection.row[index];
      const pendingChange = rowKey
        ? useEditStore.getState().getChange(rowKey, column)
        : undefined;
      const value = pendingChange ? pendingChange.newValue : originalValue;
      return {
        index,
        column,
        dataType: meta?.udtName || meta?.dataType || "",
        value: formatFilterValue(value),
      };
    });
    return fuzzySearch(fields, filter, {
      keys: [{ name: "column", weight: 2 }, "dataType", "value"],
    }).map(({ index }) => index);
  }, [selection, filter, isInsertRow, insertData, rowKey, _editChanges, _editInserts]);

  // Scroll to selected column field
  useEffect(() => {
    if (!selection || selection.colIndex < 0) return;
    // When a field filter is active the list is reordered/narrowed, so jumping
    // to the clicked cell's field is disorienting — leave the scroll position put.
    if (filter.trim()) return;
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
  }, [selection?.rowIndex, selection?.colIndex, wasAlreadyOpen, filter]);

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

      <div className="relative shrink-0 px-3 py-2 border-b border-border-light bg-bg-secondary/50">
        <Search size={12} className="absolute left-5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter fields"
          aria-label="Filter row detail fields"
          className="w-full h-7 pl-7 pr-7 rounded-md border border-border-light bg-bg-primary text-[11px] text-text-primary placeholder:text-text-muted outline-none focus:border-accent focus:ring-1 focus:ring-accent/30"
        />
        {filter && (
          <button
            onClick={() => setFilter("")}
            title="Clear filter"
            className="absolute right-5 top-1/2 -translate-y-1/2 p-0.5 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover cursor-pointer"
          >
            <X size={11} />
          </button>
        )}
      </div>

      {/* Field list */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 pb-4 selectable">
        {visibleFieldIndexes.map((i) => {
          const col = columns[i];
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
              enumValues={meta?.enumValues}
              defaultValue={meta?.defaultValue ?? null}
              insertId={isInsertRow ? selection.insertId : undefined}
              onActivate={onFieldActivate}
            />
          );
        })}
        {visibleFieldIndexes.length === 0 && (
          <div className="px-4 py-8 text-center text-xs text-text-muted">No matching fields</div>
        )}
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
    try {
      await execQueue(rowKey.connectionId, sql, rowKey.db);
      removeRow(rowKey);
      requestDataRefresh([rowKey]);
    } catch (err) {
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
const ENUM_NULL_VALUE = "__sgsql_null__";

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
  enumValues,
  defaultValue,
  insertId,
  onActivate,
}: {
  index: number;
  name: string;
  value: unknown;
  rowKey: RowKey | null;
  canEdit: boolean;
  dataType: string;
  enumValues?: string[];
  defaultValue: string | null;
  insertId?: string;
  onActivate?: (columnIndex: number) => void;
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

  const commitValue = useCallback((parsed: unknown) => {
    if (!canEdit) return;
    if (insertId) {
      useEditStore.getState().updateInsertValue(insertId, name, parsed);
    } else if (rowKey) {
      useEditStore.getState().setChange(rowKey, name, value, parsed);
    }
  }, [rowKey, name, value, canEdit, insertId]);

  const handleChange = useCallback((newVal: string) => {
    // Convert typed value back
    let parsed: unknown = newVal;
    if (newVal === "" && (isNull || isCurrentlyNull)) {
      parsed = null;
    } else if (isBoolean) {
      parsed = newVal === "true";
    } else if (typeof value === "number" && !isNaN(Number(newVal)) && newVal !== "") {
      parsed = Number(newVal);
    }
    commitValue(parsed);
  }, [commitValue, isBoolean, isNull, isCurrentlyNull, value]);

  const handleEnumChange = useCallback((newVal: string) => {
    commitValue(newVal === ENUM_NULL_VALUE ? null : newVal);
  }, [commitValue]);

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
    <div
      className={fieldClasses}
      data-field-index={index}
      onPointerDown={() => onActivate?.(index)}
    >
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
        ) : enumValues?.length ? (
          <select
            value={isCurrentlyNull ? ENUM_NULL_VALUE : String(effectiveValue)}
            onChange={(event) => handleEnumChange(event.target.value)}
            disabled={!canEdit}
            className={`w-full h-8 px-2.5 py-0 text-[12px] font-mono text-text-primary bg-bg-primary border rounded-md outline-none cursor-pointer focus:border-accent transition-colors ${inputBorder}`}
          >
            <option value={ENUM_NULL_VALUE}>NULL</option>
            {!isCurrentlyNull && !enumValues.includes(String(effectiveValue)) && <option value={String(effectiveValue)}>{String(effectiveValue)}</option>}
            {enumValues.map((enumValue) => <option key={enumValue} value={enumValue}>{enumValue || "'' (empty)"}</option>)}
          </select>
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
            className={`w-full h-8 px-2.5 py-0 text-[12px] font-mono text-text-primary bg-bg-primary border rounded-md outline-none cursor-pointer focus:border-accent transition-colors ${inputBorder}`}
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
  const dateFormatted = formatDateTimeValue(value);
  if (dateFormatted !== null) return dateFormatted;
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

function formatFilterValue(value: unknown): string {
  if (value instanceof SqlExpression) return value.label;
  return formatValue(value);
}
