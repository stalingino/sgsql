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

export function HighlightedSQL({ sql }: { sql: string }) {
  const tokens = sql.split(/(\s+|,|\(|\)|;|'[^']*'|"[^"]*"|`[^`]*`|\*)/g);

  return (
    <span className="text-text-primary">
      {tokens.map((token, i) => {
        if (!token) return null;

        if (
          (token.startsWith("'") && token.endsWith("'")) ||
          (token.startsWith('"') && token.endsWith('"'))
        ) {
          return <span key={i} className="text-green-400">{token}</span>;
        }

        if (token.startsWith("`") && token.endsWith("`")) {
          return <span key={i} className="text-sky-400">{token}</span>;
        }

        if (SQL_KEYWORDS.has(token.toUpperCase())) {
          return <span key={i} className="text-purple-400 font-semibold">{token}</span>;
        }

        if (/^\d+(\.\d+)?$/.test(token)) {
          return <span key={i} className="text-accent">{token}</span>;
        }

        if (token === "*") {
          return <span key={i} className="text-accent font-bold">{token}</span>;
        }

        if (token.startsWith("--")) {
          return <span key={i} className="text-text-muted italic">{token}</span>;
        }

        return <span key={i}>{token}</span>;
      })}
    </span>
  );
}
