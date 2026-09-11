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
