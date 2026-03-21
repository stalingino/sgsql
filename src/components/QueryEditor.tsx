import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { Loader2, Play, ChevronLeft, ChevronRight } from "lucide-react";
import { executeQuery, type QueryResult } from "../lib/schema";
import { useQueryLog } from "../lib/queryLog";

interface QueryEditorProps {
  connectionId: string;
  /** Unique key for persisting query history per connection tab */
  storageKey: string;
}

const STORAGE_PREFIX = "sgsql-queries-";
const PAGE_SIZE = 100;

interface SavedState {
  queries: string[];
  activeIndex: number;
}

function loadSaved(storageKey: string): SavedState {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + storageKey);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.queries) && parsed.queries.length > 0) {
        return parsed;
      }
    }
  } catch { /* ignore */ }
  return { queries: [""], activeIndex: 0 };
}

function saveToDisk(storageKey: string, state: SavedState) {
  try {
    localStorage.setItem(STORAGE_PREFIX + storageKey, JSON.stringify(state));
  } catch { /* ignore */ }
}

export function QueryEditor({ connectionId, storageKey }: QueryEditorProps) {
  const [savedState, setSavedState] = useState<SavedState>(() => loadSaved(storageKey));
  const [sql, setSql] = useState(() => savedState.queries[savedState.activeIndex] || "");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const addLogEntryRef = useRef(useQueryLog.getState().addEntry);
  addLogEntryRef.current = useQueryLog.getState().addEntry;

  // Auto-save on sql change (debounced)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      setSavedState((prev) => {
        const next = { ...prev, queries: [...prev.queries] };
        next.queries[next.activeIndex] = sql;
        saveToDisk(storageKey, next);
        return next;
      });
    }, 500);
    return () => clearTimeout(saveTimerRef.current);
  }, [sql, storageKey]);

  const runQuery = useCallback(async () => {
    const trimmed = sql.trim();
    if (!trimmed || loading) return;

    setLoading(true);
    setError(null);
    setResult(null);
    setOffset(0);

    try {
      const res = await executeQuery(connectionId, trimmed);
      setResult(res);
      addLogEntryRef.current({
        timestamp: new Date(),
        query: trimmed,
        db: "",
        schema: "",
        table: "",
        duration: res.duration,
        rowCount: res.rowCount ?? res.affectedRows,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      addLogEntryRef.current({
        timestamp: new Date(),
        query: trimmed,
        db: "",
        schema: "",
        table: "",
        duration: 0,
        error: msg,
      });
    } finally {
      setLoading(false);
    }
  }, [sql, connectionId, loading]);

  // Ctrl/Cmd+Enter to run
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      runQuery();
    }
  }, [runQuery]);

  // Paginated view of results
  const pageRows = useMemo(() => {
    if (!result?.rows) return [];
    return result.rows.slice(offset, offset + PAGE_SIZE);
  }, [result, offset]);

  const totalPages = result?.rows ? Math.max(1, Math.ceil(result.rows.length / PAGE_SIZE)) : 1;
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const hasPrev = offset > 0;
  const hasNext = result?.rows ? offset + PAGE_SIZE < result.rows.length : false;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* SQL Editor area */}
      <div className="flex flex-col shrink-0 border-b border-border">
        <div className="relative">
          <textarea
            ref={textareaRef}
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Enter SQL query... (Ctrl+Enter to run)"
            spellCheck={false}
            className="w-full min-h-[80px] max-h-[200px] resize-y bg-bg-primary text-text-primary text-[13px] font-mono p-3 pr-16 outline-none placeholder-text-muted"
          />
          <button
            onClick={runQuery}
            disabled={loading || !sql.trim()}
            title="Run query (Ctrl+Enter)"
            className="absolute top-2 right-2 flex items-center gap-1 px-2.5 py-1 rounded-md bg-accent hover:bg-accent-hover text-white text-[11px] font-medium disabled:opacity-40 disabled:cursor-default cursor-pointer transition-colors"
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
            Run
          </button>
        </div>
      </div>

      {/* Results area */}
      <div className="flex-1 flex flex-col min-h-0">
        {/* Error */}
        {error && (
          <div className="px-4 py-3 text-xs text-error bg-error/5 border-b border-border">
            {error}
          </div>
        )}

        {/* Success message for non-SELECT */}
        {result && !result.columns?.length && result.affectedRows !== undefined && (
          <div className="px-4 py-3 text-xs text-success bg-success/5 border-b border-border">
            Query executed successfully. {result.affectedRows} row{result.affectedRows !== 1 ? "s" : ""} affected. ({result.duration}ms)
          </div>
        )}

        {/* Result grid */}
        {result && result.columns?.length > 0 && (
          <>
            <div className="flex-1 overflow-auto min-h-0">
              <table className="w-full text-[12px] border-collapse" style={{ minWidth: "100%" }}>
                <thead className="sticky top-0 z-10">
                  <tr className="bg-bg-secondary border-b border-border">
                    <th className="px-2 py-1.5 text-left text-text-muted font-semibold whitespace-nowrap border-r border-border bg-bg-secondary sticky left-0 z-20 w-[50px]">
                      #
                    </th>
                    {result.columns.map((col) => (
                      <th
                        key={col}
                        className="px-3 py-1.5 text-left text-text-secondary font-semibold whitespace-nowrap border-r border-border bg-bg-secondary"
                      >
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((row, i) => (
                    <tr key={i} className="border-b border-border hover:bg-bg-hover transition-colors">
                      <td className="px-2 py-1 text-text-muted font-mono tabular-nums border-r border-border bg-bg-secondary sticky left-0 z-[5]">
                        {offset + i + 1}
                      </td>
                      {(row as unknown[]).map((cell, j) => (
                        <td key={j} className="px-3 py-1 whitespace-nowrap border-r border-border max-w-[300px] truncate">
                          <CellValue value={cell} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <div className="flex items-center justify-center px-3 py-1 border-t border-border bg-bg-secondary text-[11px] text-text-secondary gap-1">
              <span className="text-text-muted mr-2">
                {result.rows.length} row{result.rows.length !== 1 ? "s" : ""} ({result.duration}ms)
              </span>
              {result.rows.length > PAGE_SIZE && (
                <>
                  <button
                    onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                    disabled={!hasPrev}
                    className="p-0.5 rounded hover:bg-bg-hover disabled:opacity-30 disabled:cursor-default cursor-pointer transition-colors"
                  >
                    <ChevronLeft size={14} />
                  </button>
                  <span className="px-1">{page} / {totalPages}</span>
                  <button
                    onClick={() => setOffset(offset + PAGE_SIZE)}
                    disabled={!hasNext}
                    className="p-0.5 rounded hover:bg-bg-hover disabled:opacity-30 disabled:cursor-default cursor-pointer transition-colors"
                  >
                    <ChevronRight size={14} />
                  </button>
                </>
              )}
            </div>
          </>
        )}

        {/* Empty state */}
        {!result && !error && !loading && (
          <div className="flex-1 flex items-center justify-center text-text-muted text-xs">
            Write a query and press Ctrl+Enter to run
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div className="flex-1 flex items-center justify-center text-text-muted text-sm gap-2">
            <Loader2 size={14} className="animate-spin" />
            Executing...
          </div>
        )}
      </div>
    </div>
  );
}

function CellValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="text-text-muted italic">NULL</span>;
  }
  if (typeof value === "boolean") {
    return <span className="text-accent font-medium">{value ? "true" : "false"}</span>;
  }
  if (typeof value === "number") {
    return <span className="text-accent tabular-nums">{value}</span>;
  }
  if (typeof value === "object") {
    return <span className="text-text-muted font-mono">{JSON.stringify(value)}</span>;
  }
  return <span className="text-text-primary">{String(value)}</span>;
}
