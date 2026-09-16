import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ctrlKey, modKey } from "../lib/platform";
import { Loader2, Play, Sparkles, ChevronLeft, ChevronRight, ChevronDown, ListStart, RotateCw } from "lucide-react";
import { fetchColumns, fetchSchemas, fetchTables, type ColumnInfo, type QueryResult } from "../lib/schema";
import { useExecutionQueue } from "../lib/executionQueue";
import { useEditStore } from "../lib/editStore";
import { findTableReferences, catalogTableKey, type CatalogTable } from "../lib/sqlAutocomplete";
import type { MonacoSqlEditorHandle } from "./MonacoSqlEditor";
import type { EditorCompletionContext } from "../lib/monacoSetup";
import { dialectToFormatterLanguage, formatSql } from "../lib/sqlFormat";
import { ResultGrid, type CellSelection, type CellRevealRequest } from "./ResultGrid";
import { CellEditorModal } from "./CellEditorModal";
import { useSchemaRevision } from "../lib/schemaRevision";
import { applyRowLimit, findSqlVariables, splitSqlStatements, sqlErrorMarker, statementAtCursor, substituteSqlVariables, type SqlErrorMarker, type SqlStatement } from "../lib/sqlStatements";
import { ExportMenu, type ExportScope } from "./ExportMenu";
import { exportRows } from "../lib/fileExport";
import type { ExportFormat } from "../lib/dataExport";

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

interface QueryExecution {
  id: string;
  statement: SqlStatement;
  executedSql: string;
  result?: QueryResult;
  error?: string;
  editableContext: EditableTableContext | null;
  running?: boolean;
  rolledBack?: boolean;
}

