import type { CellSelection } from "./ResultGrid";

/* ── Detail Panel ──────────────────────────────────────── */

interface DetailPanelProps {
  selection: CellSelection | null;
}

export function DetailPanel({ selection }: DetailPanelProps) {
  if (!selection) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted text-xs px-4 text-center">
        Click a row to view details
      </div>
    );
  }

  const { row, columns } = selection;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center h-8 px-3 border-b border-border bg-bg-secondary shrink-0">
        <span className="text-[11px] font-semibold text-text-secondary">
          Row Details
        </span>
        <span className="ml-2 text-[10px] text-text-muted">
          ({columns.length} fields)
        </span>
      </div>

      {/* Field list */}
      <div className="flex-1 overflow-auto min-h-0 p-2 space-y-2">
        {columns.map((col, i) => {
          const value = (row as unknown[])[i];
          return (
            <FieldRow key={col} name={col} value={value} />
          );
        })}
      </div>
    </div>
  );
}

/* ── Individual field row ──────────────────────────────── */

function FieldRow({ name, value }: { name: string; value: unknown }) {
  const displayValue = formatValue(value);
  const isNull = value === null || value === undefined;
  const isLong = typeof value === "string" && value.length > 100;
  const isObject = typeof value === "object" && value !== null;

  const handleCopyName = () => {
    navigator.clipboard.writeText(name).catch(() => {});
  };

  const handleCopyValue = () => {
    navigator.clipboard.writeText(displayValue).catch(() => {});
  };

  return (
    <div className="rounded border border-border bg-bg-primary overflow-hidden">
      {/* Column name — clickable to copy */}
      <div
        className="flex items-center justify-between px-2.5 py-1 bg-bg-secondary border-b border-border cursor-pointer hover:bg-bg-hover transition-colors group"
        onClick={handleCopyName}
        title="Click to copy column name"
      >
        <span className="text-[10px] font-semibold text-text-secondary truncate">
          {name}
        </span>
        <span className="text-[9px] text-text-muted opacity-0 group-hover:opacity-100 transition-opacity shrink-0 ml-1">
          copy
        </span>
      </div>

      {/* Value */}
      <div
        className={`px-2.5 py-1.5 text-[12px] font-mono cursor-pointer hover:bg-bg-hover/50 transition-colors ${
          isNull ? "text-text-muted italic" : "text-text-primary"
        } ${isLong || isObject ? "break-all whitespace-pre-wrap" : "truncate"}`}
        onClick={handleCopyValue}
        title="Click to copy value"
      >
        {displayValue}
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
