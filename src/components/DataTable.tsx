import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2,
  ChevronLeft,
  ChevronRight,
  Table2,
  Columns2,
  KeyRound,
  Link2,
} from "lucide-react";
import {
  fetchTableRows,
  fetchColumns,
  type TableRowsResult,
  type ColumnInfo,
} from "../lib/schema";
import { useQueryLog } from "../lib/queryLog";
import { useEditStore, buildRowKey } from "../lib/editStore";
import { ResultGrid, type SortState, type CellSelection } from "./ResultGrid";
import { getConfig } from "../lib/config";

interface DataTableProps {
  connectionId: string;
  db: string;
  schema: string;
  table: string;
  onCellSelect?: (selection: CellSelection | null) => void;
}

const PAGE_SIZE = 50;

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

export function DataTable({ connectionId, db, schema, table, onCellSelect }: DataTableProps) {
  const [mode, setMode] = useState<ViewMode>("data");
  const [data, setData] = useState<TableRowsResult | null>(null);
  const [columns, setColumns] = useState<ColumnInfo[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [structLoading, setStructLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState<SortState | null>(() => {
    // Initialize from settings default
    const defaultOrder = getConfig().settings?.defaultOrderBy?.trim();
    if (!defaultOrder) return null;
    const parts = defaultOrder.split(/\s+/);
    const col = parts[0];
    const dir = (parts[1] || "DESC").toUpperCase();
    return { column: col, dir: dir === "ASC" ? "ASC" : "DESC" };
  });

  const addLogEntryRef = useRef(useQueryLog.getState().addEntry);
  addLogEntryRef.current = useQueryLog.getState().addEntry;

  // Reset offset and sort when table changes
  useEffect(() => {
    setOffset(0);
    setMode("data");
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
    fetchTableRows(connectionId, db, schema, table, PAGE_SIZE, offset, orderBy)
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
  }, [connectionId, db, schema, table, offset, sort]);

  // Use columns from structure for the header when data has no rows
  const headerColumns = (data?.columns?.length ? data.columns : null) ?? columns?.map((c) => c.name) ?? [];

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const totalEstimate = data?.totalEstimate ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalEstimate / PAGE_SIZE));
  const hasPrev = offset > 0;
  const hasNext = (data?.rows.length ?? 0) === PAGE_SIZE;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Content area */}
      <div className="flex-1 min-h-0">
        {mode === "data" ? (
          <DataView
            connectionId={connectionId}
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
            pkColumns={columns?.filter((c) => c.isPk).map((c) => c.name) ?? []}
            columnMeta={columns?.map((c) => ({ name: c.name, dataType: c.dataType, udtName: c.udtName, defaultValue: c.defaultValue })) ?? []}
          />
        ) : (
          <StructureView
            columns={columns}
            loading={structLoading}
          />
        )}
      </div>

      {/* Bottom bar */}
      <div className="flex items-center px-2 py-1 border-t border-border bg-bg-secondary shrink-0 text-[11px] text-text-secondary">
        {/* Left: view mode toggle */}
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => setMode("data")}
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
            onClick={() => setMode("structure")}
            className={`flex items-center gap-1 px-2 py-0.5 rounded transition-colors cursor-pointer ${
              mode === "structure"
                ? "bg-accent/15 text-accent"
                : "hover:bg-bg-hover text-text-muted"
            }`}
          >
            <Columns2 size={11} />
            Structure
          </button>
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

        {/* Right: spacer to balance layout */}
        <div className="w-[120px]" />
      </div>
    </div>
  );
}

/* ── Data View ─────────────────────────────────────────── */

function DataView({
  connectionId,
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
  pkColumns,
  columnMeta,
}: {
  connectionId: string;
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
  pkColumns: string[];
  columnMeta: { name: string; dataType: string; udtName: string; defaultValue: string | null }[];
}) {
  const editChanges = useEditStore((s) => s.changes);

  // Build dirty-checking functions that use row PKs
  const isCellDirty = useCallback((rowIndex: number, colIndex: number) => {
    if (pkColumns.length === 0 || !data?.rows[rowIndex]) return false;
    const row = data.rows[rowIndex] as unknown[];
    const rk = buildRowKey(connectionId, db, schema, table, headerColumns, row, pkColumns);
    return useEditStore.getState().isCellDirty(rk, headerColumns[colIndex]);
  }, [connectionId, db, schema, table, headerColumns, pkColumns, data?.rows, editChanges]);

  const isRowDirty = useCallback((rowIndex: number) => {
    if (pkColumns.length === 0 || !data?.rows[rowIndex]) return false;
    const row = data.rows[rowIndex] as unknown[];
    const rk = buildRowKey(connectionId, db, schema, table, headerColumns, row, pkColumns);
    return useEditStore.getState().isRowDirty(rk);
  }, [connectionId, db, schema, table, headerColumns, pkColumns, data?.rows, editChanges]);

  // Wrap onCellSelect to inject table context
  const handleCellSelect = useCallback((sel: CellSelection | null) => {
    if (sel && pkColumns.length > 0) {
      onCellSelect?.({
        ...sel,
        tableContext: { connectionId, db, schema, table, pkColumns, columnMeta },
      });
    } else {
      onCellSelect?.(sel);
    }
  }, [connectionId, db, schema, table, pkColumns, columnMeta, onCellSelect]);

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
      rows={data?.rows ?? []}
      offset={offset}
      emptyMessage="No rows in this table."
      sort={sort}
      onSortChange={onSortChange}
      onCellSelect={handleCellSelect}
      tableName={table}
      isCellDirty={pkColumns.length > 0 ? isCellDirty : undefined}
      isRowDirty={pkColumns.length > 0 ? isRowDirty : undefined}
    />
  );
}

/* ── Structure View ────────────────────────────────────── */

function StructureView({
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
