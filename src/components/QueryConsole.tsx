import { useEffect, useRef } from "react";
import { Trash2 } from "lucide-react";
import { useQueryLog, type QueryLogEntry } from "../lib/queryLog";

export function QueryConsole() {
  const entries = useQueryLog((s) => s.entries);
  const clear = useQueryLog((s) => s.clear);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new entries
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries.length]);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1 border-b border-border bg-bg-secondary shrink-0">
        <span className="text-[11px] font-semibold text-text-secondary uppercase tracking-wider">
          Query Log
        </span>
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-text-muted tabular-nums mr-1">
            {entries.length} {entries.length === 1 ? "query" : "queries"}
          </span>
          {entries.length > 0 && (
            <button
              onClick={clear}
              title="Clear log"
              className="p-0.5 rounded text-text-muted hover:text-error hover:bg-error/10 transition-colors cursor-pointer"
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Log entries */}
      <div className="flex-1 overflow-y-auto min-h-0 font-mono text-[11px] leading-relaxed">
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
    </div>
  );
}

function LogEntry({ entry }: { entry: QueryLogEntry }) {
  const time = entry.timestamp.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const hasError = !!entry.error;

  return (
    <div className={`px-3 py-1.5 border-b border-border/50 hover:bg-bg-hover/50 transition-colors ${
      hasError ? "bg-error/5" : ""
    }`}>
      {/* Comment line: metadata */}
      <div className="text-text-muted select-none">
        <span className="text-text-muted/70">-- </span>
        <span>{time}</span>
        <span className="text-text-muted/50"> | </span>
        <span>{entry.db}</span>
        {entry.schema && entry.schema !== "" && (
          <><span className="text-text-muted/50">.</span><span>{entry.schema}</span></>
        )}
        <span className="text-text-muted/50"> | </span>
        {hasError ? (
          <span className="text-error">{entry.duration}ms ERROR</span>
        ) : (
          <>
            <span className="text-success">{entry.duration}ms</span>
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

      {/* Error message */}
      {hasError && (
        <div className="mt-0.5 text-error">
          <span className="text-error/60">-- </span>
          {entry.error}
        </div>
      )}
    </div>
  );
}

/* ── Basic SQL syntax highlighter ──────────────────────── */

const SQL_KEYWORDS = new Set([
  "SELECT", "FROM", "WHERE", "AND", "OR", "NOT", "IN", "IS", "NULL",
  "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", "CREATE",
  "TABLE", "ALTER", "DROP", "INDEX", "JOIN", "LEFT", "RIGHT", "INNER",
  "OUTER", "ON", "AS", "ORDER", "BY", "GROUP", "HAVING", "LIMIT",
  "OFFSET", "DISTINCT", "UNION", "ALL", "EXISTS", "BETWEEN", "LIKE",
  "CASE", "WHEN", "THEN", "ELSE", "END", "COUNT", "SUM", "AVG",
  "MIN", "MAX", "ASC", "DESC", "CASCADE", "CONSTRAINT", "PRIMARY",
  "KEY", "FOREIGN", "REFERENCES", "DEFAULT", "CHECK", "UNIQUE",
  "VIEW", "TRIGGER", "PROCEDURE", "FUNCTION", "BEGIN", "COMMIT",
  "ROLLBACK", "GRANT", "REVOKE", "SHOW", "USE", "DESCRIBE",
  "EXPLAIN", "ANALYZE", "SCHEMA", "DATABASE", "IF", "REPLACE",
]);

function HighlightedSQL({ sql }: { sql: string }) {
  // Split into tokens preserving whitespace
  const tokens = sql.split(/(\s+|,|\(|\)|;|'[^']*'|"[^"]*"|`[^`]*`|\*)/g);

  return (
    <span className="text-text-primary">
      {tokens.map((token, i) => {
        if (!token) return null;

        // String literals
        if (
          (token.startsWith("'") && token.endsWith("'")) ||
          (token.startsWith('"') && token.endsWith('"'))
        ) {
          return <span key={i} className="text-green-400">{token}</span>;
        }

        // Backtick-quoted identifiers
        if (token.startsWith("`") && token.endsWith("`")) {
          return <span key={i} className="text-sky-400">{token}</span>;
        }

        // Keywords
        if (SQL_KEYWORDS.has(token.toUpperCase())) {
          return <span key={i} className="text-purple-400 font-semibold">{token}</span>;
        }

        // Numbers
        if (/^\d+$/.test(token)) {
          return <span key={i} className="text-accent">{token}</span>;
        }

        // Asterisk
        if (token === "*") {
          return <span key={i} className="text-accent font-bold">{token}</span>;
        }

        // Comments
        if (token.startsWith("--")) {
          return <span key={i} className="text-text-muted italic">{token}</span>;
        }

        return <span key={i}>{token}</span>;
      })}
    </span>
  );
}
