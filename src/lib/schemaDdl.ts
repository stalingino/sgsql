import type { ColumnInfo, ForeignKeyInfo, IndexInfo } from "./schema";

export type SqlDialect = "postgres" | "mysql" | "sqlite";

export interface EditableColumn {
  id: string;
  originalName: string | null;
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string;
  isPk: boolean;
}

export function editableColumns(columns: ColumnInfo[]): EditableColumn[] {
  return columns.map((column, index) => ({
    id: `existing-${index}-${column.name}`,
    originalName: column.name,
    name: column.name,
    type: column.udtName || column.dataType,
    nullable: column.nullable,
    defaultValue: column.defaultValue ?? "",
    isPk: column.isPk,
  }));
}

export function quoteIdent(dialect: SqlDialect, value: string): string {
  return dialect === "mysql"
    ? `\`${value.replace(/`/g, "``")}\``
    : `"${value.replace(/"/g, '""')}"`;
}

function tableRef(dialect: SqlDialect, db: string, schema: string, table: string): string {
  if (dialect === "mysql") return `${quoteIdent(dialect, db)}.${quoteIdent(dialect, table)}`;
  if (dialect === "postgres") return `${quoteIdent(dialect, schema || "public")}.${quoteIdent(dialect, table)}`;
  return quoteIdent(dialect, table);
}

