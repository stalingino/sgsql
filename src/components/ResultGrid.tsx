import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* ── Constants ─────────────────────────────────────────── */

const MIN_COL_WIDTH = 40;
const DEFAULT_COL_WIDTH = 150;
const AUTO_MAX_WIDTH = 350;
const CHAR_WIDTH = 7.5;
const CELL_PAD = 28;
const SAMPLE_ROWS = 20;
const ROW_NUM_WIDTH = 50;

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

/* ── ResultGrid ────────────────────────────────────────── */

interface ResultGridProps {
  columns: string[];
  rows: unknown[][];
  offset?: number;
  emptyMessage?: string;
}

export function ResultGrid({
  columns,
  rows,
  offset = 0,
  emptyMessage = "No rows.",
}: ResultGridProps) {
  const autoSizeData = useMemo(
    () =>
      columns.length > 0
        ? { columns, rows: rows.length > 0 ? rows : undefined }
        : undefined,
    [columns, rows],
  );

  const { getWidth, onMouseDown, totalWidth, tableRef } = useResizableColumns(
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
    <table
      ref={tableRef}
      className="text-[12px] border-collapse"
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
              colSpan={columns.length + 1}
              className="px-4 py-8 text-center text-text-muted text-xs"
            >
              {emptyMessage}
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
              {(row as unknown[]).map((cell, j) => (
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
