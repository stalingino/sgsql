import { useRef, useState } from "react";
import { Download, Loader2, Square, X } from "lucide-react";
import { finishExport, serializeExportChunk, type ExportFormat } from "../lib/dataExport";
import { chooseExportPath, writeExportFile } from "../lib/fileExport";
import { fetchTableDdl, fetchTableRows } from "../lib/schema";

type TableExportKind = "dump" | "structure" | "data" | "json" | "csv" | "ndjson";

interface TableExportModalProps {
  connectionId: string;
  db: string;
  schema: string;
  dialect: "postgres" | "mysql" | "sqlite";
  tables: string[];
  onClose: () => void;
}

const EXPORT_KINDS: Array<{ value: TableExportKind; label: string; description: string; format: ExportFormat }> = [
  { value: "dump", label: "SQL dump", description: "Structure and all rows", format: "sql" },
  { value: "structure", label: "SQL structure", description: "CREATE statements only", format: "sql" },
  { value: "data", label: "SQL data", description: "INSERT statements only", format: "sql" },
  { value: "json", label: "JSON bundle", description: "One object keyed by table", format: "json" },
  { value: "csv", label: "CSV", description: "Available for one table", format: "csv" },
  { value: "ndjson", label: "NDJSON", description: "Available for one table", format: "ndjson" },
];

const PAGE_SIZE = 1_000;

function cleanDdl(ddl: string): string {
  const value = ddl.trim();
  return value.endsWith(";") ? value : `${value};`;
}

