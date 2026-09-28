import { useEffect, useRef } from "react";
import { Trash2 } from "lucide-react";
import { useQueryLog, type QueryLogEntry } from "../lib/queryLog";
import { HighlightedSQL } from "../lib/highlightSQL";
import { formatLocalDateTime } from "../lib/formatDateTime";

export function QueryLogActions() {
  const count = useQueryLog((s) => s.entries.length);
  const clear = useQueryLog((s) => s.clear);

  return (
    <div className="flex items-center gap-1">
      <span className="text-[10px] text-text-secondary tabular-nums mr-1">
        {count} {count === 1 ? "query" : "queries"}
      </span>
      {count > 0 && (
        <button
          onClick={clear}
          title="Clear log"
          className="p-0.5 rounded text-text-secondary hover:text-error hover:bg-error/10 transition-colors cursor-pointer"
        >
          <Trash2 size={12} />
        </button>
      )}
    </div>
  );
}

export function QueryConsole() {
  const entries = useQueryLog((s) => s.entries);
  const bottomRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);

  // Auto-scroll to bottom on new entries. Jump straight there on mount
  // (e.g. switching back to this tab) instead of animating from the top.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: mounted.current ? "smooth" : "auto" });
    mounted.current = true;
  }, [entries.length]);

  return (
    <div className="h-full overflow-y-auto min-h-0 font-mono text-[11px] leading-relaxed selectable">
      {entries.length === 0 && (
        <div className="flex items-center justify-center h-full text-text-muted text-[11px]">
          Queries will appear here...
        </div>
      )}
      {entries.map((entry) => (
        <LogEntry key={entry.id} entry={entry} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

function LogEntry({ entry }: { entry: QueryLogEntry }) {
  const time = formatLocalDateTime(entry.timestamp);

  const hasError = !!entry.error;
  const isCancelled = !!entry.cancelled;

  return (
    <div className={`px-3 py-1.5 border-b border-border/50 hover:bg-bg-hover/50 transition-colors ${
      isCancelled ? "bg-warning/5" : hasError ? "bg-error/5" : ""
    }`}>
      {/* Comment line: metadata */}
      <div className="text-text-muted">
        <span className="text-text-muted/70">-- </span>
        <span>{time}</span>
        <span className="text-text-muted/50"> | </span>
        <span>{entry.db}</span>
        {entry.schema && entry.schema !== "" && (
          <><span className="text-text-muted/50">.</span><span>{entry.schema}</span></>
        )}
        <span className="text-text-muted/50"> | </span>
        {isCancelled ? (
          <span className="text-warning">KILLED</span>
        ) : hasError ? (
          <span className="text-error">{Math.round(entry.duration * 100) / 100}ms ERROR</span>
        ) : (
          <>
            <span className="text-success">{Math.round(entry.duration * 100) / 100}ms</span>
            {entry.rowCount !== undefined && (
              <span className="text-text-muted/50"> | {entry.rowCount} rows</span>
            )}
          </>
        )}
      </div>

      {/* SQL query with basic syntax highlighting */}
      <div className="mt-0.5">
        <HighlightedSQL sql={entry.query} />
      </div>

      {/* Cancelled / Error message */}
      {isCancelled && (
        <div className="mt-0.5 text-warning">
          <span className="text-warning/60">-- </span>
          {entry.cancelDetail || "Killed"}
        </div>
      )}
      {hasError && !isCancelled && (
        <div className="mt-0.5 text-error">
          <span className="text-error/60">-- </span>
          {entry.error}
        </div>
      )}
    </div>
  );
}
