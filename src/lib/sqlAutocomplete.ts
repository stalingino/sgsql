import type { ColumnInfo } from "./schema";

export interface CatalogTable {
  db: string;
  schema: string;
  name: string;
  type: "table" | "view";
}

export interface TableReference extends CatalogTable {
  alias?: string;
}

export interface CompletionTarget {
  prefix: string;
  qualifier: string | null;
  replaceStart: number;
  replaceEnd: number;
  relationPosition: boolean;
  shouldOpen: boolean;
}

export interface SqlCompletion {
  key: string;
  label: string;
  insertText: string;
  detail: string;
  kind: "schema" | "table" | "view" | "column";
}

const CLAUSE_KEYWORDS = new Set([
  "where", "join", "left", "right", "inner", "outer", "full", "cross",
  "on", "order", "group", "having", "limit", "offset", "union", "set",
  "values", "returning", "using", "when", "then", "else", "end",
]);

const RESERVED_IDENTIFIERS = new Set([
  "all", "alter", "and", "as", "asc", "begin", "between", "by", "case",
  "check", "column", "commit", "constraint", "create", "database", "default",
  "delete", "desc", "distinct", "drop", "else", "end", "exists", "foreign",
  "from", "full", "group", "having", "in", "index", "inner", "insert", "into",
  "is", "join", "key", "left", "like", "limit", "not", "null", "offset", "on",
  "or", "order", "outer", "primary", "references", "right", "rollback", "schema",
  "select", "set", "table", "then", "union", "unique", "update", "values", "view",
  "when", "where",
]);

function unquoteIdentifier(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("`") && trimmed.endsWith("`")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function identifierParts(value: string): string[] {
  return value.split(".").map(unquoteIdentifier).filter(Boolean);
}

export function quoteCompletionIdentifier(
  value: string,
  dialect: "postgres" | "mysql" | "sqlite",
): string {
  if (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(value) && !RESERVED_IDENTIFIERS.has(value.toLowerCase())) return value;
  if (dialect === "mysql") return `\`${value.replace(/`/g, "``")}\``;
  return `"${value.replace(/"/g, '""')}"`;
}

export function catalogTableKey(table: Pick<CatalogTable, "db" | "schema" | "name">): string {
  return `${table.db}\u0000${table.schema}\u0000${table.name}`;
}

