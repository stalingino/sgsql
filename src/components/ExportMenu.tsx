import { useEffect, useRef, useState } from "react";
import { Download, Loader2, Square } from "lucide-react";
import type { ExportFormat } from "../lib/dataExport";

export type ExportScope = "selected" | "page" | "all";

interface ExportMenuProps {
  selectedCount: number;
  pageCount: number;
  allowAll?: boolean;
  allLabel?: string;
  exporting?: boolean;
  exportedRows?: number;
  onExport: (format: ExportFormat, scope: ExportScope) => void;
  onCancel?: () => void;
}

const FORMATS: Array<{ value: ExportFormat; label: string }> = [
  { value: "csv", label: "CSV" },
  { value: "json", label: "JSON" },
  { value: "ndjson", label: "NDJSON" },
  { value: "sql", label: "INSERT SQL" },
];

export function ExportMenu({ selectedCount, pageCount, allowAll = true, allLabel = "All matching rows", exporting = false, exportedRows = 0, onExport, onCancel }: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<ExportFormat>("csv");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  if (exporting) {
    return <button onClick={onCancel} className="flex items-center gap-1 px-2 py-0.5 rounded text-warning hover:bg-warning/10 transition-colors cursor-pointer" title="Cancel export">
      {onCancel ? <Square size={10} /> : <Loader2 size={11} className="animate-spin" />}
      {exportedRows.toLocaleString()} rows
    </button>;
  }

  const start = (scope: ExportScope) => {
    setOpen(false);
    onExport(format, scope);
  };

  return <div ref={ref} className="relative">
    <button onClick={() => setOpen((value) => !value)} className="flex items-center gap-1 px-2 py-0.5 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer" title="Export data to a file">
      <Download size={11} /> Export
    </button>
    {open && <div className="absolute bottom-full left-0 mb-1 w-52 rounded-md border border-border bg-bg-primary shadow-xl z-[300] p-2">
      <label className="block text-[10px] uppercase tracking-wide text-text-muted mb-1">Format</label>
      <select value={format} onChange={(event) => setFormat(event.target.value as ExportFormat)} className="w-full mb-2 rounded border border-border bg-bg-secondary px-2 py-1 text-[11px] outline-none">
        {FORMATS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select>
      <div className="space-y-0.5">
        <button disabled={selectedCount === 0} onClick={() => start("selected")} className="w-full rounded px-2 py-1.5 text-left text-[11px] hover:bg-bg-hover disabled:opacity-40 disabled:cursor-default">Selected rows ({selectedCount})</button>
        <button disabled={pageCount === 0} onClick={() => start("page")} className="w-full rounded px-2 py-1.5 text-left text-[11px] hover:bg-bg-hover disabled:opacity-40 disabled:cursor-default">Current page ({pageCount})</button>
        {allowAll && <button onClick={() => start("all")} className="w-full rounded px-2 py-1.5 text-left text-[11px] hover:bg-bg-hover">{allLabel}</button>}
      </div>
    </div>}
  </div>;
}
