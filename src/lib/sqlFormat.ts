import { format as formatSql } from "sql-formatter";

export type SqlDialect = "postgres" | "mysql" | "sqlite";

export function dialectToFormatterLanguage(dialect: SqlDialect): "postgresql" | "mysql" | "sqlite" {
  return dialect === "postgres" ? "postgresql" : dialect;
}

export { formatSql };
