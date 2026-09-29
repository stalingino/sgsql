import { format as formatSql } from "sql-formatter";

export type SqlDialect = "postgres" | "mysql" | "sqlite" | "oracle";

export function dialectToFormatterLanguage(dialect: SqlDialect): "postgresql" | "mysql" | "sqlite" | "plsql" {
  if (dialect === "postgres") return "postgresql";
  if (dialect === "oracle") return "plsql";
  return dialect;
}

export { formatSql };