export function TableExportModal({ connectionId, db, schema, dialect, tables, onClose }: TableExportModalProps) {
  const [kind, setKind] = useState<TableExportKind>("dump");
  const [working, setWorking] = useState(false);
  const [exportedRows, setExportedRows] = useState(0);
  const [currentTable, setCurrentTable] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const selection = EXPORT_KINDS.find((item) => item.value === kind) ?? EXPORT_KINDS[0];
  const singleTableOnly = kind === "csv" || kind === "ndjson";
  const invalidSelection = singleTableOnly && tables.length !== 1;

  const appendTableRows = async (path: string, table: string, format: ExportFormat, jsonBundle = false) => {
    let offset = 0;
    let first = true;
    let wroteRows = false;
    while (true) {
      const page = await fetchTableRows(connectionId, db, schema, table, PAGE_SIZE, offset, undefined, undefined, controllerRef.current?.signal);
      const chunk = serializeExportChunk({
        format,
        columns: page.columns,
        rows: page.rows,
        dialect,
        table,
        schema,
        database: db,
        first,
      });
      await writeExportFile(path, jsonBundle && first ? chunk.slice(1) : chunk, true);
      wroteRows ||= page.rows.length > 0;
      setExportedRows((count) => count + page.rows.length);
      first = false;
      offset += page.rows.length;
      if (page.rows.length < PAGE_SIZE) break;
    }
    if (format === "json") await writeExportFile(path, finishExport("json", wroteRows), true);
  };

  const runExport = async () => {
    if (invalidSelection || tables.length === 0) return;
    setError(null);
    setNotice(null);
    setExportedRows(0);
    const suggested = tables.length === 1 ? tables[0] : `${db}-${tables.length}-tables`;
    const path = await chooseExportPath(suggested, selection.format);
    if (!path) return;

    const controller = new AbortController();
    controllerRef.current = controller;
    setWorking(true);
    try {
      if (kind === "json") {
        await writeExportFile(path, "{\n", false);
        for (let index = 0; index < tables.length; index += 1) {
          const table = tables[index];
          setCurrentTable(table);
          await writeExportFile(path, `${index ? ",\n" : ""}  ${JSON.stringify(table)}: [`, true);
          await appendTableRows(path, table, "json", true);
        }
        await writeExportFile(path, "}\n", true);
      } else {
        await writeExportFile(path, selection.format === "sql" ? `-- SGSql export: ${db}\n\n` : "", false);
        if (kind === "dump" || kind === "structure") {
          for (const table of tables) {
            setCurrentTable(table);
            const ddl = await fetchTableDdl(connectionId, db, schema, table);
            if (controller.signal.aborted) throw new DOMException("Export cancelled", "AbortError");
            await writeExportFile(path, `${cleanDdl(ddl)}\n\n`, true);
          }
        }
        if (kind === "dump" || kind === "data") {
          for (const table of tables) {
            setCurrentTable(table);
            await appendTableRows(path, table, "sql");
            await writeExportFile(path, "\n", true);
          }
        }
        if (kind === "csv" || kind === "ndjson") {
          setCurrentTable(tables[0]);
          await appendTableRows(path, tables[0], selection.format);
        }
      }
      setCurrentTable(null);
      setNotice(`Exported ${tables.length} table${tables.length === 1 ? "" : "s"} to ${path}`);
    } catch (cause) {
      setError(controller.signal.aborted ? "Export cancelled. The partial file was left in place." : cause instanceof Error ? cause.message : String(cause));
    } finally {
      controllerRef.current = null;
      setWorking(false);
      setCurrentTable(null);
    }
  };

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 p-6" onMouseDown={(event) => { if (event.target === event.currentTarget && !working) onClose(); }}>
      <div className="w-full max-w-2xl overflow-hidden rounded-lg border border-border bg-bg-primary shadow-2xl">
        <div className="flex items-start gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-sm font-semibold"><Download size={14} className="text-accent" /> Export selected tables</div>
            <div className="mt-0.5 text-[11px] text-text-muted">{tables.length} table{tables.length === 1 ? "" : "s"} selected in <span className="font-mono text-text-secondary">{db}</span></div>
          </div>
          <button disabled={working} onClick={onClose} className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text-primary disabled:opacity-40" aria-label="Close export"><X size={15} /></button>
        </div>

        <div className="grid grid-cols-2 gap-3 p-4">
          {EXPORT_KINDS.map((item) => {
            const disabled = (item.value === "csv" || item.value === "ndjson") && tables.length !== 1;
            return (
              <button
                key={item.value}
                disabled={working || disabled}
                onClick={() => setKind(item.value)}
                className={`rounded-md border px-3 py-2 text-left transition-colors ${kind === item.value ? "border-accent bg-accent/10" : "border-border hover:bg-bg-hover"} disabled:cursor-default disabled:opacity-40`}
              >
                <div className={`text-xs font-medium ${kind === item.value ? "text-accent" : "text-text-primary"}`}>{item.label}</div>
                <div className="mt-0.5 text-[10px] text-text-muted">{item.description}</div>
              </button>
            );
          })}
        </div>

        <div className="mx-4 mb-4 max-h-28 overflow-auto rounded border border-border bg-bg-secondary p-2 text-[10px] font-mono text-text-secondary">
          {tables.join("\n")}
        </div>

        {working && (
          <div className="border-t border-border bg-bg-secondary px-4 py-2 text-[11px] text-text-muted">
            Exporting <span className="font-mono text-text-secondary">{currentTable}</span> · {exportedRows.toLocaleString()} rows written
          </div>
        )}
        {error && <div className="border-t border-error/30 bg-error/10 px-4 py-2 text-xs text-error">{error}</div>}
        {notice && <div className="break-all border-t border-success/30 bg-success/10 px-4 py-2 text-xs text-success">{notice}</div>}

        <div className="flex items-center justify-between gap-3 border-t border-border bg-bg-secondary px-4 py-3">
          <div className="text-[10px] text-text-muted">Exports read all rows in 1,000-row pages.</div>
          <div className="flex shrink-0 gap-2">
            <button disabled={!working} onClick={() => controllerRef.current?.abort()} className="flex items-center gap-1 rounded border border-border px-3 py-1.5 text-xs hover:bg-bg-hover disabled:hidden"><Square size={10} /> Cancel export</button>
            <button disabled={working} onClick={onClose} className="rounded border border-border px-3 py-1.5 text-xs hover:bg-bg-hover disabled:opacity-40">{notice ? "Close" : "Cancel"}</button>
            <button disabled={working || invalidSelection} onClick={() => void runExport()} className="flex min-w-24 items-center justify-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:cursor-default disabled:opacity-40">
              {working ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
              {working ? "Exporting…" : "Export"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
