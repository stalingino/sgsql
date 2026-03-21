import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ArrowDown, Copy, ClipboardCopy, ChevronRight } from "lucide-react";

/* ── Constants ─────────────────────────────────────────── */

const MIN_COL_WIDTH = 40;
const DEFAULT_COL_WIDTH = 150;
const AUTO_MAX_WIDTH = 350;
const CHAR_WIDTH = 7.5;
const CELL_PAD = 28;
const SAMPLE_ROWS = 20;

/* ── Sort types ────────────────────────────────────────── */

export type SortDir = "ASC" | "DESC" | null;
export interface SortState {
  column: string;
  dir: SortDir;
}

/* ── Selection types ───────────────────────────────────── */

export interface CellSelection {
  rowIndex: number;
  colIndex: number;
  row: unknown[];
  columns: string[];
}

/* ── Copy format helpers ───────────────────────────────── */

function cellToText(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function rowsToPlainText(_cols: string[], rows: unknown[][]): string {
  return rows.map((r) => (r as unknown[]).map(cellToText).join("\t")).join("\n");
}

function rowsToJSON(cols: string[], rows: unknown[][]): string {
  const arr = rows.map((r) => {
    const obj: Record<string, unknown> = {};
    cols.forEach((c, i) => { obj[c] = (r as unknown[])[i]; });
    return obj;
  });
  return JSON.stringify(arr, null, 2);
}

function rowsToHTML(cols: string[], rows: unknown[][]): string {
  let html = "<table>\n<thead><tr>";
  cols.forEach((c) => { html += `<th>${esc(c)}</th>`; });
  html += "</tr></thead>\n<tbody>\n";
  rows.forEach((r) => {
    html += "<tr>";
    (r as unknown[]).forEach((cell) => { html += `<td>${esc(cellToText(cell))}</td>`; });
    html += "</tr>\n";
  });
  html += "</tbody>\n</table>";
  return html;
}
function esc(s: string) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

function rowsToMarkdown(cols: string[], rows: unknown[][]): string {
  const header = "| " + cols.join(" | ") + " |";
  const sep = "| " + cols.map(() => "---").join(" | ") + " |";
  const body = rows.map((r) => "| " + (r as unknown[]).map(cellToText).join(" | ") + " |").join("\n");
  return [header, sep, body].join("\n");
}

function rowsToCSV(cols: string[], rows: unknown[][], withHeader: boolean): string {
  const csvRow = (r: unknown[]) => r.map((v) => {
    const s = cellToText(v);
    return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(",");
  const lines: string[] = [];
  if (withHeader) lines.push(csvRow(cols));
  rows.forEach((r) => lines.push(csvRow(r as unknown[])));
  return lines.join("\n");
}

function rowsToInsert(cols: string[], rows: unknown[][], tableName = "table_name"): string {
  const colList = cols.map((c) => `\`${c}\``).join(", ");
  const valRows = rows.map((r) => {
    const vals = (r as unknown[]).map((v) => {
      if (v === null || v === undefined) return "NULL";
      if (typeof v === "number" || typeof v === "boolean") return String(v);
      return `'${String(v).replace(/'/g, "''")}'`;
    });
    return `(${vals.join(", ")})`;
  });
  return `INSERT INTO \`${tableName}\` (${colList})\nVALUES\n  ${valRows.join(",\n  ")};`;
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
        if (dragRef.current) manualRef.current.add(dragRef.current.col);
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

/* ── Context menu ──────────────────────────────────────── */

interface CtxMenuState {
  x: number;
  y: number;
  rowIdx: number;
  colIdx: number;
}

function ContextMenu({
  state,
  columns,
  displayRows,
  selectedRows,
  onClose,
}: {
  state: CtxMenuState;
  columns: string[];
  displayRows: unknown[][];
  selectedRows: Set<number>;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [subOpen, setSubOpen] = useState(false);

  // Close on outside click or Escape
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  const selRows = useMemo(() => {
    const indices = Array.from(selectedRows).sort((a, b) => a - b);
    return indices.map((i) => displayRows[i] as unknown[]);
  }, [selectedRows, displayRows]);

  const cellValue = (displayRows[state.rowIdx] as unknown[])?.[state.colIdx];
  const rowCount = selectedRows.size;

  const copyText = (text: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
    onClose();
  };

  const copyAsItems: { label: string; fn: () => void }[] = [
    { label: "Plain Text", fn: () => copyText(rowsToPlainText(columns, selRows)) },
    { label: "JSON", fn: () => copyText(rowsToJSON(columns, selRows)) },
    { label: "HTML", fn: () => copyText(rowsToHTML(columns, selRows)) },
    { label: "Markdown Table", fn: () => copyText(rowsToMarkdown(columns, selRows)) },
    { label: "CSV", fn: () => copyText(rowsToCSV(columns, selRows, false)) },
    { label: "CSV with Header", fn: () => copyText(rowsToCSV(columns, selRows, true)) },
    { label: "INSERT Statement", fn: () => copyText(rowsToInsert(columns, selRows)) },
  ];

  return (
    <div
      ref={menuRef}
      data-ctx-menu
      className="fixed z-[200] min-w-[200px] rounded-lg border border-border bg-bg-primary shadow-xl py-1 text-[12px] text-text-primary"
      style={{ left: state.x, top: state.y }}
    >
      {/* Copy Row */}
      <button
        className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-bg-hover transition-colors cursor-pointer text-left"
        onClick={() => copyText(rowsToPlainText(columns, selRows))}
      >
        <Copy size={12} className="text-text-muted shrink-0" />
        Copy Row{rowCount > 1 ? `s (${rowCount})` : ""}
      </button>

      {/* Copy Cell Value */}
      <button
        className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-bg-hover transition-colors cursor-pointer text-left"
        onClick={() => copyText(cellToText(cellValue))}
      >
        <ClipboardCopy size={12} className="text-text-muted shrink-0" />
        Copy Cell Value
      </button>

      {/* Separator */}
      <div className="my-1 border-t border-border" />

      {/* Copy Rows As → submenu */}
      <div
        className="relative"
        onMouseEnter={() => setSubOpen(true)}
        onMouseLeave={() => setSubOpen(false)}
      >
        <button className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-bg-hover transition-colors cursor-pointer text-left">
          <Copy size={12} className="text-text-muted shrink-0" />
          <span className="flex-1">Copy Rows As</span>
          <ChevronRight size={12} className="text-text-muted shrink-0" />
        </button>

        {subOpen && (
          <div className="absolute left-full top-0 ml-0.5 min-w-[180px] rounded-lg border border-border bg-bg-primary shadow-xl py-1 z-[210]">
            {copyAsItems.map((item) => (
              <button
                key={item.label}
                className="w-full flex items-center px-3 py-1.5 hover:bg-bg-hover transition-colors cursor-pointer text-left"
                onClick={item.fn}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Helper: range between two indices ─────────────────── */

function rangeSet(a: number, b: number): Set<number> {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const s = new Set<number>();
  for (let i = lo; i <= hi; i++) s.add(i);
  return s;
}

/* ── ResultGrid ────────────────────────────────────────── */

interface ResultGridProps {
  columns: string[];
  rows: unknown[][];
  offset?: number;
  emptyMessage?: string;
  sort?: SortState | null;
  onSortChange?: (sort: SortState | null) => void;
  clientSort?: boolean;
  onCellSelect?: (selection: CellSelection | null) => void;
}

export function ResultGrid({
  columns,
  rows,
  offset: _offset = 0,
  emptyMessage = "No rows.",
  sort: externalSort,
  onSortChange,
  clientSort = false,
  onCellSelect,
}: ResultGridProps) {
  const [internalSort, setInternalSort] = useState<SortState | null>(null);
  // Multi-selection state
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [activeRow, setActiveRow] = useState<number | null>(null); // current/last clicked
  const [activeCol, setActiveCol] = useState<number | null>(null);
  const [anchorRow, setAnchorRow] = useState<number | null>(null); // for shift-range
  const [focused, setFocused] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ anchor: number; active: boolean } | null>(null);

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
      if (clientSort) setInternalSort(next);
      else onSortChange?.(next);
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

  // ── Selection logic ──────────────────────────────────
  const selectSingle = useCallback(
    (rowIdx: number, colIdx: number) => {
      setSelectedRows(new Set([rowIdx]));
      setActiveRow(rowIdx);
      setActiveCol(colIdx);
      setAnchorRow(rowIdx);
      onCellSelect?.({
        rowIndex: rowIdx,
        colIndex: colIdx,
        row: displayRows[rowIdx] as unknown[],
        columns,
      });
    },
    [displayRows, columns, onCellSelect],
  );

  // ── Drag-to-select ────────────────────────────────────
  const handleRowMouseDown = useCallback(
    (rowIdx: number, _colIdx: number, e: React.MouseEvent) => {
      // Only plain left-click starts drag (not shift/cmd/right-click)
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
      dragRef.current = { anchor: rowIdx, active: false };
    },
    [],
  );

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      // Find which row the mouse is over using data-row-idx
      const target = document.elementFromPoint(e.clientX, e.clientY);
      const tr = target?.closest("tr[data-row-idx]");
      if (!tr) return;
      const rowIdx = Number(tr.getAttribute("data-row-idx"));
      if (isNaN(rowIdx)) return;

      dragRef.current.active = true;
      const range = rangeSet(dragRef.current.anchor, rowIdx);
      setSelectedRows(range);
      setActiveRow(rowIdx);
    };

    const onMouseUp = () => {
      dragRef.current = null;
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  const handleRowClick = useCallback(
    (rowIdx: number, colIdx: number, e: React.MouseEvent) => {
      // If we just finished a drag, don't re-process as click
      if (dragRef.current?.active) return;

      if (e.metaKey || e.ctrlKey) {
        // Toggle row in selection
        setSelectedRows((prev) => {
          const next = new Set(prev);
          if (next.has(rowIdx)) next.delete(rowIdx);
          else next.add(rowIdx);
          return next;
        });
        setActiveRow(rowIdx);
        setActiveCol(colIdx);
        setAnchorRow(rowIdx);
        onCellSelect?.({
          rowIndex: rowIdx,
          colIndex: colIdx,
          row: displayRows[rowIdx] as unknown[],
          columns,
        });
      } else if (e.shiftKey && anchorRow !== null) {
        // Range select from anchor
        const range = rangeSet(anchorRow, rowIdx);
        setSelectedRows(range);
        setActiveRow(rowIdx);
        setActiveCol(colIdx);
        // Notify detail panel with the clicked row
        onCellSelect?.({
          rowIndex: rowIdx,
          colIndex: colIdx,
          row: displayRows[rowIdx] as unknown[],
          columns,
        });
      } else {
        selectSingle(rowIdx, colIdx);
      }
    },
    [anchorRow, displayRows, columns, onCellSelect, selectSingle],
  );

  // Clear selection when data changes
  useEffect(() => {
    setSelectedRows(new Set());
    setActiveRow(null);
    setActiveCol(null);
    setAnchorRow(null);
    onCellSelect?.(null);
  }, [rows]);

  // Keyboard: Cmd/Ctrl+C copies selected rows; Shift+arrows for range; arrows for navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Copy
      if ((e.metaKey || e.ctrlKey) && e.key === "c" && selectedRows.size > 0) {
        const indices = Array.from(selectedRows).sort((a, b) => a - b);
        const selRowData = indices.map((i) => displayRows[i] as unknown[]);
        const text = rowsToPlainText(columns, selRowData);
        navigator.clipboard.writeText(text).catch(() => {});
        e.preventDefault();
        return;
      }

      // Select all: Cmd/Ctrl+A
      if ((e.metaKey || e.ctrlKey) && e.key === "a") {
        e.preventDefault();
        const all = new Set<number>();
        for (let i = 0; i < displayRows.length; i++) all.add(i);
        setSelectedRows(all);
        return;
      }

      // Arrow navigation
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && activeRow !== null) {
        e.preventDefault();
        const dir = e.key === "ArrowDown" ? 1 : -1;
        const next = Math.max(0, Math.min(displayRows.length - 1, activeRow + dir));
        if (next === activeRow) return;

        if (e.shiftKey) {
          // Extend selection range
          const range = rangeSet(anchorRow ?? activeRow, next);
          setSelectedRows(range);
          setActiveRow(next);
          onCellSelect?.({
            rowIndex: next,
            colIndex: activeCol ?? 0,
            row: displayRows[next] as unknown[],
            columns,
          });
        } else {
          selectSingle(next, activeCol ?? 0);
        }
      }
    };
    const el = containerRef.current;
    if (el) {
      el.addEventListener("keydown", handler);
      return () => el.removeEventListener("keydown", handler);
    }
  }, [selectedRows, activeRow, activeCol, anchorRow, displayRows, columns, onCellSelect, selectSingle]);

  // Context menu handler
  const handleContextMenu = useCallback(
    (e: React.MouseEvent, rowIdx: number, colIdx: number) => {
      e.preventDefault();
      // If right-clicked row isn't in selection, select it
      if (!selectedRows.has(rowIdx)) {
        selectSingle(rowIdx, colIdx);
      } else {
        setActiveCol(colIdx);
      }
      setCtxMenu({ x: e.clientX, y: e.clientY, rowIdx, colIdx });
    },
    [selectedRows, selectSingle],
  );

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

  const tableW = totalWidth(columns);

  return (
    <div
      ref={containerRef}
      className="h-full overflow-auto outline-none"
      tabIndex={0}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (menuRef(e)) return;
        setFocused(false);
      }}
    >
      <table
        ref={tableRef}
        className="text-[12px] font-mono border-collapse select-none"
        style={{ tableLayout: "fixed", width: tableW }}
      >
        <colgroup>
          {columns.map((col) => (
            <col key={col} style={{ width: getWidth(col) }} />
          ))}
        </colgroup>
        <thead className="sticky top-0 z-10">
          <tr className="bg-bg-secondary border-b border-border">
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
                colSpan={columns.length}
                className="px-4 py-8 text-center text-text-muted text-xs"
              >
                {emptyMessage}
              </td>
            </tr>
          ) : (
            displayRows.map((row, i) => {
              const isSelected = selectedRows.has(i);
              const isActive = activeRow === i;
              return (
                <tr
                  key={i}
                  data-row-idx={i}
                  className={`transition-colors ${
                    isSelected
                      ? focused ? "bg-accent/8" : "bg-accent/4"
                      : i % 2 === 1 ? "bg-bg-secondary hover:bg-bg-hover" : "hover:bg-bg-hover"
                  }`}
                  onContextMenu={(e) => handleContextMenu(e, i, activeCol ?? 0)}
                >
                  {(row as unknown[]).map((cell, j) => {
                    const isCellActive = isActive && activeCol === j;
                    return (
                      <td
                        key={j}
                        className={`px-3 py-0.5 whitespace-nowrap border-r border-border overflow-hidden text-ellipsis cursor-pointer ${
                          isCellActive
                            ? focused
                              ? "outline outline-1 outline-accent outline-offset-[-1px]"
                              : "outline outline-1 outline-border outline-offset-[-1px]"
                            : ""
                        }`}
                        onMouseDown={(e) => handleRowMouseDown(i, j, e)}
                        onClick={(e) => handleRowClick(i, j, e)}
                        onContextMenu={(e) => handleContextMenu(e, i, j)}
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

      {/* Context menu */}
      {ctxMenu && (
        <ContextMenu
          state={ctxMenu}
          columns={columns}
          displayRows={displayRows}
          selectedRows={selectedRows}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}

/** Check if blur target is within the context menu (to prevent focus loss) */
function menuRef(e: React.FocusEvent): boolean {
  const related = e.relatedTarget as HTMLElement | null;
  return !!related?.closest("[data-ctx-menu]");
}
