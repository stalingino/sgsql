export type ExportFormat = "csv" | "json" | "ndjson" | "sql";
export type ExportDialect = "postgres" | "mysql" | "sqlite";

export interface ExportChunkOptions {
  format: ExportFormat;
  columns: string[];
  rows: unknown[][];
  dialect: ExportDialect;
  table: string;
  schema?: string;
  database?: string;
  first: boolean;
}

export function exportExtension(format: ExportFormat): string {
  return format === "ndjson" ? "ndjson" : format;
}

export function quoteExportIdentifier(dialect: ExportDialect, value: string): string {
  if (dialect === "mysql") return `\`${value.replace(/`/g, "``")}\``;
  return `"${value.replace(/"/g, '""')}"`;
}

export function exportTableReference(dialect: ExportDialect, database: string | undefined, schema: string | undefined, table: string): string {
  if (dialect === "mysql" && database) return `${quoteExportIdentifier(dialect, database)}.${quoteExportIdentifier(dialect, table)}`;
  if (dialect === "postgres" && schema) return `${quoteExportIdentifier(dialect, schema)}.${quoteExportIdentifier(dialect, table)}`;
  return quoteExportIdentifier(dialect, table);
}

function rowObject(columns: string[], row: unknown[]): Record<string, unknown> {
  return Object.fromEntries(columns.map((column, index) => [column, row[index]]));
}

function csvValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function sqlValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return `'${text.replace(/'/g, "''")}'`;
}

export function serializeExportChunk(options: ExportChunkOptions): string {
  const { format, columns, rows, dialect, table, schema, database, first } = options;
  if (format === "csv") {
    const lines = rows.map((row) => row.map(csvValue).join(","));
    if (first) lines.unshift(columns.map(csvValue).join(","));
    return lines.length ? `${lines.join("\n")}\n` : "";
  }
  if (format === "ndjson") {
    return rows.map((row) => JSON.stringify(rowObject(columns, row))).join("\n") + (rows.length ? "\n" : "");
  }
  if (format === "json") {
    const objects = rows.map((row) => JSON.stringify(rowObject(columns, row), null, 2));
    if (objects.length === 0) return first ? "[" : "";
    return `${first ? "[\n" : ",\n"}${objects.join(",\n")}`;
  }
  if (rows.length === 0) return "";
  const target = exportTableReference(dialect, database, schema, table);
  const columnList = columns.map((column) => quoteExportIdentifier(dialect, column)).join(", ");
  const values = rows.map((row) => `  (${row.map(sqlValue).join(", ")})`).join(",\n");
  return `INSERT INTO ${target} (${columnList})\nVALUES\n${values};\n`;
}

export function finishExport(format: ExportFormat, wroteRows: boolean): string {
  if (format !== "json") return "";
  return wroteRows ? "\n]\n" : "]\n";
}
