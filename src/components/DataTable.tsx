import { useEffect, useState } from "react";
import { Loader2, ChevronLeft, ChevronRight } from "lucide-react";
import { fetchTableRows, type TableRowsResult } from "../lib/schema";

interface DataTableProps {
  connectionId: string;
  db: string;
  schema: string;
  table: string;
}

const PAGE_SIZE = 100;

export function DataTable({ connectionId, db, schema, table }: DataTableProps) {
  const [data, setData] = useState<TableRowsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    setOffset(0);
  }, [connectionId, db, schema, table]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchTableRows(connectionId, db, schema, table, PAGE_SIZE, offset)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [connectionId, db, schema, table, offset]);

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

  if (!data || data.columns.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted text-sm">
        No data.
      </div>
    );
  }

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const totalPages = Math.max(1, Math.ceil(data.totalEstimate / PAGE_SIZE));
  const hasPrev = offset > 0;
  const hasNext = data.rows.length === PAGE_SIZE;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Table grid */}
      <div className="flex-1 overflow-auto min-h-0">
        <table className="w-full text-[12px] border-collapse">
          <thead className="sticky top-0 z-10">
            <tr className="bg-bg-secondary border-b border-border">
              {/* Row number header */}
              <th className="px-2 py-1.5 text-left text-text-muted font-semibold whitespace-nowrap border-r border-border bg-bg-secondary sticky left-0 z-20 w-[50px]">
                #
              </th>
              {data.columns.map((col) => (
                <th
                  key={col}
                  className="px-3 py-1.5 text-left text-text-secondary font-semibold whitespace-nowrap border-r border-border bg-bg-secondary"
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row, i) => (
              <tr
                key={i}
                className="border-b border-border hover:bg-bg-hover transition-colors"
              >
                {/* Row number */}
                <td className="px-2 py-1 text-text-muted font-mono tabular-nums border-r border-border bg-bg-secondary sticky left-0 z-[5]">
                  {offset + i + 1}
                </td>
                {row.map((cell, j) => (
                  <td
                    key={j}
                    className="px-3 py-1 whitespace-nowrap border-r border-border max-w-[300px] truncate"
                  >
                    <CellValue value={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination bar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-t border-border bg-bg-secondary shrink-0 text-[11px] text-text-secondary">
        <span>
          {data.rows.length} row{data.rows.length !== 1 ? "s" : ""}
          {data.totalEstimate > 0 && ` of ~${data.totalEstimate.toLocaleString()}`}
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            disabled={!hasPrev}
            className="p-0.5 rounded hover:bg-bg-hover disabled:opacity-30 disabled:cursor-default cursor-pointer transition-colors"
          >
            <ChevronLeft size={14} />
          </button>
          <span className="px-1.5">
            {loading ? <Loader2 size={10} className="animate-spin inline" /> : `${page} / ${totalPages}`}
          </span>
          <button
            onClick={() => setOffset(offset + PAGE_SIZE)}
            disabled={!hasNext}
            className="p-0.5 rounded hover:bg-bg-hover disabled:opacity-30 disabled:cursor-default cursor-pointer transition-colors"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

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
