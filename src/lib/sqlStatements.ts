export interface SqlStatement {
  text: string;
  start: number;
  end: number;
}

interface SqlToken {
  value: string;
  start: number;
  end: number;
  depth: number;
}

export interface SqlVariable {
  name: string;
  raw: boolean;
  start: number;
  end: number;
}

export interface SqlErrorMarker {
  start: number;
  end: number;
  message: string;
}

/** Only Oracle changes how statements are lexed and split. */
export type StatementDialect = "postgres" | "mysql" | "sqlite" | "oracle";

interface ScanResult {
  semicolons: number[];
  tokens: SqlToken[];
  variables: SqlVariable[];
  /** Oracle: offsets of SQL*Plus `/` terminator lines. */
  slashLines: number[];
}

/** Closing delimiter of an Oracle q-quote (`q'[...]'`, `q'!...!'`). */
function qQuoteClose(open: string): string {
  return ({ "[": "]", "(": ")", "{": "}", "<": ">" } as Record<string, string>)[open] ?? open;
}

function isAloneOnLine(sql: string, index: number): boolean {
  const lineStart = sql.lastIndexOf("\n", index - 1) + 1;
  const lineEnd = sql.indexOf("\n", index + 1);
  return !sql.slice(lineStart, index).trim() && !sql.slice(index + 1, lineEnd < 0 ? sql.length : lineEnd).trim();
}

function scanSql(sql: string, dialect?: StatementDialect): ScanResult {
  const oracle = dialect === "oracle";
  const semicolons: number[] = [];
  const tokens: SqlToken[] = [];
  const variables: SqlVariable[] = [];
  const slashLines: number[] = [];
  let depth = 0;
  let i = 0;

  while (i < sql.length) {
    const char = sql[i];
    const next = sql[i + 1];

    if (oracle && char === "/" && next !== "*" && isAloneOnLine(sql, i)) {
      slashLines.push(i);
      i += 1;
      continue;
    }
    if (oracle && /[qQ]/.test(char) && next === "'" && sql[i + 2] && !/[A-Za-z0-9_$]/.test(sql[i - 1] ?? "")) {
      const close = `${qQuoteClose(sql[i + 2])}'`;
      const end = sql.indexOf(close, i + 3);
      i = end < 0 ? sql.length : end + close.length;
      continue;
    }

    if (char === "-" && next === "-") {
      i += 2;
      while (i < sql.length && sql[i] !== "\n") i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      i += 2;
      let commentDepth = 1;
      while (i < sql.length && commentDepth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") { commentDepth += 1; i += 2; }
        else if (sql[i] === "*" && sql[i + 1] === "/") { commentDepth -= 1; i += 2; }
        else i += 1;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      const quote = char;
      i += 1;
      while (i < sql.length) {
        // Oracle strings have no backslash escapes.
        if (sql[i] === "\\" && quote !== '"' && !oracle) { i += 2; continue; }
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { i += 2; continue; }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (char === "[") {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "]" && sql[i + 1] === "]") { i += 2; continue; }
        if (sql[i] === "]") { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (char === "$") {
      const match = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (match) {
        const delimiter = match[0];
        const close = sql.indexOf(delimiter, i + delimiter.length);
        i = close < 0 ? sql.length : close + delimiter.length;
        continue;
      }
    }
    if (char === "{" && next === "{") {
      const close = sql.indexOf("}}", i + 2);
      if (close >= 0) {
        const body = sql.slice(i + 2, close).trim();
        const raw = body.endsWith(":raw");
        const name = (raw ? body.slice(0, -4) : body).trim();
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          variables.push({ name, raw, start: i, end: close + 2 });
        }
        i = close + 2;
        continue;
      }
    }
    if (char === "(") { depth += 1; i += 1; continue; }
    if (char === ")") { depth = Math.max(0, depth - 1); i += 1; continue; }
    if (char === ";") { semicolons.push(i); i += 1; continue; }
    if (/[A-Za-z_]/.test(char)) {
      const start = i;
      i += 1;
      while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i])) i += 1;
      tokens.push({ value: sql.slice(start, i).toUpperCase(), start, end: i, depth });
      continue;
    }
    i += 1;
  }

  return { semicolons, tokens, variables, slashLines };
}

function trimmedRange(sql: string, start: number, end: number): [number, number] {
  while (start < end && /\s/.test(sql[start])) start += 1;
  while (end > start && /\s/.test(sql[end - 1])) end -= 1;
  return [start, end];
}

