import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { Loader2, Play, Sparkles, ChevronLeft, ChevronRight, ChevronDown } from "lucide-react";
import { type QueryResult } from "../lib/schema";
import { useQueryLog } from "../lib/queryLog";
import { useExecutionQueue } from "../lib/executionQueue";
import { HighlightedSQL } from "../lib/highlightSQL";
import { ResultGrid, type CellSelection } from "./ResultGrid";

interface QueryEditorProps {
  connectionId: string;
  activeDb: string;
  initialSql?: string;
  onSqlChange?: (sql: string) => void;
  onCellSelect?: (selection: CellSelection | null) => void;
}

const PAGE_SIZE = 100;

const ROW_LIMITS = [
  { value: 5, label: "5 rows" },
  { value: 10, label: "10 rows" },
  { value: 20, label: "20 rows" },
  { value: 50, label: "50 rows" },
  { value: 100, label: "100 rows" },
  { value: 500, label: "500 rows" },
  { value: 0, label: "No limit" },
];

/* ── Helpers ────────────────────────────────────────────── */

/** Adjust cursor position: if cursor is at end of a line right after a semicolon,
 *  treat it as belonging to that statement (not the next one).
 *  Only checks same-line — spaces/tabs before the semicolon, not across newlines. */
function adjustCursorForSemicolon(sql: string, cursorPos: number): number {
  let pos = cursorPos;
  // Only walk back over spaces/tabs on the same line
  while (pos > 0 && (sql[pos - 1] === " " || sql[pos - 1] === "\t")) pos--;
  // If we land right after a semicolon, shift into the previous statement
  if (pos > 0 && sql[pos - 1] === ";") return pos - 1;
  return cursorPos;
}

/** Find the statement (semicolon-delimited) around the cursor position. */
function getStatementAtCursor(sql: string, cursorPos: number): string {
  const pos = adjustCursorForSemicolon(sql, cursorPos);
  // Split by semicolons, tracking character positions
  let start = 0;
  const stmts: { text: string; start: number; end: number }[] = [];
  const parts = sql.split(";");
  for (let i = 0; i < parts.length; i++) {
    const end = start + parts[i].length;
    stmts.push({ text: parts[i], start, end });
    start = end + 1; // +1 for the semicolon
  }
  // Find which statement the cursor is in
  for (const s of stmts) {
    if (pos >= s.start && pos <= s.end) {
      return s.text.trim();
    }
  }
  // Fallback: last non-empty statement
  for (let i = stmts.length - 1; i >= 0; i--) {
    if (stmts[i].text.trim()) return stmts[i].text.trim();
  }
  return sql.trim();
}

/** Get the start/end char indices of the statement at cursor. */
function getStatementRange(sql: string, cursorPos: number): [number, number] {
  const pos = adjustCursorForSemicolon(sql, cursorPos);
  let start = 0;
  const parts = sql.split(";");
  for (let i = 0; i < parts.length; i++) {
    const end = start + parts[i].length;
    if (pos >= start && pos <= end) {
      // Trim leading whitespace from the statement range
      const trimStart = start + parts[i].search(/\S|$/);
      const trimEnd = start + parts[i].trimEnd().length;
      return [trimStart, trimEnd];
    }
    start = end + 1;
  }
  return [0, sql.length];
}

/** Simple SQL beautifier — uppercase keywords, normalize whitespace. */
function beautifySql(sql: string): string {
  const keywords = [
    "SELECT", "FROM", "WHERE", "AND", "OR", "NOT", "IN", "IS", "NULL",
    "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", "CREATE",
    "TABLE", "ALTER", "DROP", "INDEX", "JOIN", "LEFT", "RIGHT", "INNER",
    "OUTER", "ON", "AS", "ORDER", "BY", "GROUP", "HAVING", "LIMIT",
    "OFFSET", "DISTINCT", "UNION", "ALL", "EXISTS", "BETWEEN", "LIKE",
    "CASE", "WHEN", "THEN", "ELSE", "END", "ASC", "DESC",
    "PRIMARY", "KEY", "FOREIGN", "REFERENCES", "DEFAULT",
    "VIEW", "SHOW", "USE", "DESCRIBE", "EXPLAIN", "ANALYZE",
    "SCHEMA", "DATABASE", "IF", "REPLACE", "COUNT", "SUM", "AVG",
    "MIN", "MAX", "CASCADE", "CONSTRAINT", "CHECK", "UNIQUE",
  ];
  const kw = new Set(keywords);

  // Tokenize preserving strings and identifiers
  const tokens = sql.split(/(\s+|,|\(|\)|;|'[^']*'|"[^"]*"|`[^`]*`)/g).filter(Boolean);
  const result: string[] = [];
  const newlineBefore = new Set(["SELECT", "FROM", "WHERE", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "ORDER", "GROUP", "HAVING", "LIMIT", "UNION", "SET", "VALUES", "ON"]);

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^\s+$/.test(t)) continue; // skip original whitespace
    const upper = t.toUpperCase();
    if (kw.has(upper)) {
      if (newlineBefore.has(upper) && result.length > 0) {
        result.push("\n" + upper);
      } else {
        result.push(upper);
      }
    } else {
      result.push(t);
    }
  }

  // Join with spaces, but respect newlines
  let out = "";
  for (let i = 0; i < result.length; i++) {
    const t = result[i];
    if (t.startsWith("\n")) {
      out += t;
    } else if (i > 0 && !result[i - 1].endsWith("\n") && t !== "," && t !== ")" && t !== ";") {
      out += " " + t;
    } else {
      out += t;
    }
  }

  return out.trim();
}

