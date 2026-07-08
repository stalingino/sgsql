import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ctrlKey } from "../lib/platform";
import { Loader2, Play, Sparkles, ChevronLeft, ChevronRight, ChevronDown } from "lucide-react";
import { fetchColumns, fetchSchemas, fetchTables, type ColumnInfo, type QueryResult } from "../lib/schema";
import { useExecutionQueue } from "../lib/executionQueue";
import { useEditStore } from "../lib/editStore";
import { findTableReferences, catalogTableKey, type CatalogTable } from "../lib/sqlAutocomplete";
import type { MonacoSqlEditorHandle } from "./MonacoSqlEditor";
import type { EditorCompletionContext } from "../lib/monacoSetup";
import { dialectToFormatterLanguage, formatSql } from "../lib/sqlFormat";
import { ResultGrid, type CellSelection, type CellRevealRequest } from "./ResultGrid";
import { useSchemaRevision } from "../lib/schemaRevision";

// Monaco's core bundle is a few MB — code-split it into its own chunk so
// app startup isn't penalized for sessions that never open a query tab.
const MonacoSqlEditor = lazy(() => import("./MonacoSqlEditor"));

interface QueryEditorProps {
  connectionId: string;
  connectionType: "postgres" | "mysql" | "sqlite";
  activeDb: string;
  initialSql?: string;
  onSqlChange?: (sql: string) => void;
  onCellSelect?: (selection: CellSelection | null) => void;
  revealCell?: CellRevealRequest | null;
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

type EditableTableContext = NonNullable<CellSelection["tableContext"]>;

interface MysqlTableSource {
  db: string;
  table: string;
}

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

/**
 * Resolve the one source table for a conservative subset of MySQL SELECTs.
 * Anything ambiguous stays read-only; false negatives are safer than writing
 * to the wrong table.
 */
function parseEditableMysqlSource(sql: string, activeDb: string): MysqlTableSource | null {
  if (!/^\s*SELECT\b/i.test(sql)) return null;
  if (/\b(?:JOIN|UNION|GROUP\s+BY|HAVING|DISTINCT|INTO|PROCEDURE)\b/i.test(sql)) return null;

  const fromMatch = /\bFROM\b/i.exec(sql);
  if (!fromMatch) return null;

  const projection = sql.slice(sql.search(/\bSELECT\b/i) + 6, fromMatch.index);
  if (/\bSELECT\b/i.test(projection)) return null;

  const afterFrom = sql.slice(fromMatch.index + fromMatch[0].length);
  const boundary = /\b(?:WHERE|ORDER\s+BY|LIMIT|OFFSET|FOR\s+UPDATE|LOCK\s+IN\s+SHARE\s+MODE)\b|;/i.exec(afterFrom);
  const sourceClause = (boundary ? afterFrom.slice(0, boundary.index) : afterFrom).trim();
  if (!sourceClause || sourceClause.startsWith("(") || sourceClause.includes(",")) return null;

  const ident = "(?:`(?:``|[^`])+`|[A-Za-z_$][\\w$]*)";
  const sourcePattern = new RegExp(
    `^(${ident})(?:\\s*\\.\\s*(${ident}))?(?:\\s+(?:AS\\s+)?${ident})?$`,
    "i",
  );
  const match = sourcePattern.exec(sourceClause);
  if (!match) return null;

  const unquote = (value: string) =>
    value.startsWith("`") ? value.slice(1, -1).replace(/``/g, "`") : value;
  const first = unquote(match[1]);
  const second = match[2] ? unquote(match[2]) : null;
  return second
    ? { db: first, table: second }
    : { db: activeDb, table: first };
}

function defaultAutocompleteSchema(type: QueryEditorProps["connectionType"]): string {
  if (type === "postgres") return "public";
  if (type === "sqlite") return "main";
  return "";
}

/* ── Component ──────────────────────────────────────────── */

export function QueryEditor({ connectionId, connectionType, activeDb, initialSql = "", onSqlChange, onCellSelect, revealCell }: QueryEditorProps) {
  const [sql, setSql] = useState(initialSql);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [rowLimit, setRowLimit] = useState(50);
  const [showLimitMenu, setShowLimitMenu] = useState(false);
  const [cursorPos, setCursorPos] = useState(0);
  const [editorHeight, setEditorHeight] = useState(120);
  const [editableContext, setEditableContext] = useState<EditableTableContext | null>(null);
  const [catalog, setCatalog] = useState<CatalogTable[]>([]);
  const [columnRevision, setColumnRevision] = useState(0);
  const dataRevision = useEditStore((s) => s.dataRevision);
  const schemaRevision = useSchemaRevision(connectionId);

  const editorRef = useRef<MonacoSqlEditorHandle>(null);
  const onSqlChangeRef = useRef(onSqlChange);
  onSqlChangeRef.current = onSqlChange;
  const execQueue = useExecutionQueue((s) => s.execute);
  const executionPhase = useExecutionQueue((s) => s.connections.get(connectionId)?.phase ?? "idle");
  const limitMenuRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Layout effect (not a plain effect) so the real height is committed before
  // the browser paints — otherwise the fallback 120px height flashes first.
  useLayoutEffect(() => {
    if (containerRef.current) {
      setEditorHeight(Math.round(containerRef.current.offsetHeight * 0.8));
    }
  }, []);
  const lastExecutedQueryRef = useRef<string | null>(null);
  const selectedResultRef = useRef<CellSelection | null>(null);
  const lastDataRevisionRef = useRef(dataRevision);
  const editableContextRef = useRef<EditableTableContext | null>(null);
  const columnCacheRef = useRef<Map<string, ColumnInfo[]>>(new Map());
  const pendingColumnsRef = useRef<Set<string>>(new Set());
  const metadataGenerationRef = useRef(0);

  // Load relation metadata up front. Column metadata remains lazy and is only
  // requested for relations referenced by the active statement.
  useEffect(() => {
    let cancelled = false;
    const fallbackSchema = defaultAutocompleteSchema(connectionType);
    setCatalog([]);
    columnCacheRef.current = new Map();
    pendingColumnsRef.current = new Set();
    metadataGenerationRef.current += 1;
    setColumnRevision((revision) => revision + 1);

    (async () => {
      let schemas = [fallbackSchema];
      if (connectionType === "postgres") {
        try {
          const loaded = await fetchSchemas(connectionId, activeDb);
          if (loaded.length > 0) schemas = loaded;
        } catch {
          // Keep public-schema autocomplete available if schema enumeration fails.
        }
      }

      const groups = await Promise.all(schemas.map(async (schema) => {
        try {
          const tables = await fetchTables(connectionId, activeDb, schema);
          return tables.map((table): CatalogTable => ({ ...table, db: activeDb, schema }));
        } catch {
          return [];
        }
      }));
      if (!cancelled) setCatalog(groups.flat());
    })();

    return () => { cancelled = true; };
  }, [connectionId, connectionType, activeDb, schemaRevision]);

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

  const defaultSchema = defaultAutocompleteSchema(connectionType);
  const activeStatement = useMemo(() => getStatementAtCursor(sql, cursorPos), [sql, cursorPos]);
  const tableReferences = useMemo(
    () => findTableReferences(activeStatement, catalog, defaultSchema),
    [activeStatement, catalog, defaultSchema],
  );

  useEffect(() => {
    const generation = metadataGenerationRef.current;
    const pending = pendingColumnsRef.current;
    for (const table of tableReferences) {
      const key = catalogTableKey(table);
      if (columnCacheRef.current.has(key) || pending.has(key)) continue;
      pending.add(key);
      fetchColumns(connectionId, table.db, table.schema, table.name)
        .then((columns) => {
          if (generation !== metadataGenerationRef.current) return;
          columnCacheRef.current.set(key, columns);
          setColumnRevision((revision) => revision + 1);
        })
        .catch(() => {})
        .finally(() => pending.delete(key));
    }
  }, [connectionId, tableReferences]);

  // Read fresh on every completion request — Monaco calls this at request
  // time via a ref, so it always sees the latest catalog/columns/etc.
  // without needing to re-register the (global, per-language) provider.
  const getCompletionContext = useCallback((): EditorCompletionContext => ({
    catalog,
    tableReferences,
    columnsByTable: columnCacheRef.current,
    defaultSchema,
    dialect: connectionType,
  }), [catalog, tableReferences, defaultSchema, connectionType, columnRevision]);

  const resolveEditableContext = useCallback(async (
    executedSql: string,
    queryResult: QueryResult,
  ): Promise<EditableTableContext | null> => {
    if (connectionType !== "mysql" || !queryResult.columns?.length) return null;
    const source = parseEditableMysqlSource(executedSql, activeDb);
    if (!source?.db) return null;

    try {
      const metadata = await fetchColumns(connectionId, source.db, "", source.table);
      const sourceColumns = new Set(metadata.map((column) => column.name));
      const resultColumns = queryResult.columns;
      const pkColumns = metadata.filter((column) => column.isPk).map((column) => column.name);

      // Aliases, expressions, duplicate names, and missing PK values make a
      // result unsafe to map back to one source row.
      if (pkColumns.length === 0) return null;
      if (new Set(resultColumns).size !== resultColumns.length) return null;
      if (resultColumns.some((column) => !sourceColumns.has(column))) return null;
      if (pkColumns.some((column) => !resultColumns.includes(column))) return null;

      return {
        connectionId,
        connectionType,
        db: source.db,
        schema: "",
        table: source.table,
        pkColumns,
        columnMeta: metadata.map((column) => ({
          name: column.name,
          dataType: column.dataType,
          udtName: column.udtName,
          enumValues: column.enumValues,
          defaultValue: column.defaultValue,
        })),
      };
    } catch {
      return null;
    }
  }, [connectionId, connectionType, activeDb]);

  const publishRefreshedSelection = useCallback((
    queryResult: QueryResult,
    context: EditableTableContext | null,
  ) => {
    const previous = selectedResultRef.current;
    if (!previous || !context) return;

    const oldPkIndexes = context.pkColumns.map((pk) => previous.columns.indexOf(pk));
    const newPkIndexes = context.pkColumns.map((pk) => queryResult.columns.indexOf(pk));
    if (oldPkIndexes.some((index) => index < 0) || newPkIndexes.some((index) => index < 0)) {
      selectedResultRef.current = null;
      onCellSelect?.(null);
      return;
    }

    const pkValues = oldPkIndexes.map((index) => previous.row[index]);
    const resultIndex = queryResult.rows.findIndex((row) =>
      newPkIndexes.every((columnIndex, index) => Object.is(row[columnIndex], pkValues[index])),
    );
    if (resultIndex < 0) {
      selectedResultRef.current = null;
      onCellSelect?.(null);
      return;
    }

    const refreshed: CellSelection = {
      ...previous,
      rowIndex: resultIndex - offset,
      row: queryResult.rows[resultIndex],
      columns: queryResult.columns,
      tableContext: context,
    };
    selectedResultRef.current = refreshed;
    onCellSelect?.(refreshed);
  }, [offset, onCellSelect]);

  const handleResultCellSelect = useCallback((selection: CellSelection | null) => {
    if (!selection) {
      selectedResultRef.current = null;
      onCellSelect?.(null);
      return;
    }
    const enriched = editableContext
      ? { ...selection, tableContext: editableContext }
      : selection;
    selectedResultRef.current = enriched;
    onCellSelect?.(enriched);
  }, [editableContext, onCellSelect]);

  const runQuery = useCallback(async () => {
    if (loading) return;

    const selected = editorRef.current?.getSelectionText().trim();
    // 1. If text is selected, run selection. 2. Otherwise, run the statement at cursor.
    const queryToRun = selected || getStatementAtCursor(sql, cursorPos);

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
    setEditableContext(null);
    editableContextRef.current = null;
    selectedResultRef.current = null;
    onCellSelect?.(null);
    setOffset(0);

    try {
      const res = await execQueue(connectionId, finalQuery, activeDb);
      const context = await resolveEditableContext(finalQuery, res);
      setResult(res);
      setEditableContext(context);
      editableContextRef.current = context;
      lastExecutedQueryRef.current = finalQuery;
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const isCancelled = raw === "Cancelled" || raw.includes("aborted") || (err instanceof DOMException && err.name === "AbortError");
      const msg = isCancelled ? "Query killed" : raw;
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [sql, connectionId, loading, cursorPos, rowLimit, activeDb, execQueue, onCellSelect, resolveEditableContext]);

  // Saving an editable query row increments the shared data revision. Rerun
  // the exact executed query and keep the detail panel on the same primary key.
  useEffect(() => {
    if (lastDataRevisionRef.current === dataRevision) return;
    lastDataRevisionRef.current = dataRevision;

    const executedSql = lastExecutedQueryRef.current;
    if (!executedSql || !editableContextRef.current) return;
    let cancelled = false;

    setLoading(true);
    execQueue(connectionId, executedSql, activeDb)
      .then(async (res) => {
        const context = await resolveEditableContext(executedSql, res);
        if (cancelled) return;
        setResult(res);
        setEditableContext(context);
        editableContextRef.current = context;
        publishRefreshedSelection(res, context);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [dataRevision, connectionId, activeDb, execQueue, resolveEditableContext, publishRefreshedSelection]);

  const handleBeautify = useCallback(() => {
    const value = editorRef.current?.getValue();
    if (!value?.trim()) return;
    const beautified = formatSql(value, {
      language: dialectToFormatterLanguage(connectionType),
      keywordCase: "upper",
    });
    editorRef.current?.setValue(beautified);
    editorRef.current?.focus();
  }, [connectionType]);

  const handleEditorChange = useCallback((value: string) => {
    setSql(value);
    onSqlChangeRef.current?.(value);
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
      const maxH = (containerRef.current?.offsetHeight ?? 800) - 60;
      setEditorHeight(Math.max(40, Math.min(maxH, dragRef.current.startH + delta)));
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
    <div ref={containerRef} className="flex flex-col h-full min-h-0">
      {/* SQL Editor area — resizable */}
      <div className="flex flex-col shrink-0" style={{ height: editorHeight }}>
        <div className="relative flex-1 min-h-0">
          <Suspense fallback={<div className="absolute inset-0 flex items-center justify-center text-text-muted text-xs">
            <Loader2 size={14} className="animate-spin" />
          </div>}>
            <MonacoSqlEditor
              ref={editorRef}
              defaultValue={initialSql}
              activeRange={activeRange}
              onChange={handleEditorChange}
              onCursorChange={setCursorPos}
              onRunQuery={runQuery}
              getCompletionContext={getCompletionContext}
            />
          </Suspense>
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
          title={`Beautify SQL (${ctrlKey("⇧⌥", "Shift+Alt")}+F)`}
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
          title={`Run query (${ctrlKey("↩", "Enter")})`}
          className="flex items-center gap-1 px-3 py-1 rounded-md bg-accent hover:bg-accent-hover text-white text-[11px] font-medium disabled:opacity-40 disabled:cursor-default cursor-pointer transition-colors"
        >
          {loading ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
          Run
        </button>
      </div>

      {/* Drag handle for resizing editor — thicker hit target with a visible grip. */}
      <div
        onMouseDown={onDragStart}
        className="group h-[7px] shrink-0 cursor-row-resize flex items-center justify-center bg-border/15 hover:bg-accent/25 active:bg-accent/40 transition-colors"
      >
        <div className="w-8 h-[3px] rounded-full bg-border-light group-hover:bg-accent transition-colors" />
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
                onCellSelect={handleResultCellSelect}
                revealCell={revealCell}
              />
            </div>

            {/* Pagination */}
            <div className="flex items-center justify-center px-3 py-1 border-t border-border bg-bg-secondary text-[11px] text-text-secondary gap-1 shrink-0">
              <span
                className={editableContext ? "text-success mr-2" : "text-text-muted mr-2"}
                title={editableContext
                  ? `Updates target ${editableContext.db}.${editableContext.table} by primary key`
                  : "Editing requires a single-table MySQL SELECT containing every primary-key column and no ambiguous result columns"}
              >
                {editableContext ? "Editable" : "Read-only"}
              </span>
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
            {`Write a query and press ${ctrlKey("↩", "Enter")} to run`}
          </div>
        )}

        {/* Loading */}
        {loading && !result && (
          <div className="flex-1 flex items-center justify-center text-text-muted text-sm gap-2">
            <Loader2 size={14} className="animate-spin" />
            {executionPhase === "checking"
              ? "Checking connection…"
              : executionPhase === "cancelling"
                ? "Cancelling…"
                : "Executing…"}
          </div>
        )}
      </div>
    </div>
  );
}