/** Whether the statement starting at `tokens[0]` is a PL/SQL unit. */
function plsqlUnit(tokens: SqlToken[]): "block" | "unit" | null {
  const words = tokens.slice(0, 6).map((token) => token.value);
  if (words[0] === "BEGIN" || words[0] === "DECLARE") return "block";
  if (words[0] !== "CREATE") return null;
  let index = 1;
  if (words[index] === "OR" && words[index + 1] === "REPLACE") index += 2;
  if (["EDITIONABLE", "NONEDITIONABLE", "EDITIONING"].includes(words[index])) index += 1;
  if (["PROCEDURE", "FUNCTION", "TRIGGER"].includes(words[index])) return "block";
  // Package specs and bodies, types: no reliable BEGIN/END pairing.
  if (["PACKAGE", "TYPE", "LIBRARY", "JAVA"].includes(words[index])) return "unit";
  return null;
}

/**
 * Oracle: `/` lines end any statement; semicolons end SQL statements. A
 * PL/SQL block ends at `/`, or, failing that, at the semicolon after the END
 * that closes its outermost BEGIN. Package/type units need the `/`.
 */
function oracleBoundaries(sql: string, scan: ScanResult): number[] {
  const boundaries: number[] = [];
  const cuts = [
    ...scan.semicolons.map((position) => ({ position, kind: "semicolon" as const })),
    ...scan.slashLines.map((position) => ({ position, kind: "slash" as const })),
  ].sort((a, b) => a.position - b.position);
  let start = 0;
  let tokenIndex = 0;
  while (start < sql.length) {
    while (tokenIndex < scan.tokens.length && scan.tokens[tokenIndex].start < start) tokenIndex += 1;
    const unit = plsqlUnit(scan.tokens.slice(tokenIndex));
    const nextSlash = cuts.find((cut) => cut.kind === "slash" && cut.position >= start);
    let end: number | undefined;
    if (unit === "block") {
      let blockDepth = 0;
      let opened = false;
      let closedAt = -1;
      for (let index = tokenIndex; index < scan.tokens.length; index += 1) {
        const token = scan.tokens[index];
        if (nextSlash && token.start > nextSlash.position) break;
        // Declarations before the first BEGIN may hold CASE ... END; only
        // count inside the body. END IF / END LOOP close what isn't counted.
        if (token.value === "BEGIN") { blockDepth += 1; opened = true; }
        else if (token.value === "CASE" && blockDepth > 0) blockDepth += 1;
        else if (token.value === "END" && blockDepth > 0 && !["IF", "LOOP"].includes(scan.tokens[index + 1]?.value ?? "")) {
          blockDepth -= 1;
          if (opened && blockDepth === 0) { closedAt = token.end; break; }
        }
      }
      const semicolon = closedAt >= 0 ? scan.semicolons.find((position) => position >= closedAt) : undefined;
      end = semicolon !== undefined && (!nextSlash || semicolon < nextSlash.position) ? semicolon + 1 : nextSlash?.position;
    } else if (unit === "unit") {
      end = nextSlash?.position;
    } else {
      const cut = cuts.find((candidate) => candidate.position >= start);
      end = cut ? (cut.kind === "semicolon" ? cut.position + 1 : cut.position) : undefined;
    }
    if (end === undefined) break;
    boundaries.push(end);
    // Step past a `/` line so it is not part of the next statement.
    start = scan.slashLines.includes(end) ? end + 1 : end;
  }
  boundaries.push(sql.length);
  return boundaries;
}

export function splitSqlStatements(sql: string, dialect?: StatementDialect): SqlStatement[] {
  const scan = scanSql(sql, dialect);
  const boundaries = dialect === "oracle"
    ? oracleBoundaries(sql, scan)
    : [...scan.semicolons.map((position) => position + 1), sql.length];
  const statements: SqlStatement[] = [];
  let start = 0;
  for (const boundary of boundaries) {
    // A `/` terminator line belongs to neither neighbouring statement.
    const from = scan.slashLines.includes(start) ? start + 1 : start;
    const [trimStart, trimEnd] = trimmedRange(sql, from, boundary);
    const hasToken = scan.tokens.some((token) => token.start >= trimStart && token.start < trimEnd);
    if (trimStart < trimEnd && hasToken) {
      statements.push({ text: sql.slice(trimStart, trimEnd), start: trimStart, end: trimEnd });
    }
    start = boundary;
  }
  return statements;
}

