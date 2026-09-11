import { useEditStore, type RowKey } from "./editStore";

/* ── Shared cell/field edit helpers ────────────────────── */

/**
 * Convert text typed into a field back into a store value, preserving the
 * original cell's primitive type where it is unambiguous.
 */
export function coerceTypedValue(text: string, originalValue: unknown, currentlyNull: boolean): unknown {
  if (text === "" && (originalValue === null || originalValue === undefined || currentlyNull)) return null;
  if (typeof originalValue === "boolean") return text === "true";
  if (typeof originalValue === "number" && text !== "" && !isNaN(Number(text))) return Number(text);
  return text;
}

export interface EditTarget {
  rowKey: RowKey | null;
  insertId?: string;
}

/** Write a value into the edit store for either a pending insert or an existing row. */
export function commitCellValue(target: EditTarget, column: string, originalValue: unknown, value: unknown): void {
  if (target.insertId) {
    useEditStore.getState().updateInsertValue(target.insertId, column, value);
  } else if (target.rowKey) {
    useEditStore.getState().setChange(target.rowKey, column, originalValue, value);
  }
}

/** Column type names that hold numbers (Postgres / MySQL / SQLite spellings). */
export function isNumericType(dataType: string): boolean {
  return /^(small|big|tiny|medium)?int(eger)?\d*\b|^(numeric|decimal|dec|float\d*|double|real|money|serial|bigserial|smallserial|number)\b/i.test(dataType.trim());
}

/** Column type names that hold booleans (`bool`, `boolean`, MySQL's `tinyint(1)`). */
export function isBooleanType(dataType: string): boolean {
  return /^bool(ean)?\b|^tinyint\(1\)/i.test(dataType.trim());
}

export type ValueEditorSize = "sm" | "md" | "lg";

/** Pick a pop-out editor size that fits the value: short strings get a compact box, long text / JSON the full editor. */
export function sizeForValue(text: string, language: "json" | "plaintext"): ValueEditorSize {
  const lines = text.split("\n").length;
  if (text.length > 2000 || lines > 20) return "lg";
  if (language === "json" || text.length > 160 || lines > 2) return "md";
  return "sm";
}
