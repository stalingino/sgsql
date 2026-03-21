import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ArrowDown } from "lucide-react";

/* ── Constants ─────────────────────────────────────────── */

const MIN_COL_WIDTH = 40;
const DEFAULT_COL_WIDTH = 150;
const AUTO_MAX_WIDTH = 350;
const CHAR_WIDTH = 7.5;
const CELL_PAD = 28;
const SAMPLE_ROWS = 20;
const ROW_NUM_WIDTH = 50;

/* ── Sort types ────────────────────────────────────────── */

export type SortDir = "ASC" | "DESC" | null;
export interface SortState {
  column: string;
  dir: SortDir;
}

/* ── Selection types ───────────────────────────────────── */

export interface CellSelection {
  rowIndex: number; // index within displayRows
  colIndex: number; // column index
  row: unknown[];   // full row data
  columns: string[];
}

/* ── Auto-size: estimate column widths from data ───────── */

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

/* ── Resizable column hook ─────────────────────────────── */

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

  const onResizeMouseDown = useCallback(
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

  return { getWidth, onResizeMouseDown, totalWidth, tableRef };
}

/* ── Resizable header cell ─────────────────────────────── */

function ResizableTh({
  colKey,
  getWidth,
  onResizeMouseDown,
  onClick,
  sortDir,
  children,
  className = "",
}: {
  colKey: string;
  getWidth: (col: string) => number;
  onResizeMouseDown: (col: string, e: React.MouseEvent) => void;
  onClick?: () => void;
  sortDir?: SortDir;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      className={`relative px-3 py-1.5 text-left font-semibold whitespace-nowrap border-r border-border bg-bg-secondary select-none ${onClick ? "cursor-pointer hover:bg-bg-hover" : ""} ${className}`}
      style={{ width: getWidth(colKey), minWidth: MIN_COL_WIDTH }}
      onClick={onClick}
    >
      <span className="flex items-center gap-1">
        <span className="truncate">{children}</span>
        {sortDir === "ASC" && <ArrowUp size={10} className="shrink-0 text-accent" />}
        {sortDir === "DESC" && <ArrowDown size={10} className="shrink-0 text-accent" />}
      </span>
      <div
        className="absolute right-0 top-0 bottom-0 w-[4px] cursor-col-resize hover:bg-accent/30 active:bg-accent/50 z-30"
        onMouseDown={(e) => {
          e.stopPropagation();
          onResizeMouseDown(colKey, e);
        }}
      />
    </th>
  );
}

/* ── Cell value renderer ───────────────────────────────── */

export function CellValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="text-text-muted italic">NULL</span>;
  }
  if (typeof value === "boolean") {
    return (
      <span className="text-accent font-medium">
        {value ? "true" : "false"}
      </span>
    );
  }
  if (typeof value === "number") {
    return <span className="text-accent tabular-nums">{value}</span>;
  }
  if (typeof value === "object") {
    return (
      <span className="text-text-muted font-mono">
        {JSON.stringify(value)}
      </span>
    );
  }
  return <span className="text-text-primary">{String(value)}</span>;
}

