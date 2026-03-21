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

interface DataTableProps {
  connectionId: string;
  db: string;
  schema: string;
  table: string;
}

const PAGE_SIZE = 100;
const MIN_COL_WIDTH = 40;
const DEFAULT_COL_WIDTH = 150;
const AUTO_MAX_WIDTH = 350;
const CHAR_WIDTH = 7.5;      // ~px per char at 12px font
const CELL_PAD = 28;         // px-3 each side (24) + border (4)
const SAMPLE_ROWS = 20;      // only scan first N rows for auto-sizing
const ROW_NUM_WIDTH = 50;

type ViewMode = "data" | "structure";

/* ── Auto-size: estimate column widths from data ───────── */

function estimateColWidths(
  columns: string[],
  rows?: unknown[][],
): Record<string, number> {
  const widths: Record<string, number> = {};
  for (let ci = 0; ci < columns.length; ci++) {
    const col = columns[ci];
    // Start with header width
    let maxLen = col.length;
    // Sample first N data rows
    if (rows) {
      const end = Math.min(rows.length, SAMPLE_ROWS);
      for (let ri = 0; ri < end; ri++) {
        const cell = rows[ri]?.[ci];
        const len = cell === null || cell === undefined
          ? 4 // "NULL"
          : typeof cell === "object"
            ? Math.min(JSON.stringify(cell).length, 40)
            : String(cell).length;
        if (len > maxLen) maxLen = len;
      }
    }
    widths[col] = Math.max(MIN_COL_WIDTH, Math.min(AUTO_MAX_WIDTH, Math.round(maxLen * CHAR_WIDTH + CELL_PAD)));
  }
  return widths;
}

/* ── Resizable column hook ─────────────────────────────── */

