import { useMemo } from "react";
import type { CellSelection } from "./ResultGrid";
import { ValueEditorModal } from "./ValueEditorModal";
import { ScalarEditorModal } from "./ScalarEditorModal";
import { DateTimeModal } from "./DateTimePicker";
import { useEditStore, buildRowKey, SqlExpression, type RowKey } from "../lib/editStore";
import { formatDateTimeValue } from "../lib/formatDateTime";
import { getDateTimeKind, type DateTimeKind } from "../lib/dateTimeEdit";
import { coerceTypedValue, commitCellValue, isBooleanType, isNumericType } from "../lib/fieldEdit";

/* ── Field-level pop-out editor ────────────────────────── */

/** What kind of control a field needs; mirrors the Row Details panel. */
export type FieldValueKind = "text" | "json" | "number" | "boolean";

export interface FieldEditorModalProps {
  name: string;
  dataType: string;
  /** Text as currently displayed in the field ("" when NULL). */
  text: string;
  /** Field currently holds NULL (as opposed to an empty string). */
  isNull?: boolean;
  valueKind?: FieldValueKind;
  /** Fixed set of allowed values; renders a select. */
  enumValues?: string[];
  dateTimeKind?: DateTimeKind | null;
  readOnly?: boolean;
  /** `null` means the field was set to NULL. */
  onApply: (text: string | null) => void;
  onClose: () => void;
}

/**
 * Picks the right pop-out editor for a field: a date/time picker, a select for
 * enums and booleans, a numeric input, or a Monaco editor (JSON / text) sized
 * to the value.
 */
export function FieldEditorModal({ name, dataType, text, isNull = false, valueKind = "text", enumValues, dateTimeKind, readOnly, onApply, onClose }: FieldEditorModalProps) {
  const dtKind = dateTimeKind === undefined ? getDateTimeKind(dataType) : dateTimeKind;

  if (dtKind) {
    return <DateTimeModal title={name} dataType={dataType} kind={dtKind} value={text} readOnly={readOnly} onApply={onApply} onClose={onClose} />;
  }
  if (enumValues?.length || valueKind === "boolean") {
    const options = enumValues?.length ? enumValues : ["true", "false"];
    return <ScalarEditorModal title={name} dataType={dataType} value={text} isNull={isNull} mode={{ kind: "select", options }} readOnly={readOnly} onApply={onApply} onClose={onClose} />;
  }
  if (valueKind === "number") {
    return <ScalarEditorModal title={name} dataType={dataType} value={text} isNull={isNull} mode={{ kind: "number" }} readOnly={readOnly} onApply={onApply} onClose={onClose} />;
  }
  return (
    <ValueEditorModal
      title={name}
      dataType={dataType}
      value={text}
      language={valueKind === "json" ? "json" : "plaintext"}
      readOnly={readOnly}
      onApply={onApply}
      onClose={onClose}
    />
  );
}

/* ── Cell-level pop-out (grid double-click / Enter) ────── */

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

  // The value's runtime type wins; for NULL cells fall back to the column type.
  const valueKind: FieldValueKind =
    (typeof originalValue === "object" && originalValue !== null) || /\bjsonb?\b/i.test(dataType) ? "json"
      : typeof originalValue === "boolean" || (typeof originalValue !== "number" && isBooleanType(dataType)) ? "boolean"
        : typeof originalValue === "number" || isNumericType(dataType) ? "number"
          : "text";

  const text = isSqlExpr ? (effective as SqlExpression).label : isNull ? "" : formatText(effective);

  const handleApply = (newText: string | null) => {
    if (!canEdit) return;
    let value: unknown;
    if (newText === null) value = null;
    else if (valueKind === "boolean" && (newText === "true" || newText === "false")) value = newText === "true";
    else value = coerceTypedValue(newText, originalValue, isNull);
    commitCellValue({ rowKey, insertId }, column, originalValue, value);
    onClose();
  };

  return (
    <FieldEditorModal
      name={column}
      dataType={dataType}
      text={text}
      isNull={isNull && !isSqlExpr}
      valueKind={valueKind}
      enumValues={meta?.enumValues}
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
