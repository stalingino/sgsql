import { useMemo } from "react";
import type { CellSelection } from "./ResultGrid";
import { ValueEditorModal } from "./ValueEditorModal";
import { DateTimeModal } from "./DateTimePicker";
import { useEditStore, buildRowKey, SqlExpression, type RowKey } from "../lib/editStore";
import { formatDateTimeValue } from "../lib/formatDateTime";
import { getDateTimeKind, type DateTimeKind } from "../lib/dateTimeEdit";
import { coerceTypedValue, commitCellValue } from "../lib/fieldEdit";

/* ── Field-level pop-out editor ────────────────────────── */

export interface FieldEditorModalProps {
  name: string;
  dataType: string;
  /** Text as currently displayed in the field. */
  text: string;
  isJson: boolean;
  dateTimeKind?: DateTimeKind | null;
  readOnly?: boolean;
  onApply: (text: string) => void;
  onClose: () => void;
}

/** Picks the right pop-out editor (date/time picker, JSON, or plain text) for a field. */
export function FieldEditorModal({ name, dataType, text, isJson, dateTimeKind, readOnly, onApply, onClose }: FieldEditorModalProps) {
  const kind = dateTimeKind === undefined ? getDateTimeKind(dataType) : dateTimeKind;
  if (kind) {
    return <DateTimeModal title={name} dataType={dataType} kind={kind} value={text} readOnly={readOnly} onApply={onApply} onClose={onClose} />;
  }
  return (
    <ValueEditorModal
      title={name}
      dataType={dataType}
      value={text}
      language={isJson ? "json" : "plaintext"}
      readOnly={readOnly}
      onApply={onApply}
      onClose={onClose}
    />
  );
}

/* ── Cell-level pop-out (grid double-click) ────────────── */

interface CellEditorModalProps {
  selection: CellSelection;
  onClose: () => void;
}

/**
 * Resolves a grid cell (original value, pending edit, column type, edit
 * target) and opens the matching pop-out editor. Applying writes to the edit
 * store exactly like typing into the Row Details field would.
 */
export function CellEditorModal({ selection, onClose }: CellEditorModalProps) {
  const column = selection.columns[selection.colIndex];
  const ctx = selection.tableContext;
  const insertId = selection.insertId;

  const rowKey: RowKey | null = useMemo(
    () => (ctx && !insertId
      ? buildRowKey(ctx.connectionId, ctx.connectionType, ctx.db, ctx.schema, ctx.table, selection.columns, selection.row, ctx.pkColumns)
      : null),
    [ctx, insertId, selection.columns, selection.row],
  );

  const meta = ctx?.columnMeta?.find((m) => m.name === column);
  const dataType = meta?.udtName || meta?.dataType || "";

  const store = useEditStore.getState();
  const originalValue = insertId
    ? store.inserts.find((i) => i.id === insertId)?.values[column] ?? null
    : selection.row[selection.colIndex];
  const pending = rowKey ? store.getChange(rowKey, column) : undefined;
  const effective = insertId ? originalValue : (pending?.newValue ?? originalValue);

  const canEdit = !!rowKey || !!insertId;
  const isSqlExpr = effective instanceof SqlExpression;
  const isNull = effective === null || effective === undefined;
  const isJson = (typeof originalValue === "object" && originalValue !== null) || /\bjsonb?\b/i.test(dataType);

  const text = isSqlExpr ? (effective as SqlExpression).label : isNull ? "" : formatText(effective);

  const handleApply = (newText: string) => {
    if (!canEdit) return;
    commitCellValue({ rowKey, insertId }, column, originalValue, coerceTypedValue(newText, originalValue, isNull));
    onClose();
  };

  return (
    <FieldEditorModal
      name={column}
      dataType={dataType}
      text={text}
      isJson={isJson}
      // A SQL expression (DEFAULT / NOW()) has no editable text; show it read-only.
      readOnly={!canEdit || isSqlExpr}
      onApply={handleApply}
      onClose={onClose}
    />
  );
}

function formatText(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  const dateFormatted = formatDateTimeValue(value);
  if (dateFormatted !== null) return dateFormatted;
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}