function useResizableColumns(
  columnKeys: string[],
  autoSizeData?: { columns: string[]; rows?: unknown[][] },
) {
  // Committed widths — only updated on mouseup (triggers one React render)
  const [widths, setWidths] = useState<Record<string, number>>({});
  // Live ref for DOM-only updates during drag (no React renders)
  const widthsRef = useRef<Record<string, number>>({});
  const tableRef = useRef<HTMLTableElement | null>(null);
  const dragRef = useRef<{ col: string; startX: number; startW: number } | null>(null);
  // Track which columns have been manually resized (don't overwrite with auto)
  const manualRef = useRef<Set<string>>(new Set());

  // Sync ref with state
  widthsRef.current = widths;

  // Auto-size: compute initial widths when columns or data change
  useEffect(() => {
    if (!autoSizeData) {
      // No auto-size data — just initialize missing columns with defaults
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
        // Don't overwrite manually-resized columns
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

  const onMouseDown = useCallback((col: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widthsRef.current[col] ?? DEFAULT_COL_WIDTH;
    dragRef.current = { col, startX, startW };

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = ev.clientX - dragRef.current.startX;
      const newW = Math.max(MIN_COL_WIDTH, dragRef.current.startW + delta);

      // Update ref (no React render)
      widthsRef.current = { ...widthsRef.current, [dragRef.current.col]: newW };

      // Direct DOM update — find the col element and resize it + update table width
      if (tableRef.current) {
        const colgroup = tableRef.current.querySelector("colgroup");
        if (colgroup) {
          const cols = colgroup.querySelectorAll("col");
          const colIndex = columnKeys.indexOf(dragRef.current.col);
          if (colIndex !== -1 && cols[colIndex + 1]) {
            // +1 because first col is the row-number column
            (cols[colIndex + 1] as HTMLElement).style.width = `${newW}px`;
          }
        }
        // Recalculate total width
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
      // Commit to React state (single render)
      setWidths({ ...widthsRef.current });
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [columnKeys]);

  const getWidth = useCallback((col: string) => widths[col] ?? DEFAULT_COL_WIDTH, [widths]);

  const totalWidth = useCallback(
    (keys: string[], extra = 0) =>
      keys.reduce((sum, k) => sum + (widths[k] ?? DEFAULT_COL_WIDTH), extra),
    [widths],
  );

  return { getWidth, onMouseDown, totalWidth, tableRef };
}

/* ── Resizable header cell ─────────────────────────────── */

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

export function DataTable({ connectionId, db, schema, table }: DataTableProps) {
  const [mode, setMode] = useState<ViewMode>("data");
  const [data, setData] = useState<TableRowsResult | null>(null);
  const [columns, setColumns] = useState<ColumnInfo[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [structLoading, setStructLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);

  const addLogEntryRef = useRef(useQueryLog.getState().addEntry);
  addLogEntryRef.current = useQueryLog.getState().addEntry;

  // Reset offset when table changes
  useEffect(() => {
    setOffset(0);
    setMode("data");
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

    const start = performance.now();
    fetchTableRows(connectionId, db, schema, table, PAGE_SIZE, offset)
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
  }, [connectionId, db, schema, table, offset]);

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
      <div className="flex-1 overflow-auto min-h-0">
        {mode === "data" ? (
          <DataView
            headerColumns={headerColumns}
            data={data}
            loading={loading}
            error={error}
            offset={offset}
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
  headerColumns,
  data,
  loading,
  error,
  offset,
}: {
  headerColumns: string[];
  data: TableRowsResult | null;
  loading: boolean;
  error: string | null;
  offset: number;
}) {
  // Auto-size: pass column names + row data for initial width estimation
  const autoSizeData = useMemo(
    () => headerColumns.length > 0
      ? { columns: headerColumns, rows: data?.rows }
      : undefined,
    [headerColumns, data?.rows],
  );

  const { getWidth, onMouseDown, totalWidth, tableRef } = useResizableColumns(headerColumns, autoSizeData);

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

  if (headerColumns.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted text-sm">
        No columns found.
      </div>
    );
  }

  const rows = data?.rows ?? [];
  const tableW = totalWidth(headerColumns, ROW_NUM_WIDTH);

  return (
    <table
      ref={tableRef}
      className="text-[12px] border-collapse"
      style={{ tableLayout: "fixed", width: tableW, minWidth: "100%" }}
    >
      <colgroup>
        <col style={{ width: ROW_NUM_WIDTH }} />
        {headerColumns.map((col) => (
          <col key={col} style={{ width: getWidth(col) }} />
        ))}
      </colgroup>
      <thead className="sticky top-0 z-10">
        <tr className="bg-bg-secondary border-b border-border">
          <th
            className="px-2 py-1.5 text-left text-text-muted font-semibold whitespace-nowrap border-r border-border bg-bg-secondary sticky left-0 z-20"
          >
            #
          </th>
          {headerColumns.map((col) => (
            <ResizableTh
              key={col}
              colKey={col}
              getWidth={getWidth}
              onMouseDown={onMouseDown}
              className="text-text-secondary"
            >
              {col}
            </ResizableTh>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td
              colSpan={headerColumns.length + 1}
              className="px-4 py-8 text-center text-text-muted text-xs"
            >
              No rows in this table.
            </td>
          </tr>
        ) : (
          rows.map((row, i) => (
            <tr
              key={i}
              className="border-b border-border hover:bg-bg-hover transition-colors"
            >
              <td className="px-2 py-1 text-text-muted font-mono tabular-nums border-r border-border bg-bg-secondary sticky left-0 z-[5]">
                {offset + i + 1}
              </td>
              {row.map((cell, j) => (
                <td
                  key={j}
                  className="px-3 py-1 whitespace-nowrap border-r border-border overflow-hidden text-ellipsis"
                >
                  <CellValue value={cell} />
                </td>
              ))}
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

/* ── Structure View ────────────────────────────────────── */

const STRUCT_COL_KEYS = ["Column", "Type", "Null", "Default", "Key"];
const STRUCT_ROW_NUM_WIDTH = 40;

function StructureView({
  columns,
  loading,
}: {
  columns: ColumnInfo[] | null;
  loading: boolean;
}) {
  // Build auto-size data from column metadata
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
      className="text-[12px] border-collapse"
      style={{ tableLayout: "fixed", width: tableW, minWidth: "100%" }}
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

/* ── Cell value renderer ───────────────────────────────── */

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
