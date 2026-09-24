import { splitSqlStatements } from "./sqlStatements";

export type SqlImportDialect = "postgres" | "mysql" | "sqlite";

function withoutLeadingComments(sql: string): string {
  let value = sql.trim();
  while (value) {
    if (value.startsWith("--") || value.startsWith("#")) {
      const newline = value.indexOf("\n");
      value = newline < 0 ? "" : value.slice(newline + 1).trimStart();
      continue;
    }
    if (value.startsWith("/*") && !value.startsWith("/*!")) {
      const end = value.indexOf("*/", 2);
      if (end < 0) return "";
      value = value.slice(end + 2).trimStart();
      continue;
    }
    break;
  }
  return value;
}

function hasExecutableSql(sql: string): boolean {
  return withoutLeadingComments(sql).trim().length > 0;
}

function isTransactionBoundary(sql: string): boolean {
  const normalized = withoutLeadingComments(sql).replace(/;\s*$/, "").trim();
  return /^(?:BEGIN(?:\s+(?:WORK|TRANSACTION))?|START\s+TRANSACTION|COMMIT(?:\s+WORK)?|END(?:\s+(?:WORK|TRANSACTION))?|ROLLBACK(?:\s+WORK)?)$/i.test(normalized);
}

/** Split a MySQL region on its active DELIMITER, ignoring delimiters in strings/comments. */
function splitOnDelimiter(sql: string, delimiter: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let index = 0;

  const push = (end: number) => {
    const statement = sql.slice(start, end).trim();
    if (hasExecutableSql(statement)) statements.push(statement);
  };

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];

    if (char === "-" && next === "-") {
      index += 2;
      while (index < sql.length && sql[index] !== "\n") index += 1;
      continue;
    }
    if (char === "#") {
      index += 1;
      while (index < sql.length && sql[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const close = sql.indexOf("*/", index + 2);
      index = close < 0 ? sql.length : close + 2;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      const quote = char;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === "\\") { index += 2; continue; }
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) { index += 2; continue; }
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (delimiter && sql.startsWith(delimiter, index)) {
      push(index);
      index += delimiter.length;
      start = index;
      continue;
    }
    index += 1;
  }

  push(sql.length);
  return statements;
}

/** Handles mysqldump's client-side DELIMITER directives for routines/triggers. */
function splitMysqlDump(sql: string): string[] {
  const statements: string[] = [];
  let delimiter = ";";
  let region = "";
  const lines = sql.match(/[^\n]*(?:\n|$)/g) ?? [];

  for (const line of lines) {
    const directive = /^\s*DELIMITER\s+(\S+)\s*(?:\r?\n)?$/i.exec(line);
    if (!directive) {
      region += line;
      continue;
    }
    statements.push(...splitOnDelimiter(region, delimiter));
    region = "";
    delimiter = directive[1];
  }
  statements.push(...splitOnDelimiter(region, delimiter));
  return statements;
}

/** Parse an SQL dump for the dedicated import connection/transaction path. */
export function prepareSqlImport(sql: string, dialect: SqlImportDialect): string[] {
  const parsed = dialect === "mysql"
    ? splitMysqlDump(sql)
    : splitSqlStatements(sql).map((statement) => statement.text.trim());
  const statements = parsed.filter((statement) => !isTransactionBoundary(statement));

  if (statements.length === 0) throw new Error("Enter SQL or choose a non-empty SQL dump");
  return statements;
}
