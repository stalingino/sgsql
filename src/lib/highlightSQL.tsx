import type { ReactNode } from "react";

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

interface HighlightedSQLProps {
  sql: string;
  activeRange?: [number, number] | null;
}

function colorizeToken(token: string, i: number): ReactNode {
  if (
    (token.startsWith("'") && token.endsWith("'")) ||
    (token.startsWith('"') && token.endsWith('"'))
  ) {
    return <span key={i} className="text-syntax-string">{token}</span>;
  }
  if (token.startsWith("`") && token.endsWith("`")) {
    return <span key={i} className="text-syntax-identifier">{token}</span>;
  }
  if (SQL_KEYWORDS.has(token.toUpperCase())) {
    return <span key={i} className="text-syntax-keyword font-semibold">{token}</span>;
  }
  if (/^\d+(\.\d+)?$/.test(token)) {
    return <span key={i} className="text-syntax-number">{token}</span>;
  }
  if (token === "*") {
    return <span key={i} className="text-syntax-number font-bold">{token}</span>;
  }
  if (token.startsWith("--")) {
    return <span key={i} className="text-text-muted italic">{token}</span>;
  }
  return <span key={i}>{token}</span>;
}

export function HighlightedSQL({ sql, activeRange }: HighlightedSQLProps) {
  const tokens = sql.split(/(\s+|,|\(|\)|;|'[^']*'|"[^"]*"|`[^`]*`|\*)/g);

  // If no activeRange, just colorize everything
  if (!activeRange) {
    return (
      <span className="text-text-primary">
        {tokens.map((token, i) => (token ? colorizeToken(token, i) : null))}
      </span>
    );
  }

  let charPos = 0;
  const result: ReactNode[] = [];
  let activeGroup: ReactNode[] = [];
  let inActiveRegion = false;
  let groupKey = 0;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;

    const tokenStart = charPos;
    const tokenEnd = charPos + token.length;
    charPos = tokenEnd;

    const isActive =
      tokenEnd > activeRange[0] &&
      tokenStart < activeRange[1];

    const span = colorizeToken(token, i);

    if (isActive) {
      if (!inActiveRegion) {
        inActiveRegion = true;
        activeGroup = [];
      }
      activeGroup.push(span);
    } else {
      if (inActiveRegion) {
        result.push(
          <mark
            key={`active-${groupKey++}`}
            className="bg-accent/8 rounded py-[3px] -my-[3px] px-[2px] -mx-[2px]"
            style={{
              color: "inherit",
              boxDecorationBreak: "clone",
              WebkitBoxDecorationBreak: "clone",
            } as React.CSSProperties}
          >
            {activeGroup}
          </mark>
        );
        inActiveRegion = false;
      }
      result.push(span);
    }
  }

  // Flush remaining active group
  if (inActiveRegion && activeGroup.length > 0) {
    result.push(
      <mark
        key={`active-${groupKey}`}
        className="bg-accent/8 rounded py-[3px] -my-[3px] px-[2px] -mx-[2px]"
        style={{
          color: "inherit",
          boxDecorationBreak: "clone",
          WebkitBoxDecorationBreak: "clone",
        } as React.CSSProperties}
      >
        {activeGroup}
      </mark>
    );
  }

  return (
    <span className="text-text-primary">
      {result}
    </span>
  );
}
