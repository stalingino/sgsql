import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

/* ── Pop-out editor for enum / boolean / number fields ── */

const NULL_OPTION = "__sgsql_null__";

export type ScalarEditorMode =
  /** Pick one of a fixed set of values (enum, boolean). */
  | { kind: "select"; options: string[] }
  /** Single numeric value. */
  | { kind: "number" };

interface ScalarEditorModalProps {
  title: string;
  /** Column data type, shown next to the title. */
  dataType?: string;
  /** Current text; ignored when `isNull`. */
  value: string;
  isNull: boolean;
  mode: ScalarEditorMode;
  readOnly?: boolean;
  /** `null` means the field was set to NULL. */
  onApply: (value: string | null) => void;
  onClose: () => void;
}

/**
 * Compact dialog for fields that don't need a full text editor. Mirrors the
 * Row Details controls: a select for enums/booleans, a numeric input for
 * numbers. Enter applies, Esc discards.
 */
export function ScalarEditorModal({ title, dataType, value, isNull, mode, readOnly, onApply, onClose }: ScalarEditorModalProps) {
  const initial: string | null = isNull ? null : value;
  const [draft, setDraft] = useState<string | null>(initial);
  const controlRef = useRef<HTMLSelectElement | HTMLInputElement | null>(null);

  const dirty = draft !== initial;
  const numberError = mode.kind === "number" ? validateNumber(draft) : null;
  const canApply = dirty && !readOnly && numberError === null;

  const apply = () => {
    if (!canApply) return;
    onApply(draft);
    onClose();
  };

  useEffect(() => {
    controlRef.current?.focus();
    if (controlRef.current instanceof HTMLInputElement) controlRef.current.select();
  }, []);

  const inputClasses = "w-full h-8 px-2.5 text-[12px] font-mono text-text-primary bg-bg-primary border border-border-light rounded-md outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors";

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Edit ${title}`}
      className="fixed inset-0 z-[230] flex items-center justify-center bg-black/50 p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        } else if (e.key === "Enter") {
          e.preventDefault();
          apply();
        }
      }}
    >
      <div className="w-[360px] max-w-full bg-bg-primary border border-border rounded-xl shadow-2xl overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border bg-bg-secondary no-select">
          <span className="text-sm font-semibold text-text-primary truncate">{title}</span>
          {dataType && <span className="text-[11px] font-mono text-text-secondary truncate">{dataType}</span>}
          {dirty && <span className="text-[10px] text-warning">modified</span>}
          <div className="flex-1" />
          <button type="button" onClick={onClose} title="Close (Esc)" className="p-1 rounded hover:bg-bg-hover transition-colors cursor-pointer text-text-muted hover:text-text-primary">
            <X size={14} />
          </button>
        </div>

        <div className="px-4 py-3">
          {mode.kind === "select" ? (
            <select
              ref={(el) => { controlRef.current = el; }}
              value={draft === null ? NULL_OPTION : draft}
              onChange={(e) => setDraft(e.target.value === NULL_OPTION ? null : e.target.value)}
              disabled={readOnly}
              className={`${inputClasses} py-0 cursor-pointer`}
            >
              <option value={NULL_OPTION}>NULL</option>
              {draft !== null && !mode.options.includes(draft) && <option value={draft}>{draft}</option>}
              {mode.options.map((option) => <option key={option} value={option}>{option || "'' (empty)"}</option>)}
            </select>
          ) : (
            <input
              ref={(el) => { controlRef.current = el; }}
              type="text"
              inputMode="decimal"
              value={draft ?? ""}
              placeholder="NULL"
              readOnly={readOnly}
              onChange={(e) => setDraft(e.target.value === "" ? null : e.target.value)}
              className={`${inputClasses} font-medium tabular-nums text-accent italic placeholder:text-text-muted ${draft === null ? "" : "not-italic"} ${numberError ? "border-error focus:border-error focus:ring-error/30" : ""}`}
            />
          )}
        </div>

        <div className="flex items-center gap-3 px-4 py-2.5 border-t border-border bg-bg-secondary no-select">
          {numberError ? (
            <span className="text-[11px] text-error truncate">{numberError}</span>
          ) : (
            <span className="text-[11px] text-text-muted">{readOnly ? "Read-only" : "Enter to apply · Esc to cancel"}</span>
          )}
          <div className="flex-1" />
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs rounded-md border border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer">
            Cancel
          </button>
          {!readOnly && (
            <button
              type="button"
              onClick={apply}
              disabled={!canApply}
              className="px-3 py-1.5 text-xs rounded-md bg-accent text-white hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
            >
              Apply
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function validateNumber(text: string | null): string | null {
  if (text === null) return null;
  return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text.trim()) ? null : "Not a number";
}