/** Format a cell value as plain text for clipboard */
function cellToClipboardText(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/* ── ResultGrid ────────────────────────────────────────── */

interface ResultGridProps {
  columns: string[];
  rows: unknown[][];
  offset?: number;
  emptyMessage?: string;
  /** Server-side sort — parent handles re-fetch on change */
  sort?: SortState | null;
  onSortChange?: (sort: SortState | null) => void;
  /** Client-side sort — grid sorts rows in-memory (for query results) */
  clientSort?: boolean;
  /** Called when a row/cell is selected */
  onCellSelect?: (selection: CellSelection | null) => void;
}

export function ResultGrid({
  columns,
  rows,
  offset = 0,
  emptyMessage = "No rows.",
  sort: externalSort,
  onSortChange,
  clientSort = false,
  onCellSelect,
}: ResultGridProps) {
  // Internal client-side sort state (only used when clientSort=true)
  const [internalSort, setInternalSort] = useState<SortState | null>(null);
  // Selected cell
  const [selectedRow, setSelectedRow] = useState<number | null>(null);
  const [selectedCol, setSelectedCol] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const activeSort = clientSort ? internalSort : (externalSort ?? null);

  const handleHeaderClick = useCallback(
    (col: string) => {
      const current = clientSort ? internalSort : (externalSort ?? null);
      let next: SortState | null;

      if (current?.column !== col) {
        next = { column: col, dir: "ASC" };
      } else if (current.dir === "ASC") {
        next = { column: col, dir: "DESC" };
      } else {
        next = null;
      }

      if (clientSort) {
        setInternalSort(next);
      } else {
        onSortChange?.(next);
      }
    },
    [clientSort, internalSort, externalSort, onSortChange],
  );

  // Client-side sorted rows
  const sortedRows = useMemo(() => {
    if (!clientSort || !internalSort?.column || !internalSort.dir) return rows;
    const colIdx = columns.indexOf(internalSort.column);
    if (colIdx === -1) return rows;

    const dir = internalSort.dir === "ASC" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = (a as unknown[])[colIdx];
      const vb = (b as unknown[])[colIdx];
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
  }, [clientSort, internalSort, rows, columns]);

  const displayRows = clientSort ? sortedRows : rows;

  // Handle cell click
  const handleCellClick = useCallback(
    (rowIdx: number, colIdx: number) => {
      setSelectedRow(rowIdx);
      setSelectedCol(colIdx);
      const row = displayRows[rowIdx] as unknown[];
      onCellSelect?.({
        rowIndex: rowIdx,
        colIndex: colIdx,
        row,
        columns,
      });
    },
    [displayRows, columns, onCellSelect],
  );

  // Clear selection when data changes
  useEffect(() => {
    setSelectedRow(null);
    setSelectedCol(null);
    onCellSelect?.(null);
  }, [rows]);

  // Keyboard: Cmd/Ctrl+C copies selected cell value
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "c" && selectedRow !== null && selectedCol !== null) {
        const row = displayRows[selectedRow] as unknown[] | undefined;
        if (row) {
          const value = row[selectedCol];
          const text = cellToClipboardText(value);
          navigator.clipboard.writeText(text).catch(() => {});
          e.preventDefault();
        }
      }
    };
    const el = containerRef.current;
    if (el) {
      el.addEventListener("keydown", handler);
      return () => el.removeEventListener("keydown", handler);
    }
  }, [selectedRow, selectedCol, displayRows]);

  const autoSizeData = useMemo(
    () =>
      columns.length > 0
        ? { columns, rows: rows.length > 0 ? rows : undefined }
        : undefined,
    [columns, rows],
  );

  const { getWidth, onResizeMouseDown, totalWidth, tableRef } = useResizableColumns(
    columns,
    autoSizeData,
  );

  if (columns.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted text-sm">
        No columns found.
      </div>
    );
  }

  const tableW = totalWidth(columns, ROW_NUM_WIDTH);

  return (
    <div
      ref={containerRef}
      className="h-full overflow-auto outline-none"
      tabIndex={0}
    >
      <table
        ref={tableRef}
        className="text-[12px] border-collapse select-none"
        style={{ tableLayout: "fixed", width: tableW }}
      >
        <colgroup>
          <col style={{ width: ROW_NUM_WIDTH }} />
          {columns.map((col) => (
            <col key={col} style={{ width: getWidth(col) }} />
          ))}
        </colgroup>
        <thead className="sticky top-0 z-10">
          <tr className="bg-bg-secondary border-b border-border">
            <th className="px-2 py-1.5 text-left text-text-muted font-semibold whitespace-nowrap border-r border-border bg-bg-secondary sticky left-0 z-20">
              #
            </th>
            {columns.map((col) => (
              <ResizableTh
                key={col}
                colKey={col}
                getWidth={getWidth}
                onResizeMouseDown={onResizeMouseDown}
                onClick={() => handleHeaderClick(col)}
                sortDir={activeSort?.column === col ? activeSort.dir : null}
                className="text-text-secondary"
              >
                {col}
              </ResizableTh>
            ))}
          </tr>
        </thead>
        <tbody>
          {displayRows.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length + 1}
                className="px-4 py-8 text-center text-text-muted text-xs"
              >
                {emptyMessage}
              </td>
            </tr>
          ) : (
            displayRows.map((row, i) => {
              const isRowSelected = selectedRow === i;
              return (
                <tr
                  key={i}
                  className={`border-b border-border transition-colors ${
                    isRowSelected
                      ? "bg-accent/8"
                      : "hover:bg-bg-hover"
                  }`}
                >
                  <td
                    className={`px-2 py-1 text-text-muted font-mono tabular-nums border-r border-border bg-bg-secondary sticky left-0 z-[5] cursor-pointer ${
                      isRowSelected ? "!bg-accent/15 text-accent font-semibold" : ""
                    }`}
                    onClick={() => handleCellClick(i, 0)}
                  >
                    {offset + i + 1}
                  </td>
                  {(row as unknown[]).map((cell, j) => {
                    const isCellSelected = isRowSelected && selectedCol === j;
                    return (
                      <td
                        key={j}
                        className={`px-3 py-1 whitespace-nowrap border-r border-border overflow-hidden text-ellipsis cursor-pointer ${
                          isCellSelected
                            ? "outline outline-2 outline-accent outline-offset-[-2px]"
                            : ""
                        }`}
                        onClick={() => handleCellClick(i, j)}
                      >
                        <CellValue value={cell} />
                      </td>
                    );
                  })}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