function columnDefinition(dialect: SqlDialect, column: EditableColumn, includePk = false): string {
  return `${quoteIdent(dialect, column.name)} ${column.type.trim()}${column.defaultValue.trim() ? ` DEFAULT ${column.defaultValue.trim()}` : ""}${column.nullable ? "" : " NOT NULL"}${includePk && column.isPk ? " PRIMARY KEY" : ""}`;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function validateColumns(columns: EditableColumn[]) {
  if (columns.length === 0) throw new Error("A table must have at least one column.");
  const names = new Set<string>();
  for (const column of columns) {
    if (!column.name.trim()) throw new Error("Every column needs a name.");
    if (!column.type.trim()) throw new Error(`Column ${column.name} needs a type.`);
    const key = column.name.toLowerCase();
    if (names.has(key)) throw new Error(`Duplicate column name: ${column.name}`);
    names.add(key);
  }
}

export function buildColumnMigration({
  dialect, db, schema, table, original, columns, foreignKeys = [], originalForeignKeys, indexes = [],
}: {
  dialect: SqlDialect;
  db: string;
  schema: string;
  table: string;
  original: EditableColumn[];
  columns: EditableColumn[];
  foreignKeys?: ForeignKeyInfo[];
  originalForeignKeys?: ForeignKeyInfo[];
  indexes?: IndexInfo[];
}): string[] {
  validateColumns(columns);
  const ref = tableRef(dialect, db, schema, table);
  if (dialect === "sqlite") {
    const columnsUnchanged = JSON.stringify(original.map(stripId)) === JSON.stringify(columns.map(stripId));
    const foreignKeysUnchanged = originalForeignKeys === undefined || JSON.stringify(originalForeignKeys) === JSON.stringify(foreignKeys);
    if (columnsUnchanged && foreignKeysUnchanged) return [];
    const temp = `__sgsql_${table}_${Date.now().toString(36)}`;
    const pk = columns.filter((column) => column.isPk);
    const definitions = columns.map((column) => columnDefinition(dialect, column, pk.length === 1));
    if (pk.length > 1) definitions.push(`PRIMARY KEY (${pk.map((column) => quoteIdent(dialect, column.name)).join(", ")})`);
    for (const fk of foreignKeys) {
      if (!columns.some((column) => column.name === fk.column)) continue;
      definitions.push(`CONSTRAINT ${quoteIdent(dialect, fk.name)} FOREIGN KEY (${quoteIdent(dialect, fk.column)}) REFERENCES ${quoteIdent(dialect, fk.foreignTable)} (${quoteIdent(dialect, fk.foreignColumn)})${fk.onUpdate && fk.onUpdate !== "NO ACTION" ? ` ON UPDATE ${fk.onUpdate}` : ""}${fk.onDelete && fk.onDelete !== "NO ACTION" ? ` ON DELETE ${fk.onDelete}` : ""}`);
    }
    const copyable = columns.filter((column) => column.originalName && original.some((item) => item.name === column.originalName));
    return [
      "PRAGMA foreign_keys = OFF",
      "BEGIN IMMEDIATE",
      `CREATE TABLE ${quoteIdent(dialect, temp)} (\n  ${definitions.join(",\n  ")}\n)`,
      copyable.length > 0 ? `INSERT INTO ${quoteIdent(dialect, temp)} (${copyable.map((column) => quoteIdent(dialect, column.name)).join(", ")}) SELECT ${copyable.map((column) => quoteIdent(dialect, column.originalName!)).join(", ")} FROM ${ref}` : "",
      `DROP TABLE ${ref}`,
      `ALTER TABLE ${quoteIdent(dialect, temp)} RENAME TO ${quoteIdent(dialect, table)}`,
      ...indexes.filter((index) => !index.primary && !index.name.startsWith("sqlite_autoindex_") && index.columns.every((name) => columns.some((column) => column.name === name))).map((index) => buildCreateIndex(dialect, db, schema, table, index.name, index.columns, index.unique)),
      "COMMIT",
      "PRAGMA foreign_keys = ON",
    ].filter(Boolean);
  }

  const statements: string[] = [];
  const currentNames = new Set(columns.map((column) => column.originalName).filter(Boolean));
  for (const old of original) {
    if (!currentNames.has(old.name)) statements.push(`ALTER TABLE ${ref} DROP COLUMN ${quoteIdent(dialect, old.name)}`);
  }
  for (const column of columns) {
    if (!column.originalName) {
      statements.push(`ALTER TABLE ${ref} ADD COLUMN ${columnDefinition(dialect, column)}`);
      continue;
    }
    const old = original.find((item) => item.name === column.originalName);
    if (!old) continue;
    if (dialect === "mysql") {
      if (JSON.stringify(stripId(old)) !== JSON.stringify(stripId(column))) {
        statements.push(`ALTER TABLE ${ref} CHANGE COLUMN ${quoteIdent(dialect, old.name)} ${columnDefinition(dialect, column)}`);
      }
    } else {
      if (old.name !== column.name) statements.push(`ALTER TABLE ${ref} RENAME COLUMN ${quoteIdent(dialect, old.name)} TO ${quoteIdent(dialect, column.name)}`);
      const activeName = quoteIdent(dialect, column.name);
      if (old.type !== column.type) statements.push(`ALTER TABLE ${ref} ALTER COLUMN ${activeName} TYPE ${column.type.trim()}`);
      if (old.nullable !== column.nullable) statements.push(`ALTER TABLE ${ref} ALTER COLUMN ${activeName} ${column.nullable ? "DROP" : "SET"} NOT NULL`);
      if (old.defaultValue !== column.defaultValue) statements.push(`ALTER TABLE ${ref} ALTER COLUMN ${activeName} ${column.defaultValue.trim() ? `SET DEFAULT ${column.defaultValue.trim()}` : "DROP DEFAULT"}`);
    }
  }

  const oldPk = original.filter((column) => column.isPk).map((column) => column.name).join("\0");
  const nextPk = columns.filter((column) => column.isPk).map((column) => column.name).join("\0");
  if (oldPk !== nextPk) {
    if (oldPk) statements.push(dialect === "mysql"
      ? `ALTER TABLE ${ref} DROP PRIMARY KEY`
      : `DO $$ DECLARE pk_name text; BEGIN SELECT con.conname INTO pk_name FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid JOIN pg_namespace ns ON ns.oid = rel.relnamespace WHERE con.contype = 'p' AND ns.nspname = ${quoteLiteral(schema || "public")} AND rel.relname = ${quoteLiteral(table)}; IF pk_name IS NOT NULL THEN EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT %I', ${quoteLiteral(schema || "public")}, ${quoteLiteral(table)}, pk_name); END IF; END $$`);
    const pkColumns = columns.filter((column) => column.isPk);
    if (pkColumns.length) statements.push(`ALTER TABLE ${ref} ADD PRIMARY KEY (${pkColumns.map((column) => quoteIdent(dialect, column.name)).join(", ")})`);
  }
  return statements;
}

function stripId(column: EditableColumn) {
  const { id: _id, ...value } = column;
  return value;
}

export function buildCreateIndex(dialect: SqlDialect, db: string, schema: string, table: string, name: string, columns: string[], unique: boolean): string {
  if (!name.trim() || columns.length === 0) throw new Error("Index name and at least one column are required.");
  return `CREATE ${unique ? "UNIQUE " : ""}INDEX ${quoteIdent(dialect, name)} ON ${tableRef(dialect, db, schema, table)} (${columns.map((column) => quoteIdent(dialect, column)).join(", ")})`;
}

export function buildDropIndex(dialect: SqlDialect, db: string, schema: string, table: string, name: string): string {
  if (dialect === "mysql") return `DROP INDEX ${quoteIdent(dialect, name)} ON ${tableRef(dialect, db, schema, table)}`;
  if (dialect === "postgres") return `DROP INDEX ${quoteIdent(dialect, schema || "public")}.${quoteIdent(dialect, name)}`;
  return `DROP INDEX ${quoteIdent(dialect, name)}`;
}

export function buildEditIndex(dialect: SqlDialect, db: string, schema: string, table: string, originalName: string, name: string, columns: string[], unique: boolean): string[] {
  const create = buildCreateIndex(dialect, db, schema, table, name, columns, unique);
  return [buildDropIndex(dialect, db, schema, table, originalName), create];
}

export function buildAddForeignKey(dialect: SqlDialect, db: string, schema: string, table: string, fk: ForeignKeyInfo): string {
  if (dialect === "sqlite") throw new Error("SQLite foreign keys are changed through table recreation in the Columns tab.");
  if (!fk.name.trim() || !fk.column || !fk.foreignTable.trim() || !fk.foreignColumn.trim()) throw new Error("Constraint name, local column, referenced table, and referenced column are required.");
  const foreignRef = dialect === "mysql"
    ? `${quoteIdent(dialect, fk.foreignSchema || db)}.${quoteIdent(dialect, fk.foreignTable)}`
    : `${quoteIdent(dialect, fk.foreignSchema || schema)}.${quoteIdent(dialect, fk.foreignTable)}`;
  return `ALTER TABLE ${tableRef(dialect, db, schema, table)} ADD CONSTRAINT ${quoteIdent(dialect, fk.name)} FOREIGN KEY (${quoteIdent(dialect, fk.column)}) REFERENCES ${foreignRef} (${quoteIdent(dialect, fk.foreignColumn)})`;
}

export function buildDropForeignKey(dialect: SqlDialect, db: string, schema: string, table: string, name: string): string {
  if (dialect === "sqlite") throw new Error("SQLite foreign keys are changed through table recreation in the Columns tab.");
  return `ALTER TABLE ${tableRef(dialect, db, schema, table)} DROP ${dialect === "mysql" ? "FOREIGN KEY" : "CONSTRAINT"} ${quoteIdent(dialect, name)}`;
}
