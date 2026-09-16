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

interface ScanResult {
  semicolons: number[];
  tokens: SqlToken[];
  variables: SqlVariable[];
}

function scanSql(sql: string): ScanResult {
  const semicolons: number[] = [];
  const tokens: SqlToken[] = [];
  const variables: SqlVariable[] = [];
  let depth = 0;
  let i = 0;

  while (i < sql.length) {
    const char = sql[i];
    const next = sql[i + 1];

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
        if (sql[i] === "\\" && quote !== '"') { i += 2; continue; }
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

  return { semicolons, tokens, variables };
}

function trimmedRange(sql: string, start: number, end: number): [number, number] {
  while (start < end && /\s/.test(sql[start])) start += 1;
  while (end > start && /\s/.test(sql[end - 1])) end -= 1;
  return [start, end];
}

export function splitSqlStatements(sql: string): SqlStatement[] {
  const scan = scanSql(sql);
  const boundaries = [...scan.semicolons.map((position) => position + 1), sql.length];
  const statements: SqlStatement[] = [];
  let start = 0;
  for (const boundary of boundaries) {
    const [trimStart, trimEnd] = trimmedRange(sql, start, boundary);
    const hasToken = scan.tokens.some((token) => token.start >= trimStart && token.start < trimEnd);
    if (trimStart < trimEnd && hasToken) {
      statements.push({ text: sql.slice(trimStart, trimEnd), start: trimStart, end: trimEnd });
    }
    start = boundary;
  }
  return statements;
}

export function statementAtCursor(sql: string, cursor: number): SqlStatement | null {
  const statements = splitSqlStatements(sql);
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

export function applyRowLimit(sql: string, limit: number): string {
  const tokens = statementTokens(sql);
  const first = tokens[0]?.value;
  const withMain = first === "WITH"
    ? tokens.find((token, index) => index > 0 && ["SELECT", "INSERT", "UPDATE", "DELETE", "MERGE", "VALUES"].includes(token.value))?.value
    : undefined;
  const supportsLimit = first === "SELECT" || (first === "WITH" && (withMain === "SELECT" || withMain === "VALUES"));
  if (limit <= 0 || !supportsLimit) return sql;
  if (tokens.some((token) => token.value === "LIMIT" || token.value === "FETCH")) return sql;
  const withoutTerminator = sql.replace(/;\s*$/, "");
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