/* ── Helpers ────────────────────────────────────────────── */

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
  const [executions, setExecutions] = useState<QueryExecution[]>([]);
  const [activeExecutionId, setActiveExecutionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  const [rowLimit, setRowLimit] = useState(50);
  const [showLimitMenu, setShowLimitMenu] = useState(false);
  const [atomicRunAll, setAtomicRunAll] = useState(false);
  const [cursorPos, setCursorPos] = useState(0);
  const [editorHeight, setEditorHeight] = useState(120);
  const [selectedResultRows, setSelectedResultRows] = useState<Set<number>>(new Set());
  const [selectedResultData, setSelectedResultData] = useState<unknown[][]>([]);
  const [exporting, setExporting] = useState(false);
  const [exportedRows, setExportedRows] = useState(0);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [variableRequest, setVariableRequest] = useState<{ statements: SqlStatement[]; variables: string[] } | null>(null);
  const [catalog, setCatalog] = useState<CatalogTable[]>([]);
  const [columnRevision, setColumnRevision] = useState(0);
  const dataRevision = useEditStore((s) => s.dataRevision);
  const schemaRevision = useSchemaRevision(connectionId);

  const editorRef = useRef<MonacoSqlEditorHandle>(null);
  const onSqlChangeRef = useRef(onSqlChange);
  onSqlChangeRef.current = onSqlChange;
  const execQueue = useExecutionQueue((s) => s.execute);
  const execBatch = useExecutionQueue((s) => s.executeBatch);
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
  const lastExecutedRef = useRef<QueryExecution | null>(null);
  const selectedResultRef = useRef<CellSelection | null>(null);
  const lastDataRevisionRef = useRef(dataRevision);
  const editableContextRef = useRef<EditableTableContext | null>(null);
  const columnCacheRef = useRef<Map<string, ColumnInfo[]>>(new Map());
  const pendingColumnsRef = useRef<Set<string>>(new Set());
  const metadataGenerationRef = useRef(0);
  const activeExecution = executions.find((execution) => execution.id === activeExecutionId) ?? executions[0] ?? null;
  const result = activeExecution?.result ?? null;
  const error = activeExecution?.error ?? null;
  const editableContext = activeExecution?.editableContext ?? null;

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
    const statement = statementAtCursor(sql, cursorPos);
    return statement ? [statement.start, statement.end] as [number, number] : null;
  }, [sql, cursorPos]);

  const defaultSchema = defaultAutocompleteSchema(connectionType);
  const activeStatement = useMemo(() => statementAtCursor(sql, cursorPos)?.text ?? "", [sql, cursorPos]);
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

  // Double-click on a result cell opens the pop-out editor (read-only unless the query is editable)
  const [editorSelection, setEditorSelection] = useState<CellSelection | null>(null);
  const handleResultCellActivate = useCallback((selection: CellSelection) => {
    setEditorSelection(editableContext ? { ...selection, tableContext: editableContext } : selection);
  }, [editableContext]);

  const executeStatements = useCallback(async (statements: SqlStatement[], variableValues: Record<string, string> = {}) => {
    if (loading || statements.length === 0) return;
    const prepared = statements.map((statement, index): QueryExecution => {
      const substituted = substituteSqlVariables(statement.text, variableValues);
      return {
        id: `result-${Date.now()}-${index}`,
        statement,
        executedSql: applyRowLimit(substituted, rowLimit),
        editableContext: null,
        running: true,
      };
    });

    setExecutions(prepared);
    setActiveExecutionId(prepared[0].id);
    setLoading(true);
    setOffset(0);
    setSelectedResultRows(new Set());
    setSelectedResultData([]);
    selectedResultRef.current = null;
    editableContextRef.current = null;
    onCellSelect?.(null);
    editorRef.current?.setErrorMarkers([]);
    const markers: SqlErrorMarker[] = [];

    if (prepared.length > 1) {
      try {
        const batch = await execBatch(connectionId, prepared.map((item) => item.executedSql), activeDb, atomicRunAll);
        const completed = prepared.map((pending, index): QueryExecution => {
          const item = batch.results[index];
          if (!item) return { ...pending, running: false, error: batch.rolledBack ? "Not run (transaction rolled back)" : "Not run" };
          if (item.error) {
            markers.push(sqlErrorMarker(item.error, pending.statement));
            return { ...pending, running: false, error: item.error, rolledBack: batch.rolledBack };
          }
          const response: QueryResult = {
            columns: item.columns ?? [],
            rows: item.rows ?? [],
            rowCount: item.rowCount ?? item.rows?.length ?? 0,
            query: item.query,
            duration: item.duration,
            affectedRows: item.affectedRows,
          };
          return { ...pending, running: false, result: response, rolledBack: batch.rolledBack };
        });
        setExecutions(completed);
        lastExecutedRef.current = completed[completed.length - 1] ?? null;
        editorRef.current?.setErrorMarkers(markers);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        markers.push(sqlErrorMarker(message, prepared[0].statement));
        setExecutions(prepared.map((item, index) => ({ ...item, running: false, error: index === 0 ? message : "Not run" })));
        editorRef.current?.setErrorMarkers(markers);
      } finally {
        setLoading(false);
      }
      return;
    }

    for (let executionIndex = 0; executionIndex < prepared.length; executionIndex += 1) {
      const pending = prepared[executionIndex];
      try {
        const response = await execQueue(connectionId, pending.executedSql, activeDb);
        const context = statements.length === 1 ? await resolveEditableContext(pending.executedSql, response) : null;
        const completed = { ...pending, result: response, editableContext: context, running: false };
        lastExecutedRef.current = completed;
        editableContextRef.current = context;
        setExecutions((current) => current.map((item) => item.id === pending.id ? completed : item));
      } catch (cause) {
        const raw = cause instanceof Error ? cause.message : String(cause);
        const cancelled = raw === "Cancelled" || raw.includes("aborted") || (cause instanceof DOMException && cause.name === "AbortError");
        const message = cancelled ? "Query killed" : raw;
        markers.push(sqlErrorMarker(message, pending.statement));
        const failed = { ...pending, error: message, running: false };
        lastExecutedRef.current = failed;
        setExecutions((current) => current.map((item) => item.id === pending.id ? failed : item));
        if (cancelled) {
          const skippedIds = new Set(prepared.slice(executionIndex + 1).map((item) => item.id));
          setExecutions((current) => current.map((item) => skippedIds.has(item.id) ? { ...item, running: false, error: "Not run (execution cancelled)" } : item));
          break;
        }
      }
    }
    editorRef.current?.setErrorMarkers(markers);
    setLoading(false);
  }, [loading, rowLimit, execQueue, execBatch, connectionId, activeDb, atomicRunAll, resolveEditableContext, onCellSelect]);

  const requestExecution = useCallback((statements: SqlStatement[]) => {
    const variables = Array.from(new Set(statements.flatMap((statement) => findSqlVariables(statement.text).map((variable) => variable.name))));
    if (variables.length > 0) setVariableRequest({ statements, variables });
    else void executeStatements(statements);
  }, [executeStatements]);

  const runQuery = useCallback(() => {
    if (loading) return;
    const selection = editorRef.current?.getSelection();
    if (selection) {
      const statements = splitSqlStatements(selection.text).map((statement) => ({
        ...statement,
        start: statement.start + selection.start,
        end: statement.end + selection.start,
      }));
      requestExecution(statements);
      return;
    }
    const statement = statementAtCursor(sql, cursorPos);
    if (statement) requestExecution([statement]);
  }, [loading, sql, cursorPos, requestExecution]);

  const runAll = useCallback(() => {
    if (!loading) requestExecution(splitSqlStatements(sql));
  }, [loading, sql, requestExecution]);

  const rerunLast = useCallback(() => {
    const last = lastExecutedRef.current;
    if (last && !loading) requestExecution([last.statement]);
  }, [loading, requestExecution]);

  // Saving an editable query row increments the shared data revision. Rerun
  // the exact executed query and keep the detail panel on the same primary key.
  useEffect(() => {
    if (lastDataRevisionRef.current === dataRevision) return;
    lastDataRevisionRef.current = dataRevision;

    const lastExecution = lastExecutedRef.current;
    const executedSql = lastExecution?.executedSql;
    if (!lastExecution || !executedSql || !editableContextRef.current) return;
    let cancelled = false;

    setLoading(true);
    execQueue(connectionId, executedSql, activeDb)
      .then(async (res) => {
        const context = await resolveEditableContext(executedSql, res);
        if (cancelled) return;
        const completed = { ...lastExecution, result: res, error: undefined, editableContext: context };
        setExecutions((current) => current.map((item) => item.id === lastExecution.id ? completed : item));
        lastExecutedRef.current = completed;
        editableContextRef.current = context;
        publishRefreshedSelection(res, context);
      })
      .catch((err) => {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          setExecutions((current) => current.map((item) => item.id === lastExecution.id ? { ...item, error: message } : item));
        }
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
    editorRef.current?.setErrorMarkers([]);
    onSqlChangeRef.current?.(value);
  }, []);

  const handleExport = useCallback(async (format: ExportFormat, scope: ExportScope) => {
    if (!result) return;
    const visibleRows = result.rows.slice(offset, offset + PAGE_SIZE);
    const rows = scope === "selected"
      ? selectedResultData
      : scope === "page" ? visibleRows : result.rows;
    setExporting(true);
    setExportedRows(rows.length);
    setExportNotice(null);
    try {
      const path = await exportRows({
        suggestedName: `${activeDb}-query-result`,
        format,
        columns: result.columns,
        rows,
        dialect: connectionType,
        table: "query_result",
        database: activeDb,
      });
      if (path) setExportNotice(`Exported ${rows.length.toLocaleString()} rows.`);
    } catch (cause) {
      setExportNotice(`Export failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setExporting(false);
    }
  }, [result, offset, selectedResultData, activeDb, connectionType]);

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
              onRunAll={runAll}
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

        <button
          onClick={rerunLast}
          disabled={loading || !lastExecutedRef.current}
          title="Rerun the last statement"
          className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer border border-border disabled:opacity-40 disabled:cursor-default"
        >
          <RotateCw size={11} /> Rerun
        </button>

        <div className="flex-1" />

        <button
          onClick={runAll}
          disabled={loading || !sql.trim()}
          title={`Run all statements (${modKey("⇧↩", "Shift+Enter")})`}
          className="flex items-center gap-1 px-2 py-1 rounded-md border border-accent/50 text-accent hover:bg-accent/10 text-[11px] font-medium disabled:opacity-40 disabled:cursor-default cursor-pointer transition-colors"
        >
          <ListStart size={12} /> Run All
        </button>
        <button
          onClick={() => setAtomicRunAll((value) => !value)}
          title={connectionType === "mysql"
            ? "Run multiple statements on one connection inside a transaction; MySQL DDL may auto-commit"
            : "Run multiple statements on one connection inside a transaction; any error rolls the batch back"}
          className={`px-2 py-1 rounded-md border text-[11px] transition-colors cursor-pointer ${atomicRunAll ? "border-warning/60 bg-warning/10 text-warning" : "border-border text-text-muted hover:bg-bg-hover"}`}
        >
          {atomicRunAll ? "Atomic on" : "Atomic off"}
        </button>

        {/* Run current/selection button */}
        <button
          onClick={runQuery}
          disabled={loading || !sql.trim()}
          title={`Run query (${modKey("↩", "Enter")})`}
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
        {executions.length > 0 && (
          <div className="flex h-8 shrink-0 items-center overflow-x-auto border-b border-border bg-bg-secondary no-scrollbar">
            {executions.map((execution, index) => (
              <button
                key={execution.id}
                onClick={() => {
                  setActiveExecutionId(execution.id);
                  setOffset(0);
                  setSelectedResultRows(new Set());
                  setSelectedResultData([]);
                  editableContextRef.current = execution.editableContext;
                  selectedResultRef.current = null;
                  onCellSelect?.(null);
                }}
                className={`h-full shrink-0 border-r border-border px-3 text-[11px] transition-colors ${execution.id === activeExecution?.id ? "bg-bg-primary text-text-primary" : "text-text-muted hover:bg-bg-hover"}`}
                title={execution.statement.text}
              >
                {execution.running ? <Loader2 size={10} className="mr-1 inline animate-spin" /> : execution.error ? <span className="mr-1 text-error">●</span> : execution.rolledBack ? <span className="mr-1 text-warning">●</span> : <span className="mr-1 text-success">●</span>}
                {execution.error ? "Error" : execution.result?.columns?.length ? "Result" : "Statement"} {index + 1}
              </button>
            ))}
          </div>
        )}
        {/* Error */}
        {error && (
          <div className="px-4 py-3 text-xs text-error bg-error/5 border-b border-border">
            {error}
            {activeExecution?.rolledBack && <div className="mt-1 text-warning">The atomic batch was rolled back.</div>}
          </div>
        )}

        {/* Success message for non-SELECT */}
        {result && !result.columns?.length && result.affectedRows !== undefined && (
          <div className={`px-4 py-3 text-xs border-b border-border ${activeExecution?.rolledBack ? "text-warning bg-warning/5" : "text-success bg-success/5"}`}>
            {activeExecution?.rolledBack ? "Statement executed, then the atomic batch was rolled back." : "Query executed successfully."} {result.affectedRows} row{result.affectedRows !== 1 ? "s" : ""} affected. ({Math.round(result.duration * 100) / 100}ms)
          </div>
        )}

        {/* Result grid — shared component */}
        {result && result.columns?.length > 0 && (
          <>
            <div className="flex-1 min-h-0">
              <ResultGrid
                key={activeExecution?.id}
                columns={result.columns}
                rows={pageRows}
                offset={offset}
                emptyMessage="Query returned no rows."
                clientSort
                onCellSelect={handleResultCellSelect}
                onCellActivate={handleResultCellActivate}
                revealCell={revealCell}
                tableName="query_result"
                dialect={connectionType}
                database={activeDb}
                onSelectionChange={setSelectedResultRows}
                onSelectedRowsChange={setSelectedResultData}
              />
            </div>
            {editorSelection && (
              <CellEditorModal selection={editorSelection} onClose={() => setEditorSelection(null)} />
            )}

            {/* Pagination */}
            <div className="flex items-center px-3 py-1 border-t border-border bg-bg-secondary text-[11px] text-text-secondary gap-1 shrink-0">
              <ExportMenu
                selectedCount={selectedResultRows.size}
                pageCount={pageRows.length}
                allLabel={`All result rows (${result.rows.length.toLocaleString()})`}
                exporting={exporting}
                exportedRows={exportedRows}
                onExport={(format, scope) => void handleExport(format, scope)}
              />
              {exportNotice && <span className={`max-w-52 truncate px-1 text-[10px] ${exportNotice.startsWith("Export failed") ? "text-error" : "text-success"}`} title={exportNotice}>{exportNotice}</span>}
              <div className="flex-1 flex items-center justify-center gap-1">
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
            </div>
          </>
        )}

        {/* Empty state */}
        {!activeExecution && !loading && (
          <div className="flex-1 flex items-center justify-center text-text-muted text-xs">
            {`Write a query and press ${modKey("↩", "Enter")} to run`}
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
      {variableRequest && (
        <VariablePromptModal
          variables={variableRequest.variables}
          onCancel={() => setVariableRequest(null)}
          onRun={(values) => {
            const statements = variableRequest.statements;
            setVariableRequest(null);
            void executeStatements(statements, values);
          }}
        />
      )}
    </div>
  );
}

function VariablePromptModal({ variables, onCancel, onRun }: { variables: string[]; onCancel: () => void; onRun: (values: Record<string, string>) => void }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(variables.map((name) => [name, ""])));
  const firstRef = useRef<HTMLInputElement>(null);
  useEffect(() => { firstRef.current?.focus(); }, []);
  return <div className="fixed inset-0 z-[400] flex items-center justify-center bg-black/55 p-6" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <form className="w-full max-w-md rounded-lg border border-border bg-bg-primary shadow-2xl" onSubmit={(event) => { event.preventDefault(); onRun(values); }}>
      <div className="border-b border-border px-4 py-3">
        <div className="text-sm font-semibold">Query variables</div>
        <div className="mt-1 text-[11px] text-text-muted">Values in <code>{"{{name}}"}</code> are safely quoted. Use <code>{"{{name:raw}}"}</code> for SQL fragments.</div>
      </div>
      <div className="max-h-[50vh] space-y-3 overflow-auto p-4">
        {variables.map((name, index) => <label key={name} className="block">
          <span className="mb-1 block text-[11px] font-medium text-text-secondary">{name}</span>
          <input ref={index === 0 ? firstRef : undefined} value={values[name]} onChange={(event) => setValues((current) => ({ ...current, [name]: event.target.value }))} className="w-full rounded border border-border bg-bg-secondary px-2.5 py-1.5 font-mono text-xs outline-none focus:border-accent" />
        </label>)}
      </div>
      <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
        <button type="button" onClick={onCancel} className="rounded border border-border px-3 py-1.5 text-xs">Cancel</button>
        <button type="submit" className="rounded bg-accent px-3 py-1.5 text-xs text-white">Run</button>
      </div>
    </form>
  </div>;
}