export function getCompletionTarget(sql: string, cursor: number, forced = false): CompletionTarget {
  let tokenStart = Math.max(0, Math.min(cursor, sql.length));
  while (tokenStart > 0 && /[A-Za-z0-9_$.[\]`"-]/.test(sql[tokenStart - 1])) tokenStart--;

  const rawToken = sql.slice(tokenStart, cursor);
  const dot = rawToken.lastIndexOf(".");
  const rawPrefix = dot >= 0 ? rawToken.slice(dot + 1) : rawToken;
  const qualifier = dot >= 0 ? identifierParts(rawToken.slice(0, dot)).join(".") : null;
  const prefix = unquoteIdentifier(rawPrefix).toLowerCase();
  const relationPosition = /\b(?:from|join|update|into)\s*$/i.test(sql.slice(0, tokenStart));
  let replaceEnd = cursor;
  while (replaceEnd < sql.length && /[A-Za-z0-9_$-]/.test(sql[replaceEnd])) replaceEnd++;

  return {
    prefix,
    qualifier,
    replaceStart: dot >= 0 ? tokenStart + dot + 1 : tokenStart,
    replaceEnd,
    relationPosition,
    shouldOpen: forced || relationPosition || dot >= 0 || prefix.length > 0,
  };
}

function resolveCatalogTable(
  token: string,
  catalog: CatalogTable[],
  defaultSchema: string,
): CatalogTable | null {
  const parts = identifierParts(token);
  if (parts.length === 0) return null;
  const tableName = parts[parts.length - 1].toLowerCase();
  const qualifier = parts.length > 1 ? parts[parts.length - 2].toLowerCase() : null;

  const matches = catalog.filter((table) => {
    if (table.name.toLowerCase() !== tableName) return false;
    if (!qualifier) return true;
    return table.schema.toLowerCase() === qualifier || table.db.toLowerCase() === qualifier;
  });
  return matches.find((table) => table.schema === defaultSchema) ?? matches[0] ?? null;
}

export function findTableReferences(
  statement: string,
  catalog: CatalogTable[],
  defaultSchema: string,
): TableReference[] {
  const references: TableReference[] = [];
  const seen = new Set<string>();
  const pattern = /\b(?:from|join|update|into)\s+([^\s,;()]+)(?:\s+(?:as\s+)?([A-Za-z_][\w$]*))?/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(statement))) {
    const table = resolveCatalogTable(match[1], catalog, defaultSchema);
    if (!table) continue;
    const candidateAlias = match[2];
    const alias = candidateAlias && !CLAUSE_KEYWORDS.has(candidateAlias.toLowerCase())
      ? candidateAlias
      : undefined;
    const key = `${catalogTableKey(table)}\u0000${alias ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    references.push({ ...table, alias });
  }
  return references;
}

function matchesQualifier(reference: TableReference, qualifier: string): boolean {
  const q = qualifier.toLowerCase();
  return reference.alias?.toLowerCase() === q ||
    reference.name.toLowerCase() === q ||
    reference.schema.toLowerCase() === q ||
    `${reference.schema}.${reference.name}`.toLowerCase() === q ||
    `${reference.db}.${reference.name}`.toLowerCase() === q;
}

export function buildSqlCompletions({
  target,
  catalog,
  references,
  columnsByTable,
  defaultSchema,
  dialect,
}: {
  target: CompletionTarget;
  catalog: CatalogTable[];
  references: TableReference[];
  columnsByTable: Map<string, ColumnInfo[]>;
  defaultSchema: string;
  dialect: "postgres" | "mysql" | "sqlite";
}): SqlCompletion[] {
  if (!target.shouldOpen) return [];

  if (target.relationPosition) {
    const qualifier = target.qualifier?.toLowerCase();
    const tables = catalog
      .filter((table) => !qualifier || table.schema.toLowerCase() === qualifier || table.db.toLowerCase() === qualifier)
      .filter((table) => {
        const fullName = `${table.schema}.${table.name}`.toLowerCase();
        return table.name.toLowerCase().includes(target.prefix) || fullName.includes(target.prefix);
      })
      .map((table): SqlCompletion => {
        const tableIdent = quoteCompletionIdentifier(table.name, dialect);
        const schemaIdent = quoteCompletionIdentifier(table.schema, dialect);
        const qualified = !!table.schema && table.schema !== defaultSchema;
        return {
          key: `table:${catalogTableKey(table)}`,
          label: qualified ? `${table.schema}.${table.name}` : table.name,
          insertText: target.qualifier || !qualified ? tableIdent : `${schemaIdent}.${tableIdent}`,
          detail: `${table.type} · ${table.schema || table.db}`,
          kind: table.type,
        };
      });

    if (!target.qualifier && dialect === "postgres") {
      const schemas = Array.from(new Set(catalog.map((table) => table.schema)))
        .filter((schema) => schema && schema.toLowerCase().includes(target.prefix))
        .map((schema): SqlCompletion => ({
          key: `schema:${schema}`,
          label: schema,
          insertText: `${quoteCompletionIdentifier(schema, dialect)}.`,
          detail: "schema",
          kind: "schema",
        }));
      return [...schemas, ...tables].slice(0, 100);
    }
    return tables.slice(0, 100);
  }

  const applicable = target.qualifier
    ? references.filter((reference) => matchesQualifier(reference, target.qualifier!))
    : references;
  const suggestions: SqlCompletion[] = [];

  for (const reference of applicable) {
    const columns = columnsByTable.get(catalogTableKey(reference)) ?? [];
    for (const column of columns) {
      if (!column.name.toLowerCase().includes(target.prefix)) continue;
      suggestions.push({
        key: `column:${catalogTableKey(reference)}:${column.name}`,
        label: column.name,
        insertText: quoteCompletionIdentifier(column.name, dialect),
        detail: `${reference.alias ?? reference.name} · ${column.dataType || column.udtName}`,
        kind: "column",
      });
    }
  }

  return suggestions
    .sort((a, b) => {
      const aStarts = a.label.toLowerCase().startsWith(target.prefix) ? 0 : 1;
      const bStarts = b.label.toLowerCase().startsWith(target.prefix) ? 0 : 1;
      return aStarts - bStarts || a.label.localeCompare(b.label) || a.detail.localeCompare(b.detail);
    })
    .slice(0, 100);
}
