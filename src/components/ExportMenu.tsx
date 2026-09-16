import { useEffect, useRef, useState } from "react";
import { ClipboardCopy, Download, Loader2, Square } from "lucide-react";
import type { ExportFormat } from "../lib/dataExport";

export type ExportScope = "selected" | "page" | "all";
export type ExportAction = "copy" | "download";

interface ExportMenuProps {
  selectedCount: number;
  pageCount: number;
  allowAll?: boolean;
  allLabel?: string;
  exporting?: boolean;
  exportedRows?: number;
  onExport: (format: ExportFormat, scope: ExportScope, action: ExportAction) => void;
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
  const [scope, setScope] = useState<ExportScope>("page");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  useEffect(() => {
    if ((scope === "selected" && selectedCount === 0) || (scope === "all" && !allowAll)) setScope("page");
  }, [scope, selectedCount, allowAll]);

  if (exporting) {
    return <button onClick={onCancel} className="flex items-center gap-1 px-2 py-0.5 rounded text-warning hover:bg-warning/10 transition-colors cursor-pointer" title="Cancel export">
      {onCancel ? <Square size={10} /> : <Loader2 size={11} className="animate-spin" />}
      {exportedRows.toLocaleString()} rows
    </button>;
  }

  const start = (action: ExportAction) => {
    setOpen(false);
    onExport(format, scope, action);
  };

  const canStart = scope === "all" || (scope === "selected" ? selectedCount > 0 : pageCount > 0);
  const scopeClass = (value: ExportScope, disabled = false) => `w-full rounded px-2 py-1 text-left text-[11px] leading-4 transition-colors ${
    scope === value ? "bg-accent/15 text-accent" : "hover:bg-bg-hover"
  } ${disabled ? "opacity-40 cursor-default" : "cursor-pointer"}`;

  return <div ref={ref} className="relative">
    <button onClick={() => setOpen((value) => !value)} className="flex items-center gap-1 px-2 py-0.5 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer" title="Copy or download data">
      <Download size={11} /> Export
    </button>
    {open && <div className="absolute bottom-full left-0 mb-1 w-48 rounded-md border border-border bg-bg-primary shadow-xl z-[300] p-1.5">
      <label className="mb-0.5 block text-[9px] uppercase tracking-wide text-text-muted">Format</label>
      <select value={format} onChange={(event) => setFormat(event.target.value as ExportFormat)} className="mb-1.5 h-6 w-full rounded border border-border bg-bg-secondary px-1.5 py-0 text-[10px] outline-none">
        {FORMATS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select>
      <div className="mb-0.5 text-[9px] uppercase tracking-wide text-text-muted">Rows</div>
      <div className="space-y-px">
        <button disabled={selectedCount === 0} onClick={() => setScope("selected")} className={scopeClass("selected", selectedCount === 0)}>Selected rows ({selectedCount})</button>
        <button disabled={pageCount === 0} onClick={() => setScope("page")} className={scopeClass("page", pageCount === 0)}>Current page ({pageCount})</button>
        {allowAll && <button onClick={() => setScope("all")} className={scopeClass("all")}>{allLabel}</button>}
      </div>
      <div className="mt-1.5 grid grid-cols-2 gap-1 border-t border-border pt-1.5">
        <button disabled={!canStart} onClick={() => start("copy")} className="flex items-center justify-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] leading-4 hover:bg-bg-hover disabled:opacity-40 disabled:cursor-default">
          <ClipboardCopy size={10} /> Copy
        </button>
        <button disabled={!canStart} onClick={() => start("download")} className="flex items-center justify-center gap-1 rounded bg-accent px-1.5 py-0.5 text-[10px] leading-4 text-white hover:bg-accent-hover disabled:opacity-40 disabled:cursor-default">
          <Download size={10} /> Download
        </button>
      </div>
    </div>}
  </div>;
}