/* ── Component ──────────────────────────────────────────── */

export function QueryEditor({ connectionId, activeDb, initialSql = "", onSqlChange, onCellSelect }: QueryEditorProps) {
  const [sql, setSql] = useState(initialSql);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [rowLimit, setRowLimit] = useState(50);
  const [showLimitMenu, setShowLimitMenu] = useState(false);
  const [cursorPos, setCursorPos] = useState(0);
  const [editorHeight, setEditorHeight] = useState(120);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const onSqlChangeRef = useRef(onSqlChange);
  onSqlChangeRef.current = onSqlChange;
  const execQueue = useExecutionQueue((s) => s.execute);
  const limitMenuRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  const addLogEntryRef = useRef(useQueryLog.getState().addEntry);
  addLogEntryRef.current = useQueryLog.getState().addEntry;

  // Auto-focus the editor on mount
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Close limit menu on outside click
  useEffect(() => {
    if (!showLimitMenu) return;
    const handler = (e: MouseEvent) => {
      if (limitMenuRef.current && !limitMenuRef.current.contains(e.target as Node)) {
        setShowLimitMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showLimitMenu]);

  // Determine the active statement (for highlighting)
  const activeRange = useMemo(() => {
    if (!sql.trim()) return null;
    return getStatementRange(sql, cursorPos);
  }, [sql, cursorPos]);

  const runQuery = useCallback(async () => {
    if (loading) return;

    const textarea = textareaRef.current;
    let queryToRun = "";

    // 1. If text is selected, run selection
    if (textarea && textarea.selectionStart !== textarea.selectionEnd) {
      queryToRun = sql.slice(textarea.selectionStart, textarea.selectionEnd).trim();
    }
    // 2. Otherwise, run the statement at cursor
    if (!queryToRun) {
      queryToRun = getStatementAtCursor(sql, cursorPos);
    }

    if (!queryToRun) return;

    // Append LIMIT if not already present and rowLimit > 0
    let finalQuery = queryToRun;
    if (rowLimit > 0 && /^\s*(SELECT|SHOW|DESCRIBE|EXPLAIN)/i.test(queryToRun)) {
      if (!/\bLIMIT\b/i.test(queryToRun)) {
        // Remove trailing semicolon before appending LIMIT
        finalQuery = queryToRun.replace(/;\s*$/, "") + ` LIMIT ${rowLimit}`;
      }
    }

    setLoading(true);
    setError(null);
    setResult(null);
    setOffset(0);

    try {
      const res = await execQueue(connectionId, finalQuery, activeDb);
      setResult(res);
      addLogEntryRef.current({
        timestamp: new Date(),
        query: finalQuery,
        db: activeDb,
        schema: "",
        table: "",
        duration: res.duration,
        rowCount: res.rowCount ?? res.affectedRows,
      });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const isCancelled = raw === "Cancelled" || raw.includes("aborted") || (err instanceof DOMException && err.name === "AbortError");
      const msg = isCancelled ? "Query killed" : raw;
      setError(msg);
      // Read cancel detail from the execution queue (set by server response before abort)
      const cancelDetail = isCancelled
        ? useExecutionQueue.getState().connections.get(connectionId)?.lastCancelDetail ?? undefined
        : undefined;
      addLogEntryRef.current({
        timestamp: new Date(),
        query: finalQuery,
        db: activeDb,
        schema: "",
        table: "",
        duration: 0,
        cancelled: isCancelled || undefined,
        cancelDetail,
        error: msg,
      });
    } finally {
      setLoading(false);
    }
  }, [sql, connectionId, loading, cursorPos, rowLimit]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      runQuery();
    }
  }, [runQuery]);

  const handleBeautify = useCallback(() => {
    const beautified = beautifySql(sql);
    setSql(beautified);
    onSqlChangeRef.current?.(beautified);
  }, [sql]);

  const handleCursorChange = useCallback(() => {
    if (textareaRef.current) {
      setCursorPos(textareaRef.current.selectionStart);
    }
  }, []);

  // Resizable editor pane
  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startY: e.clientY, startH: editorHeight };
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = ev.clientY - dragRef.current.startY;
      setEditorHeight(Math.max(60, Math.min(500, dragRef.current.startH + delta)));
    };
    const onMouseUp = () => {
      dragRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [editorHeight]);

  // Paginated view of results
  const pageRows = useMemo(() => {
    if (!result?.rows) return [];
    return result.rows.slice(offset, offset + PAGE_SIZE);
  }, [result, offset]);

  const totalPages = result?.rows ? Math.max(1, Math.ceil(result.rows.length / PAGE_SIZE)) : 1;
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const hasPrev = offset > 0;
  const hasNext = result?.rows ? offset + PAGE_SIZE < result.rows.length : false;
  const limitLabel = ROW_LIMITS.find((l) => l.value === rowLimit)?.label ?? `${rowLimit} rows`;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* SQL Editor area — resizable */}
      <div className="flex flex-col shrink-0" style={{ height: editorHeight }}>
        <div className="relative flex-1 min-h-0">
          {/* Syntax-highlighted layer behind the textarea */}
          <pre
            ref={preRef}
            aria-hidden
            className="pointer-events-none absolute inset-0 p-3 text-[13px] font-mono whitespace-pre-wrap break-words overflow-auto"
            style={{ color: "transparent" }}
          >
            <HighlightedSQL sql={sql || " "} activeRange={activeRange} />
          </pre>
          <textarea
            ref={textareaRef}
            value={sql}
            onChange={(e) => {
              const val = e.target.value;
              setSql(val);
              onSqlChangeRef.current?.(val);
              setCursorPos(e.target.selectionStart);
              // Sync scroll
              if (preRef.current) preRef.current.scrollTop = e.target.scrollTop;
            }}
            onScroll={(e) => {
              if (preRef.current) preRef.current.scrollTop = (e.target as HTMLTextAreaElement).scrollTop;
            }}
            onClick={handleCursorChange}
            onKeyUp={handleCursorChange}
            onKeyDown={handleKeyDown}
            placeholder="Enter SQL query... (Ctrl+Enter to run)"
            spellCheck={false}
            className="absolute inset-0 w-full h-full bg-transparent text-text-primary caret-text-primary text-[13px] font-mono p-3 outline-none placeholder-text-muted z-10 resize-none"
            style={{ caretColor: "var(--color-text-primary)", color: "transparent" }}
          />
        </div>
      </div>

      {/* Toolbar — between editor and results */}
      <div className="flex items-center h-8 px-2 border-y border-border bg-bg-secondary shrink-0 gap-1 no-select">
        {/* Row limit dropdown */}
        <div className="relative" ref={limitMenuRef}>
          <button
            onClick={() => setShowLimitMenu((v) => !v)}
            className="flex items-center gap-0.5 px-2 py-1 rounded text-[11px] text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer border border-border"
          >
            {limitLabel}
            <ChevronDown size={10} />
          </button>
          {showLimitMenu && (
            <div className="absolute top-full left-0 mt-1 w-[120px] rounded-md border border-border bg-bg-primary shadow-xl overflow-hidden z-[999] py-1">
              {ROW_LIMITS.map((opt) => (
                <div
                  key={opt.value}
                  onClick={() => { setRowLimit(opt.value); setShowLimitMenu(false); }}
                  className={`px-3 py-1.5 text-[11px] cursor-pointer transition-colors ${
                    opt.value === rowLimit
                      ? "text-accent bg-accent/10"
                      : "text-text-secondary hover:bg-bg-hover"
                  }`}
                >
                  {opt.label}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Beautify button */}
        <button
          onClick={handleBeautify}
          title="Beautify SQL"
          className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer border border-border"
        >
          <Sparkles size={11} />
          Beautify
        </button>

        <div className="flex-1" />

        {/* Run button */}
        <button
          onClick={runQuery}
          disabled={loading || !sql.trim()}
          title="Run query (Ctrl+Enter)"
          className="flex items-center gap-1 px-3 py-1 rounded-md bg-accent hover:bg-accent-hover text-white text-[11px] font-medium disabled:opacity-40 disabled:cursor-default cursor-pointer transition-colors"
        >
          {loading ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
          Run
        </button>
      </div>

      {/* Drag handle for resizing editor */}
      <div
        onMouseDown={onDragStart}
        className="h-[3px] shrink-0 cursor-row-resize hover:bg-accent/30 active:bg-accent/50 transition-colors"
      />

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
            Query executed successfully. {result.affectedRows} row{result.affectedRows !== 1 ? "s" : ""} affected. ({Math.round(result.duration * 100) / 100}ms)
          </div>
        )}

        {/* Result grid — shared component */}
        {result && result.columns?.length > 0 && (
          <>
            <div className="flex-1 min-h-0">
              <ResultGrid
                columns={result.columns}
                rows={pageRows}
                offset={offset}
                emptyMessage="Query returned no rows."
                clientSort
                onCellSelect={onCellSelect}
              />
            </div>

            {/* Pagination */}
            <div className="flex items-center justify-center px-3 py-1 border-t border-border bg-bg-secondary text-[11px] text-text-secondary gap-1 shrink-0">
              <span className="text-text-secondary mr-2">
                {result.rows.length} row{result.rows.length !== 1 ? "s" : ""} ({Math.round(result.duration * 100) / 100}ms)
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