export function statementAtCursor(sql: string, cursor: number, dialect?: StatementDialect): SqlStatement | null {
  const statements = splitSqlStatements(sql, dialect);
  if (statements.length === 0) return null;
  const clamped = Math.max(0, Math.min(cursor, sql.length));
  const containing = statements.find((statement) => clamped >= statement.start && clamped <= statement.end);
  if (containing) return containing;
  const following = statements.find((statement) => statement.start > clamped);
  if (following && !sql.slice(clamped, following.start).includes(";")) return following;
  return [...statements].reverse().find((statement) => statement.end <= clamped) ?? statements[0];
}

function statementTokens(sql: string): SqlToken[] {
  return scanSql(sql).tokens.filter((token) => token.depth === 0);
}

export function statementReturnsRows(sql: string): boolean {
  const tokens = statementTokens(sql);
  const first = tokens[0]?.value;
  if (!first) return false;
  if (["SELECT", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "PRAGMA", "VALUES", "TABLE"].includes(first)) return true;
  if (["INSERT", "UPDATE", "DELETE", "MERGE"].includes(first)) {
    return tokens.some((token) => token.value === "RETURNING");
  }
  if (first === "WITH") {
    const main = tokens.find((token, index) => index > 0 && ["SELECT", "INSERT", "UPDATE", "DELETE", "MERGE", "VALUES"].includes(token.value));
    return main?.value === "SELECT" || main?.value === "VALUES" || tokens.some((token) => token.value === "RETURNING");
  }
  return false;
}

export function applyRowLimit(sql: string, limit: number, dialect?: StatementDialect): string {
  const tokens = statementTokens(sql);
  const first = tokens[0]?.value;
  const withMain = first === "WITH"
    ? tokens.find((token, index) => index > 0 && ["SELECT", "INSERT", "UPDATE", "DELETE", "MERGE", "VALUES"].includes(token.value))?.value
    : undefined;
  const supportsLimit = first === "SELECT" || (first === "WITH" && (withMain === "SELECT" || withMain === "VALUES"));
  if (limit <= 0 || !supportsLimit) return sql;
  if (tokens.some((token) => token.value === "LIMIT" || token.value === "FETCH")) return sql;
  const withoutTerminator = sql.replace(/;\s*$/, "");
  // Oracle 12c+ row limiting; ROWNUM filters are left to the user's query.
  if (dialect === "oracle") {
    if (tokens.some((token) => token.value === "ROWNUM" || (token.value === "FOR" && tokens.some((t) => t.value === "UPDATE")))) return sql;
    return `${withoutTerminator} FETCH FIRST ${limit} ROWS ONLY`;
  }
  return `${withoutTerminator} LIMIT ${limit}`;
}

export function findSqlVariables(sql: string): SqlVariable[] {
  const seen = new Set<string>();
  return scanSql(sql).variables.filter((variable) => {
    const key = `${variable.name}:${variable.raw}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sqlLiteral(value: string): string {
  const trimmed = value.trim();
  if (/^null$/i.test(trimmed)) return "NULL";
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toUpperCase();
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed)) return trimmed;
  return `'${value.replace(/'/g, "''")}'`;
}

export function substituteSqlVariables(sql: string, values: Record<string, string>): string {
  const variables = scanSql(sql).variables.sort((a, b) => b.start - a.start);
  let result = sql;
  for (const variable of variables) {
    if (!(variable.name in values)) throw new Error(`Missing value for ${variable.name}`);
    const value = variable.raw ? values[variable.name] : sqlLiteral(values[variable.name]);
    result = result.slice(0, variable.start) + value + result.slice(variable.end);
  }
  return result;
}

export function sqlErrorMarker(message: string, statement: SqlStatement): SqlErrorMarker {
  const positionMatch = /(?:position|character)\s*[: ]\s*(\d+)/i.exec(message);
  if (positionMatch) {
    const offset = Math.max(0, Number(positionMatch[1]) - 1);
    const start = Math.min(statement.end, statement.start + offset);
    return { start, end: Math.min(statement.end, start + 1), message };
  }
  const lineMatch = /line\s+(\d+)(?:\D+column\s+(\d+))?/i.exec(message);
  if (lineMatch) {
    const line = Math.max(1, Number(lineMatch[1]));
    const column = Math.max(1, Number(lineMatch[2] ?? 1));
    const lines = statement.text.split("\n");
    let offset = 0;
    for (let index = 1; index < line && index <= lines.length; index += 1) offset += lines[index - 1].length + 1;
    offset += column - 1;
    const start = Math.min(statement.end, statement.start + offset);
    return { start, end: Math.min(statement.end, start + 1), message };
  }
  return { start: statement.start, end: Math.min(statement.end, statement.start + Math.max(1, statement.text.split(/\s/)[0]?.length ?? 1)), message };
}
