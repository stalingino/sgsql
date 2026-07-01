import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { Loader2, Play, Sparkles, ChevronLeft, ChevronRight, ChevronDown, Columns3, Table2, Layers3 } from "lucide-react";
import { fetchColumns, fetchSchemas, fetchTables, type ColumnInfo, type QueryResult } from "../lib/schema";
import { useQueryLog } from "../lib/queryLog";
import { useExecutionQueue } from "../lib/executionQueue";
import { useEditStore } from "../lib/editStore";
import {
  buildSqlCompletions,
  catalogTableKey,
  findTableReferences,
  getCompletionTarget,
  type CatalogTable,
  type SqlCompletion,
} from "../lib/sqlAutocomplete";
import { HighlightedSQL } from "../lib/highlightSQL";
import { ResultGrid, type CellSelection, type CellRevealRequest } from "./ResultGrid";
import { useSchemaRevision } from "../lib/schemaRevision";

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

function defaultAutocompleteSchema(type: QueryEditorProps["connectionType"]): string {
  if (type === "postgres") return "public";
  if (type === "sqlite") return "main";
  return "";
}

function completionPopupPosition(textarea: HTMLTextAreaElement, value: string, cursor: number) {
  const before = value.slice(0, cursor);
  const lines = before.split("\n");
  const column = (lines[lines.length - 1] ?? "").replace(/\t/g, "  ").length;
  const left = Math.max(8, Math.min(textarea.clientWidth - 380, 12 + column * 7.8 - textarea.scrollLeft));
  const naturalTop = 12 + lines.length * 19 - textarea.scrollTop;
  const top = Math.max(26, Math.min(textarea.clientHeight - 150, naturalTop));
  return { left, top };
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
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [columnRevision, setColumnRevision] = useState(0);
  const [completionOpen, setCompletionOpen] = useState(false);
  const [completionForced, setCompletionForced] = useState(false);
  const [completionIndex, setCompletionIndex] = useState(0);
  const [completionPosition, setCompletionPosition] = useState({ left: 12, top: 32 });
  const dataRevision = useEditStore((s) => s.dataRevision);
  const schemaRevision = useSchemaRevision(connectionId);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const onSqlChangeRef = useRef(onSqlChange);
  onSqlChangeRef.current = onSqlChange;
  const execQueue = useExecutionQueue((s) => s.execute);
  const executionPhase = useExecutionQueue((s) => s.connections.get(connectionId)?.phase ?? "idle");
  const limitMenuRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  const lastExecutedQueryRef = useRef<string | null>(null);
  const selectedResultRef = useRef<CellSelection | null>(null);
  const lastDataRevisionRef = useRef(dataRevision);
  const editableContextRef = useRef<EditableTableContext | null>(null);
  const columnCacheRef = useRef<Map<string, ColumnInfo[]>>(new Map());
  const pendingColumnsRef = useRef<Set<string>>(new Set());
  const metadataGenerationRef = useRef(0);

  const addLogEntryRef = useRef(useQueryLog.getState().addEntry);
  addLogEntryRef.current = useQueryLog.getState().addEntry;

  // Auto-focus the editor on mount
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Load relation metadata up front. Column metadata remains lazy and is only
  // requested for relations referenced by the active statement.
  useEffect(() => {
    let cancelled = false;
    const fallbackSchema = defaultAutocompleteSchema(connectionType);
    setCatalog([]);
    setCatalogLoading(true);
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
    })().finally(() => {
      if (!cancelled) setCatalogLoading(false);
    });

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

  const completionTarget = useMemo(
    () => getCompletionTarget(sql, cursorPos, completionForced),
    [sql, cursorPos, completionForced],
  );
  const completions = useMemo(
    () => buildSqlCompletions({
      target: completionTarget,
      catalog,
      references: tableReferences,
      columnsByTable: columnCacheRef.current,
      defaultSchema,
      dialect: connectionType,
    }),
    [completionTarget, catalog, tableReferences, defaultSchema, connectionType, columnRevision],
  );

  useEffect(() => {
    setCompletionIndex((index) => Math.min(index, Math.max(0, completions.length - 1)));
  }, [completions.length]);

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
        addLogEntryRef.current({
          timestamp: new Date(),
          query: executedSql,
          db: activeDb,
          schema: context?.schema ?? "",
          table: context?.table ?? "",
          duration: res.duration,
          rowCount: res.rowCount ?? res.affectedRows,
        });
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [dataRevision, connectionId, activeDb, execQueue, resolveEditableContext, publishRefreshedSelection]);

  const applyCompletion = useCallback((completion: SqlCompletion) => {
    const nextSql = sql.slice(0, completionTarget.replaceStart) + completion.insertText + sql.slice(completionTarget.replaceEnd);
    const nextCursor = completionTarget.replaceStart + completion.insertText.length;
    setSql(nextSql);
    setCursorPos(nextCursor);
    setCompletionOpen(false);
    setCompletionForced(false);
    onSqlChangeRef.current?.(nextSql);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(nextCursor, nextCursor);
    });
  }, [sql, completionTarget]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      setCompletionOpen(false);
      runQuery();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === " " || e.code === "Space")) {
      e.preventDefault();
      const textarea = textareaRef.current;
      if (textarea) {
        const position = textarea.selectionStart;
        setCursorPos(position);
        setCompletionPosition(completionPopupPosition(textarea, sql, position));
      }
      setCompletionForced(true);
      setCompletionOpen(true);
      setCompletionIndex(0);
      return;
    }
    if (!completionOpen) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCompletionIndex((index) => completions.length ? (index + 1) % completions.length : 0);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCompletionIndex((index) => completions.length ? (index - 1 + completions.length) % completions.length : 0);
    } else if ((e.key === "Enter" || e.key === "Tab") && completions[completionIndex]) {
      e.preventDefault();
      applyCompletion(completions[completionIndex]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setCompletionOpen(false);
      setCompletionForced(false);
    }
  }, [runQuery, completionOpen, completions, completionIndex, applyCompletion, sql]);

  const handleBeautify = useCallback(() => {
    const beautified = beautifySql(sql);
    setSql(beautified);
    setCompletionOpen(false);
    setCompletionForced(false);
    onSqlChangeRef.current?.(beautified);
  }, [sql]);

  const handleSelectionChange = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const position = textarea.selectionStart;
    setCursorPos(position);
    setCompletionPosition(completionPopupPosition(textarea, sql, position));
  }, [sql]);

  const handleEditorClick = useCallback(() => {
    handleSelectionChange();
    setCompletionOpen(false);
    setCompletionForced(false);
  }, [handleSelectionChange]);

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
              const position = e.target.selectionStart;
              const target = getCompletionTarget(val, position);
              setSql(val);
              onSqlChangeRef.current?.(val);
              setCursorPos(position);
              setCompletionForced(false);
              setCompletionOpen(target.shouldOpen);
              setCompletionIndex(0);
              setCompletionPosition(completionPopupPosition(e.target, val, position));
              // Sync scroll
              if (preRef.current) preRef.current.scrollTop = e.target.scrollTop;
            }}
            onScroll={(e) => {
              const textarea = e.target as HTMLTextAreaElement;
              if (preRef.current) preRef.current.scrollTop = textarea.scrollTop;
              setCompletionPosition(completionPopupPosition(textarea, sql, textarea.selectionStart));
            }}
            onClick={handleEditorClick}
            onSelect={handleSelectionChange}
            onKeyDown={handleKeyDown}
            onBlur={(e) => {
              if ((e.relatedTarget as HTMLElement | null)?.closest("[data-sql-completion]")) return;
              setCompletionOpen(false);
              setCompletionForced(false);
            }}
            placeholder="Enter SQL query... (Ctrl+Enter to run)"
            spellCheck={false}
            className="absolute inset-0 w-full h-full bg-transparent text-text-primary caret-text-primary text-[13px] font-mono p-3 outline-none placeholder-text-muted z-10 resize-none"
            style={{ caretColor: "var(--color-text-primary)", color: "transparent" }}
          />
          {completionOpen && (completions.length > 0 || completionForced || catalogLoading) && (
            <div
              data-sql-completion
              className="absolute z-30 w-[380px] max-w-[calc(100%-16px)] max-h-64 overflow-y-auto rounded-lg border border-border-light bg-bg-primary shadow-2xl py-1.5 text-[12px] no-select"
              style={{ left: completionPosition.left, top: completionPosition.top }}
              onMouseDown={(e) => e.preventDefault()}
            >
              {completions.map((completion, index) => (
                <button
                  key={completion.key}
                  type="button"
                  className={`flex items-start gap-2.5 w-full px-3 py-2 text-left cursor-pointer ${
                    index === completionIndex ? "bg-accent/15 text-text-primary" : "hover:bg-bg-hover text-text-secondary"
                  }`}
                  onMouseEnter={() => setCompletionIndex(index)}
                  onClick={() => applyCompletion(completion)}
                >
                  {completion.kind === "column" ? (
                    <Columns3 size={13} className="shrink-0 mt-0.5 text-accent" />
                  ) : completion.kind === "schema" ? (
                    <Layers3 size={13} className="shrink-0 mt-0.5 text-purple-400" />
                  ) : (
                    <Table2 size={13} className="shrink-0 mt-0.5 text-sky-400" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-[12px] text-text-primary">{completion.label}</span>
                    <span className="block truncate text-[10px] text-text-muted mt-0.5">{completion.detail}</span>
                  </span>
                </button>
              ))}
              {completions.length === 0 && (
                <div className="flex items-center gap-2 px-3 py-2 text-text-muted">
                  {catalogLoading && <Loader2 size={11} className="animate-spin" />}
                  {catalogLoading ? "Loading schema metadata…" : "No schema suggestions"}
                </div>
              )}
              {completions.length > 0 && (
                <div className="px-3 pt-2 pb-1 text-[9px] text-text-muted border-t border-border mt-1">
                  <span>↑↓ Navigate · Enter/Tab Insert · Esc Close · Ctrl+Space Open</span>
                </div>
              )}
            </div>
          )}
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
            Write a query and press Ctrl+Enter to run
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
