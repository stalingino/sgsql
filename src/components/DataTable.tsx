import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2,
  ChevronLeft,
  ChevronRight,
  Table2,
  Columns2,
  KeyRound,
  Link2,
  Filter,
  Plus,
  Trash2,
  Code2,
  Copy,
  Check,
  RefreshCw,
  X,
} from "lucide-react";
import {
  fetchTableRows,
  fetchColumns,
  type TableRowsResult,
  type ColumnInfo,
} from "../lib/schema";
import { useQueryLog } from "../lib/queryLog";
import { useEditStore, buildRowKey, tableRefreshKey } from "../lib/editStore";
import { ResultGrid, type SortState, type CellSelection } from "./ResultGrid";
import { getConfig } from "../lib/config";
import { HighlightedSQL } from "../lib/highlightSQL";
import { FilterPanel, type FilterRow, createFilter, buildWhereClause } from "./FilterPanel";
import { SchemaEditor } from "./SchemaEditor";

interface DataTableProps {
  connectionId: string;
  connectionType: "postgres" | "mysql" | "sqlite";
  db: string;
  schema: string;
  table: string;
  onCellSelect?: (selection: CellSelection | null) => void;
  viewMode?: ViewMode;
  onViewModeChange?: (mode: ViewMode) => void;
}

const PAGE_SIZE = 50;

function quotePreviewIdent(type: "postgres" | "mysql" | "sqlite", value: string): string {
  if (type === "mysql") return `\`${value.replace(/`/g, "``")}\``;
  return `"${value.replace(/"/g, '""')}"`;
}

function buildPreviewSql({
  connectionType,
  db,
  schema,
  table,
  where,
  sort,
}: {
  connectionType: "postgres" | "mysql" | "sqlite";
  db: string;
  schema: string;
  table: string;
  where: string;
  sort: SortState | null;
}): string {
  const tableRef = connectionType === "mysql"
    ? `${quotePreviewIdent(connectionType, db || "information_schema")}.${quotePreviewIdent(connectionType, table)}`
    : connectionType === "postgres"
      ? `${quotePreviewIdent(connectionType, schema || "public")}.${quotePreviewIdent(connectionType, table)}`
      : quotePreviewIdent(connectionType, table);
  const whereClause = where ? ` WHERE ${where}` : "";
  const orderClause = sort
    ? ` ORDER BY ${quotePreviewIdent(connectionType, sort.column)} ${sort.dir}`
    : "";
  return `SELECT * FROM ${tableRef}${whereClause}${orderClause} LIMIT ${PAGE_SIZE} OFFSET 0`;
}

type ViewMode = "data" | "structure";

/* ── Constants for structure view auto-sizing ───────────── */
const MIN_COL_WIDTH = 40;
const DEFAULT_COL_WIDTH = 150;
const AUTO_MAX_WIDTH = 350;
const CHAR_WIDTH = 7.5;
const CELL_PAD = 28;
const SAMPLE_ROWS = 20;
const STRUCT_ROW_NUM_WIDTH = 40;
const STRUCT_COL_KEYS = ["Column", "Type", "Null", "Default", "Key"];

/* ── Auto-size helper (for structure view) ─────────────── */

function estimateColWidths(
  columns: string[],
  rows?: unknown[][],
): Record<string, number> {
  const widths: Record<string, number> = {};
  for (let ci = 0; ci < columns.length; ci++) {
    const col = columns[ci];
    let maxLen = col.length;
    if (rows) {
      const end = Math.min(rows.length, SAMPLE_ROWS);
      for (let ri = 0; ri < end; ri++) {
        const cell = rows[ri]?.[ci];
        const len =
          cell === null || cell === undefined
            ? 4
            : typeof cell === "object"
              ? Math.min(JSON.stringify(cell).length, 40)
              : String(cell).length;
        if (len > maxLen) maxLen = len;
      }
    }
    widths[col] = Math.max(
      MIN_COL_WIDTH,
      Math.min(AUTO_MAX_WIDTH, Math.round(maxLen * CHAR_WIDTH + CELL_PAD)),
    );
  }
  return widths;
}

/* ── Resizable column hook (for structure view) ────────── */

