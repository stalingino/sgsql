import { lazy, Suspense, useMemo, useRef, useState } from "react";
import { FileUp, Loader2, StopCircle, Upload } from "lucide-react";
import { useExecutionQueue } from "../lib/executionQueue";
import { prepareSqlImport } from "../lib/sqlImport";
import type { MonacoSqlEditorHandle } from "./MonacoSqlEditor";

const MonacoSqlEditor = lazy(() => import("./MonacoSqlEditor"));

interface SqlImportTabProps {
  connectionId: string;
  db: string;
  dialect: "postgres" | "mysql" | "sqlite";
  onImported: () => void;
}

export function SqlImportTab({ connectionId, db, dialect, onImported }: SqlImportTabProps) {
  const editorRef = useRef<MonacoSqlEditorHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importDump = useExecutionQueue((state) => state.importDump);
  const cancel = useExecutionQueue((state) => state.cancel);
  const [sql, setSql] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);

  const statementCount = useMemo(() => {
    if (!sql.trim()) return 0;
    try { return prepareSqlImport(sql, dialect).length; } catch { return 0; }
  }, [sql, dialect]);

  const chooseFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const text = await file.text();
      setSql(text);
      setFileName(file.name);
      setError(null);
      setResult(null);
      setProgress(null);
      editorRef.current?.setValue(text);
      editorRef.current?.focus();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const runImport = async () => {
    setError(null);
    setResult(null);
    let statements: string[];
    try {
      statements = prepareSqlImport(sql, dialect);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }

    setWorking(true);
    setProgress({ completed: 0, total: statements.length });
    try {
      const response = await importDump(
        connectionId,
        statements,
        db,
        dialect === "sqlite",
        (completed, total) => setProgress({ completed, total }),
      );
      setProgress({ completed: response.applied, total: statements.length });
      setResult(`Imported ${response.applied.toLocaleString()} statement${response.applied === 1 ? "" : "s"}${response.atomic ? " in one transaction" : ""}.`);
      onImported();
    } catch (cause) {
      const queue = useExecutionQueue.getState().connections.get(connectionId);
      const message = cause instanceof Error ? cause.message : String(cause);
      const cancelled = (cause instanceof DOMException && cause.name === "AbortError")
        || queue?.phase === "cancelling"
        || !!queue?.lastCancelDetail
        || /abort|cancel|interrupt|killed/i.test(message);
      setError(cancelled ? "Import cancelled." : message);
    } finally {
      setWorking(false);
    }
  };

  const percent = progress?.total
    ? Math.min(100, Math.round((progress.completed / progress.total) * 100))
    : 0;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-bg-primary">
      <div className="flex items-start gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-semibold"><Upload size={14} className="text-accent" /> Import SQL dump</div>
          <div className="mt-0.5 text-[11px] text-text-muted">
            Type, paste, or choose a .sql file. The complete dump is applied to <span className="font-mono text-text-secondary">{db}</span> without the query runner's statement limit.
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 border-b border-border bg-bg-secondary px-3 py-2">
        <input
          ref={fileInputRef}
          type="file"
          accept=".sql,.dump,.txt,text/plain,application/sql"
          className="hidden"
          onChange={(event) => { void chooseFile(event.target.files?.[0]); event.currentTarget.value = ""; }}
        />
        <button disabled={working} onClick={() => fileInputRef.current?.click()} className="flex items-center gap-1.5 rounded border border-border px-2.5 py-1 text-[11px] hover:bg-bg-hover disabled:opacity-40">
          <FileUp size={12} /> Choose file
        </button>
        <span className="min-w-0 flex-1 truncate text-[10px] text-text-muted">{fileName ?? "Or type/paste SQL below"}</span>
        <span className="text-[10px] tabular-nums text-text-muted">{statementCount.toLocaleString()} statement{statementCount === 1 ? "" : "s"}</span>
      </div>

      <div className="relative min-h-0 flex-1 bg-bg-primary">
        <Suspense fallback={<div className="absolute inset-0 flex items-center justify-center text-xs text-text-muted"><Loader2 size={14} className="animate-spin" /></div>}>
          <MonacoSqlEditor
            ref={editorRef}
            defaultValue=""
            activeRange={null}
            onChange={(value) => { setSql(value); setResult(null); if (!working) setProgress(null); }}
            onCursorChange={() => undefined}
            onRunQuery={() => { if (!working) void runImport(); }}
            onRunAll={() => { if (!working) void runImport(); }}
            getCompletionContext={() => null}
          />
        </Suspense>
      </div>

      {working && progress && (
        <div className="border-t border-border bg-bg-secondary px-4 py-2.5">
          <div className="mb-1.5 flex items-center justify-between gap-3 text-[10px] text-text-muted">
            <span>{progress.completed === progress.total && dialect !== "mysql" ? "Committing transaction…" : "Importing statements…"}</span>
            <span className="tabular-nums text-text-secondary">{progress.completed.toLocaleString()} / {progress.total.toLocaleString()} · {percent}%</span>
          </div>
          <div role="progressbar" aria-label="SQL import progress" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.completed} className="h-1.5 overflow-hidden rounded-full bg-bg-hover">
            <div className="h-full rounded-full bg-accent transition-[width] duration-150" style={{ width: `${percent}%` }} />
          </div>
        </div>
      )}

      {dialect === "mysql" && (
        <div className="border-t border-warning/30 bg-warning/10 px-4 py-2 text-[11px] text-warning">
          MySQL imports use one connection, but DDL can auto-commit and cannot always be rolled back.
        </div>
      )}
      {error && <div className="border-t border-error/30 bg-error/10 px-4 py-2 text-xs text-error">{error}</div>}
      {result && <div className="border-t border-success/30 bg-success/10 px-4 py-2 text-xs text-success">{result}</div>}

      <div className="flex items-center justify-between gap-3 border-t border-border bg-bg-secondary px-4 py-3">
        <div className="text-[10px] text-text-muted">
          {dialect === "mysql" ? "Statements run in order on one connection." : "Existing BEGIN/COMMIT wrappers are removed so the whole import uses one outer transaction."}
        </div>
        <div className="flex shrink-0 gap-2">
          {working && (
            <button onClick={() => void cancel(connectionId)} className="flex items-center gap-1.5 rounded border border-error/40 px-3 py-1.5 text-xs text-error hover:bg-error/10">
              <StopCircle size={12} /> Kill import
            </button>
          )}
          <button disabled={working || !sql.trim()} onClick={() => void runImport()} className="flex min-w-24 items-center justify-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:cursor-default disabled:opacity-40">
            {working ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
            {working ? `Importing ${percent}%` : "Import"}
          </button>
        </div>
      </div>
    </div>
  );
}
