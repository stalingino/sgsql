import { useState } from "react";
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
      <div className="flex-1 overflow-auto min-h-0 py-1 selectable">
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
  const isNull = value === null || value === undefined;
  const isBoolean = typeof value === "boolean";
  const [editValue, setEditValue] = useState<string | null>(null);

  const displayValue = editValue ?? formatValue(value);

  return (
    <div className="px-3 py-1.5">
      {/* Column name — selectable text */}
      <span className="text-[11px] font-semibold text-text-muted cursor-text">
        {name}
      </span>

      {/* Value — editable */}
      <div className="mt-0.5">
        {isNull ? (
          <input
            type="text"
            value={editValue ?? "NULL"}
            onChange={(e) => setEditValue(e.target.value)}
            className="w-full px-2 py-1 text-[12px] font-mono italic text-text-muted bg-bg-secondary border border-border rounded outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors"
          />
        ) : isBoolean ? (
          <select
            value={editValue ?? String(value)}
            onChange={(e) => setEditValue(e.target.value)}
            className="w-full px-2 py-1 text-[12px] font-mono text-text-primary bg-bg-secondary border border-border rounded outline-none cursor-pointer focus:border-accent transition-colors"
          >
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        ) : typeof value === "object" ? (
          <textarea
            value={editValue ?? JSON.stringify(value, null, 2)}
            onChange={(e) => setEditValue(e.target.value)}
            rows={Math.min(6, (editValue ?? JSON.stringify(value, null, 2)).split("\n").length)}
            className="w-full px-2 py-1 text-[12px] font-mono text-text-primary bg-bg-secondary border border-border rounded outline-none resize-y focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors"
          />
        ) : typeof value === "number" ? (
          <input
            type="text"
            value={displayValue}
            onChange={(e) => setEditValue(e.target.value)}
            className="w-full px-2 py-1 text-[12px] font-mono tabular-nums text-accent bg-bg-secondary border border-border rounded outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors"
          />
        ) : (
          /* String / default */
          String(value).length > 80 ? (
            <textarea
              value={displayValue}
              onChange={(e) => setEditValue(e.target.value)}
              rows={Math.min(6, Math.ceil(displayValue.length / 40))}
              className="w-full px-2 py-1 text-[12px] font-mono text-text-primary bg-bg-secondary border border-border rounded outline-none resize-y focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors"
            />
          ) : (
            <input
              type="text"
              value={displayValue}
              onChange={(e) => setEditValue(e.target.value)}
              className="w-full px-2 py-1 text-[12px] font-mono text-text-primary bg-bg-secondary border border-border rounded outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors"
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