function useResizableColumns(
  columnKeys: string[],
  autoSizeData?: { columns: string[]; rows?: unknown[][] },
) {
  const [widths, setWidths] = useState<Record<string, number>>({});
  const widthsRef = useRef<Record<string, number>>({});
  const tableRef = useRef<HTMLTableElement | null>(null);
  const dragRef = useRef<{ col: string; startX: number; startW: number } | null>(null);
  const manualRef = useRef<Set<string>>(new Set());

  widthsRef.current = widths;

  useEffect(() => {
    if (!autoSizeData) {
      setWidths((prev) => {
        const next = { ...prev };
        let changed = false;
        for (const key of columnKeys) {
          if (!(key in next)) {
            next[key] = DEFAULT_COL_WIDTH;
            changed = true;
          }
        }
        return changed ? next : prev;
      });
      return;
    }
    const estimated = estimateColWidths(autoSizeData.columns, autoSizeData.rows);
    setWidths((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const key of columnKeys) {
        if (manualRef.current.has(key)) continue;
        const auto = estimated[key] ?? DEFAULT_COL_WIDTH;
        if (next[key] !== auto) {
          next[key] = auto;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [columnKeys, autoSizeData]);

  const onMouseDown = useCallback(
    (col: string, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = widthsRef.current[col] ?? DEFAULT_COL_WIDTH;
      dragRef.current = { col, startX, startW };

      const onMouseMove = (ev: MouseEvent) => {
        if (!dragRef.current) return;
        const delta = ev.clientX - dragRef.current.startX;
        const newW = Math.max(MIN_COL_WIDTH, dragRef.current.startW + delta);

        widthsRef.current = { ...widthsRef.current, [dragRef.current.col]: newW };

        if (tableRef.current) {
          const colgroup = tableRef.current.querySelector("colgroup");
          if (colgroup) {
            const cols = colgroup.querySelectorAll("col");
            const colIndex = columnKeys.indexOf(dragRef.current.col);
            if (colIndex !== -1 && cols[colIndex + 1]) {
              (cols[colIndex + 1] as HTMLElement).style.width = `${newW}px`;
            }
          }
          let total = 0;
          const cg = tableRef.current.querySelector("colgroup");
          if (cg) {
            cg.querySelectorAll("col").forEach((c) => {
              total += parseFloat((c as HTMLElement).style.width) || DEFAULT_COL_WIDTH;
            });
          }
          tableRef.current.style.width = `${total}px`;
        }
      };

      const onMouseUp = () => {
        if (dragRef.current) {
          manualRef.current.add(dragRef.current.col);
        }
        dragRef.current = null;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        setWidths({ ...widthsRef.current });
      };

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [columnKeys],
  );

  const getWidth = useCallback(
    (col: string) => widths[col] ?? DEFAULT_COL_WIDTH,
    [widths],
  );

  const totalWidth = useCallback(
    (keys: string[], extra = 0) =>
      keys.reduce((sum, k) => sum + (widths[k] ?? DEFAULT_COL_WIDTH), extra),
    [widths],
  );

  return { getWidth, onMouseDown, totalWidth, tableRef };
}

/* ── Resizable header cell (for structure view) ────────── */

function ResizableTh({
  colKey,
  getWidth,
  onMouseDown,
  children,
  className = "",
}: {
  colKey: string;
  getWidth: (col: string) => number;
  onMouseDown: (col: string, e: React.MouseEvent) => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      className={`relative px-3 py-1.5 text-left font-semibold whitespace-nowrap border-r border-border bg-bg-secondary ${className}`}
      style={{ width: getWidth(colKey), minWidth: MIN_COL_WIDTH }}
    >
      {children}
      <div
        className="absolute right-0 top-0 bottom-0 w-[4px] cursor-col-resize hover:bg-accent/30 active:bg-accent/50 z-30"
        onMouseDown={(e) => onMouseDown(colKey, e)}
      />
    </th>
  );
}

/* ── Main component ────────────────────────────────────── */

export function DataTable({ connectionId, connectionType, db, schema, table, onCellSelect, viewMode, onViewModeChange }: DataTableProps) {
  const [internalMode, setInternalMode] = useState<ViewMode>(viewMode ?? "data");
  const mode = viewMode ?? internalMode;
  const changeMode = (next: ViewMode) => {
    setInternalMode(next);
    onViewModeChange?.(next);
    if (next === "structure") onCellSelect?.(null);
  };
  const [data, setData] = useState<TableRowsResult | null>(null);
  const [columns, setColumns] = useState<ColumnInfo[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [structLoading, setStructLoading] = useState(true);
  const [structureRevision, setStructureRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filters, setFilters] = useState<FilterRow[]>([]);
  const [appliedWhere, setAppliedWhere] = useState<string>("");
  const [filterRefreshRevision, setFilterRefreshRevision] = useState(0);
  const [sqlPreview, setSqlPreview] = useState(false);
  const [schemaDdlOpen, setSchemaDdlOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [sort, setSort] = useState<SortState | null>(() => {
    // Initialize from settings default
    const defaultOrder = getConfig().settings?.defaultOrderBy?.trim();
    if (!defaultOrder) return null;
    const parts = defaultOrder.split(/\s+/);
    const col = parts[0];
    const dir = (parts[1] || "DESC").toUpperCase();
    return { column: col, dir: dir === "ASC" ? "ASC" : "DESC" };
  });

  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const refreshKey = tableRefreshKey({ connectionId, db, schema, table });
  const tableRevision = useEditStore((s) => s.tableRevisions.get(refreshKey) ?? 0);

  const addLogEntryRef = useRef(useQueryLog.getState().addEntry);
  addLogEntryRef.current = useQueryLog.getState().addEntry;

  const pkColumns = useMemo(
    () => columns?.filter((c) => c.isPk).map((c) => c.name) ?? [],
    [columns],
  );
  const headerColumns = useMemo(
    () => (data?.columns?.length ? data.columns : null) ?? columns?.map((c) => c.name) ?? [],
    [data?.columns, columns],
  );
  const columnMeta = useMemo(
    () => columns?.map((c) => ({
      name: c.name,
      dataType: c.dataType,
      udtName: c.udtName,
      enumValues: c.enumValues,
      defaultValue: c.defaultValue,
    })) ?? [],
    [columns],
  );

  // Add row handler
  const handleAddRow = useCallback(() => {
    if (!columns || columns.length === 0) return;
    const colNames = columns.map((c) => c.name);
    const insertId = useEditStore.getState().addInsert(connectionId, connectionType, db, schema, table, colNames);
    // Select the new insert row to show in detail pane
    const realRows = data?.rows.length ?? 0;
    const existingInserts = useEditStore.getState().getTableInserts(connectionId, db, schema, table);
    const newRowIndex = realRows + existingInserts.length - 1;
    const newRow = colNames.map(() => null);
    const columnMeta = columns.map((c) => ({ name: c.name, dataType: c.dataType, udtName: c.udtName, enumValues: c.enumValues, defaultValue: c.defaultValue }));
    onCellSelect?.({
      rowIndex: newRowIndex,
      colIndex: 0,
      row: newRow,
      columns: colNames,
      tableContext: { connectionId, connectionType, db, schema, table, pkColumns, columnMeta },
      insertId,
    });
  }, [connectionId, connectionType, db, schema, table, columns, data?.rows, pkColumns, onCellSelect]);

  // Delete selected rows handler
  const handleDeleteRows = useCallback(() => {
    if (pkColumns.length === 0 || !data?.rows) return;
    for (const idx of selectedRows) {
      const row = data.rows[idx] as unknown[];
      if (!row) continue;
      const rk = buildRowKey(connectionId, connectionType, db, schema, table, headerColumns, row, pkColumns);
      // Toggle: if already deleted, undelete
      if (useEditStore.getState().isRowDeleted(rk)) {
        useEditStore.getState().removeDelete(rk);
      } else {
        useEditStore.getState().addDelete(rk, row, headerColumns);
      }
    }
  }, [connectionId, connectionType, db, schema, table, headerColumns, pkColumns, data?.rows, selectedRows]);

  // Cmd+= to add row, Delete/Backspace to delete selected rows
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "i") {
        e.preventDefault();
        handleAddRow();
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selectedRows.size > 0) {
        // Only trigger if not focused on an input/textarea
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return;
        e.preventDefault();
        handleDeleteRows();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleAddRow, handleDeleteRows, selectedRows.size]);

  // Cmd+F to toggle filters
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        setFiltersOpen((prev) => {
          if (!prev) {
            // Opening: add an initial filter if empty
            setFilters((f) => (f.length === 0 ? [createFilter()] : f));
          }
          return !prev;
        });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Reset offset and sort when table changes
  useEffect(() => {
    setOffset(0);
    setInternalMode("data");
    setFiltersOpen(false);
    setFilters([]);
    setAppliedWhere("");
    setSqlPreview(false);
    setSchemaDdlOpen(false);
    // Re-apply default sort from settings
    const defaultOrder = getConfig().settings?.defaultOrderBy?.trim();
    if (defaultOrder) {
      const parts = defaultOrder.split(/\s+/);
      setSort({ column: parts[0], dir: (parts[1] || "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC" });
    } else {
      setSort(null);
    }
  }, [connectionId, db, schema, table]);

  // Fetch structure (columns) on mount / table change
  const refreshStructure = useCallback(async () => {
    setStructLoading(true);
    try {
      const cols = await fetchColumns(connectionId, db, schema, table);
      setColumns(cols.sort((a, b) => a.position - b.position));
      setStructureRevision((revision) => revision + 1);
    } finally {
      setStructLoading(false);
    }
  }, [connectionId, db, schema, table]);

  useEffect(() => {
    let cancelled = false;
    setStructLoading(true);

    fetchColumns(connectionId, db, schema, table)
      .then((cols) => {
        if (!cancelled) setColumns(cols.sort((a, b) => a.position - b.position));
      })
      .catch(() => {
        if (!cancelled) setColumns(null);
      })
      .finally(() => {
        if (!cancelled) setStructLoading(false);
      });

    return () => { cancelled = true; };
  }, [connectionId, db, schema, table]);

  // Fetch data rows
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const orderBy = sort ? `${sort.column} ${sort.dir}` : undefined;
    const start = performance.now();
    fetchTableRows(connectionId, db, schema, table, PAGE_SIZE, offset, orderBy, appliedWhere || undefined)
      .then((result) => {
        if (!cancelled) {
          setData(result);
          addLogEntryRef.current({
            timestamp: new Date(),
            query: result.query || `SELECT * FROM ${table}`,
            db,
            schema,
            table,
            duration: Math.round(performance.now() - start),
            rowCount: result.rows.length,
          });
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          addLogEntryRef.current({
            timestamp: new Date(),
            query: `-- Failed: SELECT * FROM ${db}.${table}`,
            db,
            schema,
            table,
            duration: Math.round(performance.now() - start),
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [connectionId, db, schema, table, offset, sort, appliedWhere, tableRevision, filterRefreshRevision]);

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const totalEstimate = data?.totalEstimate ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalEstimate / PAGE_SIZE));
  const hasPrev = offset > 0;
  const hasNext = (data?.rows.length ?? 0) === PAGE_SIZE;

  const activeFilterCount = filters.filter((f) => f.enabled && (f.mode === "raw" ? f.rawSql.trim() : f.column)).length;

  const handleApplyFilters = useCallback(() => {
    const where = buildWhereClause(filters, connectionType, true);
    setAppliedWhere(where);
    setOffset(0);
  }, [filters, connectionType]);

  const handleClearFilters = useCallback(() => {
    setFilters([]);
    setAppliedWhere("");
    setOffset(0);
    setFiltersOpen(false);
    setFilterRefreshRevision((revision) => revision + 1);
  }, []);

  const previewWhere = buildWhereClause(filters, connectionType, true);
  const previewSql = buildPreviewSql({ connectionType, db, schema, table, where: previewWhere, sort });

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Content area */}
      <div className="flex-1 min-h-0">
        {mode === "data" ? (
          <DataView
            connectionId={connectionId}
            connectionType={connectionType}
            db={db}
            schema={schema}
            table={table}
            headerColumns={headerColumns}
            data={data}
            loading={loading}
            error={error}
            offset={offset}
            sort={sort}
            onSortChange={(s) => { setSort(s); setOffset(0); }}
            onCellSelect={onCellSelect}
            onSelectionChange={setSelectedRows}
            pkColumns={pkColumns}
            columnMeta={columnMeta}
          />
        ) : (
          <SchemaEditor
            key={`${connectionId}:${db}:${schema}:${table}:${structureRevision}`}
            connectionId={connectionId}
            connectionType={connectionType}
            db={db}
            schema={schema}
            table={table}
            columns={columns ?? []}
            loading={structLoading}
            onRefresh={refreshStructure}
            ddlOpen={schemaDdlOpen}
            onDdlClose={() => setSchemaDdlOpen(false)}
          />
        )}
      </div>

      {/* Filter panel — above footer */}
      {filtersOpen && mode === "data" && (
        <FilterPanel
          columns={headerColumns}
          filters={filters}
          onFiltersChange={setFilters}
          onApply={handleApplyFilters}
          onShowSql={() => {
            setCopied(false);
            setSqlPreview(true);
          }}
          onClear={handleClearFilters}
          canClear={filters.length > 0 || !!appliedWhere}
          onClose={() => setFiltersOpen(false)}
        />
      )}

      {/* Bottom bar */}
      <div className="flex items-center px-2 py-1 border-t border-border bg-bg-secondary shrink-0 text-[11px] text-text-secondary">
        {/* Left: view toggle + row actions */}
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => changeMode("data")}
            className={`flex items-center gap-1 px-2 py-0.5 rounded transition-colors cursor-pointer ${
              mode === "data"
                ? "bg-accent/15 text-accent"
                : "hover:bg-bg-hover text-text-muted"
            }`}
          >
            <Table2 size={11} />
            Data
          </button>
          <button
            onClick={() => changeMode("structure")}
            className={`flex items-center gap-1 px-2 py-0.5 rounded transition-colors cursor-pointer ${
              mode === "structure"
                ? "bg-accent/15 text-accent"
                : "hover:bg-bg-hover text-text-muted"
            }`}
          >
            <Columns2 size={11} />
            Structure
          </button>

          {/* Add / Delete row buttons */}
          {mode === "data" && (
            <>
              <div className="w-px h-4 bg-border mx-1" />
              <button
                onClick={handleAddRow}
                className="flex items-center gap-1 px-2 py-0.5 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
                title="Add row (⌘I)"
              >
                <Plus size={10} />
                Add Row
              </button>
              {pkColumns.length > 0 && selectedRows.size > 0 && (
                <button
                  onClick={handleDeleteRows}
                  className="flex items-center gap-1 px-2 py-0.5 rounded text-row-delete hover:bg-row-delete/15 transition-colors cursor-pointer"
                  title="Delete selected row(s) (Delete)"
                >
                  <Trash2 size={10} />
                  Delete{selectedRows.size > 1 ? ` (${selectedRows.size})` : ""}
                </button>
              )}
            </>
          )}
          {mode === "structure" && (
            <>
              <div className="w-px h-4 bg-border mx-1" />
              <button
                onClick={() => setSchemaDdlOpen(true)}
                className="flex items-center gap-1 px-2 py-0.5 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
                title="Show table DDL"
              >
                <Code2 size={10} />
                DDL
              </button>
            </>
          )}
        </div>

        {/* Center: pagination */}
        <div className="flex-1 flex items-center justify-center gap-1">
          {mode === "data" && (
            <>
              <span className="text-text-muted mr-2">
                {data?.rows.length ?? 0} row{(data?.rows.length ?? 0) !== 1 ? "s" : ""}
                {totalEstimate > 0 && ` of ~${totalEstimate.toLocaleString()}`}
              </span>
              <button
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                disabled={!hasPrev}
                className="p-0.5 rounded hover:bg-bg-hover disabled:opacity-30 disabled:cursor-default cursor-pointer transition-colors"
              >
                <ChevronLeft size={14} />
              </button>
              <span className="px-1">
                {loading
                  ? <Loader2 size={10} className="animate-spin inline" />
                  : `${page} / ${totalPages}`
                }
              </span>
              <button
                onClick={() => setOffset(offset + PAGE_SIZE)}
                disabled={!hasNext}
                className="p-0.5 rounded hover:bg-bg-hover disabled:opacity-30 disabled:cursor-default cursor-pointer transition-colors"
              >
                <ChevronRight size={14} />
              </button>
            </>
          )}
          {mode === "structure" && columns && (
            <span className="text-text-muted">
              {columns.length} column{columns.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>

        {/* Right: filter toggle */}
        <div className="flex items-center gap-1">
          {mode === "data" && (
            <>
              <button
                onClick={() => setFilterRefreshRevision((revision) => revision + 1)}
                disabled={loading}
                className="flex items-center gap-1 px-2 py-0.5 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-default"
                title="Reload current table"
              >
                <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
                Reload
              </button>
              <button
                onClick={() => {
                  setFiltersOpen((prev) => {
                    if (!prev) setFilters((f) => (f.length === 0 ? [createFilter()] : f));
                    return !prev;
                  });
                }}
                className={`flex items-center gap-1 px-2 py-0.5 rounded transition-colors cursor-pointer ${
                  filtersOpen
                    ? "bg-accent/15 text-accent"
                    : appliedWhere
                      ? "bg-warning/15 text-warning"
                      : "hover:bg-bg-hover text-text-muted"
                }`}
                title="Toggle filters (⌘F)"
              >
                <Filter size={11} />
                Filters
                {activeFilterCount > 0 && appliedWhere && (
                  <span className="text-[9px] bg-accent/20 text-accent px-1 rounded-full font-medium">{activeFilterCount}</span>
                )}
              </button>
            </>
          )}
        </div>
      </div>

      <SqlPreviewModal
        open={sqlPreview}
        sql={previewSql}
        copied={copied}
        onCopy={async () => {
          await navigator.clipboard.writeText(previewSql);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        onClose={() => setSqlPreview(false)}
      />
    </div>
  );
}

function SqlPreviewModal({
  open,
  sql,
  copied,
  onCopy,
  onClose,
}: {
  open: boolean;
  sql: string;
  copied: boolean;
  onCopy: () => void;
  onClose: () => void;
}) {
  const backdropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-[250] flex items-center justify-center bg-black/50 backdrop-blur-[1px]"
      onMouseDown={(e) => {
        if (e.target === backdropRef.current) onClose();
      }}
    >
      <div className="w-[min(720px,calc(100vw-48px))] rounded-xl border border-border bg-bg-primary shadow-2xl overflow-hidden no-select">
        <div className="flex items-center justify-between h-10 px-4 border-b border-border bg-bg-secondary">
          <div className="flex items-center gap-2">
            <Code2 size={13} className="text-accent" />
            <h2 className="text-xs font-semibold text-text-primary">Generated SQL</h2>
          </div>
          <button
            onClick={onClose}
            title="Close"
            className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
          >
            <X size={14} />
          </button>
        </div>
        <div className="p-4 selectable">
          <div className="min-h-24 max-h-[50vh] overflow-auto rounded-lg border border-border bg-bg-secondary p-4 text-[12px] font-mono leading-relaxed whitespace-pre-wrap break-words">
            <HighlightedSQL sql={sql} />
          </div>
        </div>
        <div className="flex items-center justify-between px-4 py-3 border-t border-border bg-bg-secondary">
          <span className="text-[10px] text-text-secondary">Enabled filters · first page preview</span>
          <button
            onClick={onCopy}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border bg-bg-primary text-text-primary hover:bg-bg-hover transition-colors cursor-pointer text-[11px]"
          >
            {copied ? <Check size={11} className="text-success" /> : <Copy size={11} />}
            {copied ? "Copied" : "Copy SQL"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Data View ─────────────────────────────────────────── */

function DataView({
  connectionId,
  connectionType,
  db,
  schema,
  table,
  headerColumns,
  data,
  loading,
  error,
  offset,
  sort,
  onSortChange,
  onCellSelect,
  onSelectionChange,
  pkColumns,
  columnMeta,
}: {
  connectionId: string;
  connectionType: "postgres" | "mysql" | "sqlite";
  db: string;
  schema: string;
  table: string;
  headerColumns: string[];
  data: TableRowsResult | null;
  loading: boolean;
  error: string | null;
  offset: number;
  sort: SortState | null;
  onSortChange: (s: SortState | null) => void;
  onCellSelect?: (selection: CellSelection | null) => void;
  onSelectionChange?: (selectedIndices: Set<number>) => void;
  pkColumns: string[];
  columnMeta: { name: string; dataType: string; udtName: string; enumValues?: string[]; defaultValue: string | null }[];
}) {
  const editChanges = useEditStore((s) => s.changes);
  const editDeletes = useEditStore((s) => s.deletes);
  const editInserts = useEditStore((s) => s.inserts);
  const selectedCellRef = useRef<CellSelection | null>(null);

  // Get pending inserts for this table
  const tableInserts = useMemo(() =>
    editInserts.filter(
      (i) => i.connectionId === connectionId && i.db === db && i.schema === schema && i.table === table,
    ),
    [editInserts, connectionId, db, schema, table],
  );

  // Build combined rows: real data rows + virtual insert rows appended at bottom
  const realRowCount = data?.rows.length ?? 0;
  const combinedRows = useMemo(() => {
    const real = data?.rows ?? [];
    const insertRows = tableInserts.map((ins) =>
      headerColumns.map((col) => ins.values[col] ?? null),
    );
    return [...real, ...insertRows];
  }, [data?.rows, tableInserts, headerColumns]);

  // Build dirty-checking functions that use row PKs
  const isCellDirty = useCallback((rowIndex: number, colIndex: number) => {
    if (rowIndex >= realRowCount) return false; // insert rows don't have dirty cells
    if (pkColumns.length === 0 || !data?.rows[rowIndex]) return false;
    const row = data.rows[rowIndex] as unknown[];
    const rk = buildRowKey(connectionId, connectionType, db, schema, table, headerColumns, row, pkColumns);
    return useEditStore.getState().isCellDirty(rk, headerColumns[colIndex]);
  }, [connectionId, connectionType, db, schema, table, headerColumns, pkColumns, data?.rows, realRowCount, editChanges]);

  const isRowDirty = useCallback((rowIndex: number) => {
    if (rowIndex >= realRowCount) return false;
    if (pkColumns.length === 0 || !data?.rows[rowIndex]) return false;
    const row = data.rows[rowIndex] as unknown[];
    const rk = buildRowKey(connectionId, connectionType, db, schema, table, headerColumns, row, pkColumns);
    return useEditStore.getState().isRowDirty(rk);
  }, [connectionId, connectionType, db, schema, table, headerColumns, pkColumns, data?.rows, realRowCount, editChanges]);

  const isRowDeleted = useCallback((rowIndex: number) => {
    if (rowIndex >= realRowCount) return false;
    if (pkColumns.length === 0 || !data?.rows[rowIndex]) return false;
    const row = data.rows[rowIndex] as unknown[];
    const rk = buildRowKey(connectionId, connectionType, db, schema, table, headerColumns, row, pkColumns);
    return useEditStore.getState().isRowDeleted(rk);
  }, [connectionId, connectionType, db, schema, table, headerColumns, pkColumns, data?.rows, realRowCount, editDeletes]);

  const isRowInserted = useCallback((rowIndex: number) => {
    return rowIndex >= realRowCount;
  }, [realRowCount]);

  // Duplicate rows handler
  const handleDuplicateRows = useCallback((rowIndices: number[]) => {
    for (const idx of rowIndices) {
      const row = combinedRows[idx] as unknown[];
      if (!row) continue;
      const id = useEditStore.getState().addInsert(connectionId, connectionType, db, schema, table, headerColumns);
      // Primary keys must be generated or entered again for a duplicate row.
      for (let ci = 0; ci < headerColumns.length; ci++) {
        if (pkColumns.includes(headerColumns[ci])) continue;
        const val = row[ci];
        if (val !== null && val !== undefined) {
          useEditStore.getState().updateInsertValue(id, headerColumns[ci], val);
        }
      }
    }
  }, [connectionId, connectionType, db, schema, table, headerColumns, pkColumns, combinedRows]);

  // Wrap onCellSelect to inject table context (also handle insert rows)
  const handleCellSelect = useCallback((sel: CellSelection | null) => {
    if (sel) {
      // For insert rows, still pass table context but with empty pkColumns (no PKs yet)
      const enrichedSelection: CellSelection = {
        ...sel,
        tableContext: { connectionId, connectionType, db, schema, table, pkColumns, columnMeta },
        ...(sel.rowIndex >= realRowCount ? { insertId: tableInserts[sel.rowIndex - realRowCount]?.id } : {}),
      };
      selectedCellRef.current = enrichedSelection;
      onCellSelect?.(enrichedSelection);
    } else {
      selectedCellRef.current = null;
      onCellSelect?.(sel);
    }
  }, [connectionId, connectionType, db, schema, table, pkColumns, columnMeta, onCellSelect, realRowCount, tableInserts]);

  // A selection contains a row snapshot. After a table refetch, resolve that
  // record again by primary key so the detail panel receives current values.
  useEffect(() => {
    const selection = selectedCellRef.current;
    const freshRows = data?.rows;
    if (!selection || !freshRows || selection.insertId) return;

    let rowIndex = selection.rowIndex;
    if (pkColumns.length > 0) {
      const pkIndexes = pkColumns.map((pk) => headerColumns.indexOf(pk));
      const selectedPkValues = pkIndexes.map((index) => selection.row[index]);
      rowIndex = freshRows.findIndex((row) =>
        pkIndexes.every((columnIndex, index) =>
          columnIndex >= 0 && Object.is(row[columnIndex], selectedPkValues[index]),
        ),
      );
    }

    if (rowIndex < 0 || rowIndex >= freshRows.length) {
      selectedCellRef.current = null;
      onCellSelect?.(null);
      return;
    }

    const refreshedSelection: CellSelection = {
      ...selection,
      rowIndex,
      row: freshRows[rowIndex],
      columns: headerColumns,
      tableContext: { connectionId, connectionType, db, schema, table, pkColumns, columnMeta },
    };
    selectedCellRef.current = refreshedSelection;
    onCellSelect?.(refreshedSelection);
  }, [data?.rows, headerColumns, pkColumns, connectionId, connectionType, db, schema, table, columnMeta, onCellSelect]);

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted text-sm gap-2">
        <Loader2 size={14} className="animate-spin" />
        Loading data...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-error text-sm px-4">
        {error}
      </div>
    );
  }

  return (
    <ResultGrid
      columns={headerColumns}
      rows={combinedRows}
      offset={offset}
      emptyMessage="No rows in this table."
      sort={sort}
      onSortChange={onSortChange}
      onCellSelect={handleCellSelect}
      tableName={table}
      isCellDirty={pkColumns.length > 0 ? isCellDirty : undefined}
      isRowDirty={pkColumns.length > 0 ? isRowDirty : undefined}
      isRowDeleted={pkColumns.length > 0 ? isRowDeleted : undefined}
      isRowInserted={isRowInserted}
      onSelectionChange={onSelectionChange}
      onDuplicateRows={handleDuplicateRows}
    />
  );
}

/* ── Structure View ────────────────────────────────────── */

export function StructureView({
  columns,
  loading,
}: {
  columns: ColumnInfo[] | null;
  loading: boolean;
}) {
  const autoSizeData = useMemo(() => {
    if (!columns || columns.length === 0) return undefined;
    const rows: unknown[][] = columns.map((c) => [
      c.name,
      c.udtName || c.dataType,
      c.nullable ? "YES" : "NO",
      c.defaultValue ?? "NULL",
      c.isPk ? "PK" : c.isFk ? "FK" : "",
    ]);
    return { columns: STRUCT_COL_KEYS, rows };
  }, [columns]);

  const { getWidth, onMouseDown, totalWidth, tableRef } = useResizableColumns(STRUCT_COL_KEYS, autoSizeData);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted text-sm gap-2">
        <Loader2 size={14} className="animate-spin" />
        Loading structure...
      </div>
    );
  }

  if (!columns || columns.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted text-sm">
        No column information available.
      </div>
    );
  }

  const tableW = totalWidth(STRUCT_COL_KEYS, STRUCT_ROW_NUM_WIDTH);

  return (
    <table
      ref={tableRef}
      className="text-[12px] font-mono border-collapse"
      style={{ tableLayout: "fixed", width: tableW }}
    >
      <colgroup>
        <col style={{ width: STRUCT_ROW_NUM_WIDTH }} />
        {STRUCT_COL_KEYS.map((k) => (
          <col key={k} style={{ width: getWidth(k) }} />
        ))}
      </colgroup>
      <thead className="sticky top-0 z-10">
        <tr className="bg-bg-secondary border-b border-border">
          <th className="px-2 py-1.5 text-left text-text-muted font-semibold whitespace-nowrap border-r border-border bg-bg-secondary">
            #
          </th>
          <ResizableTh colKey="Column" getWidth={getWidth} onMouseDown={onMouseDown} className="text-text-secondary">
            Column
          </ResizableTh>
          <ResizableTh colKey="Type" getWidth={getWidth} onMouseDown={onMouseDown} className="text-text-secondary">
            Type
          </ResizableTh>
          <ResizableTh colKey="Null" getWidth={getWidth} onMouseDown={onMouseDown} className="text-text-secondary text-center">
            Null
          </ResizableTh>
          <ResizableTh colKey="Default" getWidth={getWidth} onMouseDown={onMouseDown} className="text-text-secondary">
            Default
          </ResizableTh>
          <ResizableTh colKey="Key" getWidth={getWidth} onMouseDown={onMouseDown} className="text-text-secondary text-center">
            Key
          </ResizableTh>
        </tr>
      </thead>
      <tbody>
        {columns.map((col, i) => (
          <tr
            key={col.name}
            className="border-b border-border hover:bg-bg-hover transition-colors"
          >
            <td className="px-2 py-1.5 text-text-muted font-mono tabular-nums border-r border-border">
              {i + 1}
            </td>
            <td className="px-3 py-1.5 font-medium text-text-primary border-r border-border whitespace-nowrap overflow-hidden text-ellipsis">
              {col.name}
            </td>
            <td className="px-3 py-1.5 font-mono text-text-secondary border-r border-border whitespace-nowrap overflow-hidden text-ellipsis">
              {col.udtName || col.dataType}
            </td>
            <td className="px-3 py-1.5 text-center border-r border-border">
              {col.nullable ? (
                <span className="text-text-muted">YES</span>
              ) : (
                <span className="text-warning font-medium">NO</span>
              )}
            </td>
            <td className="px-3 py-1.5 font-mono text-text-muted border-r border-border whitespace-nowrap overflow-hidden text-ellipsis">
              {col.defaultValue ?? <span className="italic">NULL</span>}
            </td>
            <td className="px-3 py-1.5 text-center border-r border-border">
              {col.isPk && (
                <span className="inline-flex items-center gap-0.5 text-[9px] font-semibold text-warning px-1.5 py-0.5 rounded bg-warning/10">
                  <KeyRound size={8} />PK
                </span>
              )}
              {col.isFk && (
                <span className="inline-flex items-center gap-0.5 text-[9px] font-semibold text-accent px-1.5 py-0.5 rounded bg-accent/10">
                  <Link2 size={8} />FK
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
