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
  unique?: boolean;
  extra?: string;
  comment?: string;
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
    unique: column.unique ?? false,
    extra: column.extra ?? "",
    comment: column.comment ?? "",
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
  return `${quoteIdent(dialect, column.name)} ${column.type.trim()}${column.defaultValue.trim() ? ` DEFAULT ${column.defaultValue.trim()}` : ""}${column.nullable ? "" : " NOT NULL"}${column.unique ? " UNIQUE" : ""}${includePk && column.isPk ? " PRIMARY KEY" : ""}${column.extra?.trim() ? ` ${column.extra.trim()}` : ""}${dialect === "mysql" && column.comment?.trim() ? ` COMMENT ${quoteLiteral(column.comment.trim())}` : ""}`;
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

export function buildCreateTable(dialect: SqlDialect, db: string, schema: string, table: string, columns: EditableColumn[], foreignKeys: ForeignKeyInfo[] = []): string {
  if (!table.trim()) throw new Error("Table name is required.");
  validateColumns(columns);
  const pk = columns.filter((column) => column.isPk);
  const definitions = columns.map((column) => columnDefinition(dialect, column, pk.length === 1));
  if (pk.length > 1) definitions.push(`PRIMARY KEY (${pk.map((column) => quoteIdent(dialect, column.name)).join(", ")})`);
  for (const fk of foreignKeys) {
    const local = fk.columns?.length ? fk.columns : [fk.column];
    const remote = fk.foreignColumns?.length ? fk.foreignColumns : [fk.foreignColumn];
    const foreignRef = dialect === "sqlite"
      ? quoteIdent(dialect, fk.foreignTable)
      : dialect === "mysql"
        ? `${quoteIdent(dialect, fk.foreignSchema || db)}.${quoteIdent(dialect, fk.foreignTable)}`
        : `${quoteIdent(dialect, fk.foreignSchema || schema || "public")}.${quoteIdent(dialect, fk.foreignTable)}`;
    definitions.push(`CONSTRAINT ${quoteIdent(dialect, fk.name)} FOREIGN KEY (${local.map((name) => quoteIdent(dialect, name)).join(", ")}) REFERENCES ${foreignRef} (${remote.map((name) => quoteIdent(dialect, name)).join(", ")})`);
  }
  return `CREATE TABLE ${tableRef(dialect, db, schema, table)} (\n  ${definitions.join(",\n  ")}\n)`;
}

export function buildCreateTableStatements(dialect: SqlDialect, db: string, schema: string, table: string, columns: EditableColumn[], foreignKeys: ForeignKeyInfo[] = []): string[] {
  const create = buildCreateTable(dialect, db, schema, table, columns, foreignKeys);
  if (dialect !== "postgres") return [create];
  const ref = tableRef(dialect, db, schema, table);
  return [create, ...columns.filter((column) => column.comment?.trim()).map((column) => `COMMENT ON COLUMN ${ref}.${quoteIdent(dialect, column.name)} IS ${quoteLiteral(column.comment!.trim())}`)];
}

function splitSqlDefinitions(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (quote) {
      if (char === quote && value[i + 1] === quote) { i += 1; continue; }
      if ((quote === "]" && char === "]") || char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"' || char === "`") quote = char;
    else if (char === "[") quote = "]";
    else if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) { parts.push(value.slice(start, i).trim()); start = i + 1; }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function sqliteDdlLayout(ddl?: string): { columns: Map<string, string>; constraints: string[]; suffix: string } {
  const result = { columns: new Map<string, string>(), constraints: [] as string[], suffix: "" };
  if (!ddl) return result;
  const open = ddl.indexOf("(");
  if (open < 0) return result;
  let depth = 0;
  let close = -1;
  let quote = "";
  for (let i = open; i < ddl.length; i += 1) {
    const char = ddl[i];
    if (quote) {
      if (char === quote && ddl[i + 1] === quote) { i += 1; continue; }
      if ((quote === "]" && char === "]") || char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"' || char === "`") quote = char;
    else if (char === "[") quote = "]";
    else if (char === "(") depth += 1;
    else if (char === ")" && --depth === 0) { close = i; break; }
  }
  if (close < 0) return result;
  result.suffix = ddl.slice(close + 1).replace(/;\s*$/, "").trim();
  for (const definition of splitSqlDefinitions(ddl.slice(open + 1, close))) {
    if (/^(?:CONSTRAINT\b|PRIMARY\s+KEY\b|UNIQUE\b|CHECK\b|FOREIGN\s+KEY\b)/i.test(definition)) {
      if (!/\b(?:PRIMARY|FOREIGN)\s+KEY\b/i.test(definition)) result.constraints.push(definition);
      continue;
    }
    const match = /^(?:"((?:""|[^"])*)"|`((?:``|[^`])*)`|\[([^\]]+)\]|([^\s]+))/.exec(definition);
    const name = (match?.[1]?.replace(/""/g, '"') ?? match?.[2]?.replace(/``/g, "`") ?? match?.[3] ?? match?.[4] ?? "").toLowerCase();
    if (name) result.columns.set(name, definition);
  }
  return result;
}

export function buildColumnMigration({
  dialect, db, schema, table, original, columns, foreignKeys = [], originalForeignKeys, indexes = [], originalDdl, triggers = [],
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
  originalDdl?: string;
  triggers?: string[];
}): string[] {
  validateColumns(columns);
  const ref = tableRef(dialect, db, schema, table);
  if (dialect === "sqlite") {
    const columnsUnchanged = JSON.stringify(original.map(stripId)) === JSON.stringify(columns.map(stripId));
    const foreignKeysUnchanged = originalForeignKeys === undefined || JSON.stringify(originalForeignKeys) === JSON.stringify(foreignKeys);
    if (columnsUnchanged && foreignKeysUnchanged) return [];
    const temp = `__sgsql_${table}_${Date.now().toString(36)}`;
    const pk = columns.filter((column) => column.isPk);
    const layout = sqliteDdlLayout(originalDdl);
    const definitions = columns.map((column) => {
      const old = column.originalName ? original.find((candidate) => candidate.name === column.originalName) : undefined;
      const raw = column.originalName ? layout.columns.get(column.originalName.toLowerCase()) : undefined;
      const unchanged = old && JSON.stringify(stripId(old)) === JSON.stringify(stripId(column));
      if (raw && unchanged && !/\bREFERENCES\b/i.test(raw)) return raw;
      if (raw && /\b(?:COLLATE|CHECK|GENERATED|UNIQUE|AUTOINCREMENT)\b/i.test(raw) && !unchanged) {
        throw new Error(`SQLite column ${column.originalName} has advanced clauses that cannot be safely rewritten. Use reviewed manual DDL for this change.`);
      }
      return columnDefinition(dialect, column, pk.length === 1);
    });
    if (pk.length > 1) definitions.push(`PRIMARY KEY (${pk.map((column) => quoteIdent(dialect, column.name)).join(", ")})`);
    definitions.push(...layout.constraints);
    for (const fk of foreignKeys) {
      const localColumns = fk.columns?.length ? fk.columns : [fk.column];
      const remoteColumns = fk.foreignColumns?.length ? fk.foreignColumns : [fk.foreignColumn];
      if (!localColumns.every((name) => columns.some((column) => column.name === name))) continue;
      definitions.push(`CONSTRAINT ${quoteIdent(dialect, fk.name)} FOREIGN KEY (${localColumns.map((name) => quoteIdent(dialect, name)).join(", ")}) REFERENCES ${quoteIdent(dialect, fk.foreignTable)} (${remoteColumns.map((name) => quoteIdent(dialect, name)).join(", ")})${fk.onUpdate && fk.onUpdate !== "NO ACTION" ? ` ON UPDATE ${fk.onUpdate}` : ""}${fk.onDelete && fk.onDelete !== "NO ACTION" ? ` ON DELETE ${fk.onDelete}` : ""}`);
    }
    const copyable = columns.filter((column) => column.originalName && original.some((item) => item.name === column.originalName));
    return [
      `CREATE TABLE ${quoteIdent(dialect, temp)} (\n  ${definitions.join(",\n  ")}\n)${layout.suffix ? ` ${layout.suffix}` : ""}`,
      copyable.length > 0 ? `INSERT INTO ${quoteIdent(dialect, temp)} (${copyable.map((column) => quoteIdent(dialect, column.name)).join(", ")}) SELECT ${copyable.map((column) => quoteIdent(dialect, column.originalName!)).join(", ")} FROM ${ref}` : "",
      `DROP TABLE ${ref}`,
      `ALTER TABLE ${quoteIdent(dialect, temp)} RENAME TO ${quoteIdent(dialect, table)}`,
      ...indexes.filter((index) => !index.primary && !index.name.startsWith("sqlite_autoindex_") && (index.definition || index.columns.every((name) => columns.some((column) => column.name === name)))).map((index) => index.definition || buildCreateIndex(dialect, db, schema, table, index.name, index.columns, index.unique)),
      ...triggers,
    ].filter(Boolean);
  }

  const statements: string[] = [];
  const currentNames = new Set(columns.map((column) => column.originalName).filter(Boolean));
  const survivingOriginalOrder = original.filter((column) => currentNames.has(column.name)).map((column) => column.name);
  const desiredOriginalOrder = columns.map((column) => column.originalName).filter((name): name is string => !!name);
  const orderChanged = survivingOriginalOrder.join("\0") !== desiredOriginalOrder.join("\0") || columns.some((column) => !column.originalName);
  if (dialect === "postgres" && survivingOriginalOrder.join("\0") !== desiredOriginalOrder.join("\0")) {
    throw new Error("PostgreSQL does not support safely reordering physical columns. Create a replacement table if physical order is required.");
  }
  for (const old of original) {
    if (!currentNames.has(old.name)) statements.push(`ALTER TABLE ${ref} DROP COLUMN ${quoteIdent(dialect, old.name)}`);
  }
  for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
    const column = columns[columnIndex];
    const mysqlPosition = columnIndex === 0 ? " FIRST" : ` AFTER ${quoteIdent("mysql", columns[columnIndex - 1].name)}`;
    if (!column.originalName) {
      statements.push(`ALTER TABLE ${ref} ADD COLUMN ${columnDefinition(dialect, column)}${dialect === "mysql" ? mysqlPosition : ""}`);
      if (dialect === "postgres" && column.comment?.trim()) statements.push(`COMMENT ON COLUMN ${ref}.${quoteIdent(dialect, column.name)} IS ${quoteLiteral(column.comment.trim())}`);
      continue;
    }
    const old = original.find((item) => item.name === column.originalName);
    if (!old) continue;
    if (dialect === "mysql") {
      if (JSON.stringify(stripId(old)) !== JSON.stringify(stripId(column))) {
        statements.push(`ALTER TABLE ${ref} CHANGE COLUMN ${quoteIdent(dialect, old.name)} ${columnDefinition(dialect, column)}${orderChanged ? mysqlPosition : ""}`);
      } else if (orderChanged) {
        statements.push(`ALTER TABLE ${ref} MODIFY COLUMN ${columnDefinition(dialect, column)}${mysqlPosition}`);
      }
    } else {
      if (old.name !== column.name) statements.push(`ALTER TABLE ${ref} RENAME COLUMN ${quoteIdent(dialect, old.name)} TO ${quoteIdent(dialect, column.name)}`);
      const activeName = quoteIdent(dialect, column.name);
      if (old.type !== column.type) statements.push(`ALTER TABLE ${ref} ALTER COLUMN ${activeName} TYPE ${column.type.trim()}`);
      if (old.nullable !== column.nullable) statements.push(`ALTER TABLE ${ref} ALTER COLUMN ${activeName} ${column.nullable ? "DROP" : "SET"} NOT NULL`);
      if (old.defaultValue !== column.defaultValue) statements.push(`ALTER TABLE ${ref} ALTER COLUMN ${activeName} ${column.defaultValue.trim() ? `SET DEFAULT ${column.defaultValue.trim()}` : "DROP DEFAULT"}`);
      if ((old.unique ?? false) !== (column.unique ?? false)) {
        if (column.unique) statements.push(`ALTER TABLE ${ref} ADD UNIQUE (${activeName})`);
        else statements.push(`DO $$ DECLARE uq_name text; BEGIN SELECT con.conname INTO uq_name FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid JOIN pg_namespace ns ON ns.oid = rel.relnamespace WHERE con.contype = 'u' AND ns.nspname = ${quoteLiteral(schema || "public")} AND rel.relname = ${quoteLiteral(table)} AND con.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = rel.oid AND attname = ${quoteLiteral(column.name)})]; IF uq_name IS NOT NULL THEN EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT %I', ${quoteLiteral(schema || "public")}, ${quoteLiteral(table)}, uq_name); END IF; END $$`);
      }
      if ((old.extra ?? "").trim() !== (column.extra ?? "").trim()) {
        const oldExtra = (old.extra ?? "").trim();
        const nextExtra = (column.extra ?? "").trim();
        if (/^GENERATED\s+(?:ALWAYS|BY DEFAULT)\s+AS IDENTITY$/i.test(nextExtra) && !/\bAS IDENTITY$/i.test(oldExtra)) {
          statements.push(`ALTER TABLE ${ref} ALTER COLUMN ${activeName} ADD ${nextExtra}`);
        } else if (/\bAS IDENTITY$/i.test(oldExtra) && !nextExtra) {
          statements.push(`ALTER TABLE ${ref} ALTER COLUMN ${activeName} DROP IDENTITY`);
        } else if (/^COLLATE\s+/i.test(nextExtra)) {
          statements.push(`ALTER TABLE ${ref} ALTER COLUMN ${activeName} TYPE ${column.type.trim()} ${nextExtra}`);
        } else {
          throw new Error(`PostgreSQL cannot safely alter advanced clauses for ${column.name}; use reviewed manual DDL.`);
        }
      }
      if ((old.comment ?? "") !== (column.comment ?? "")) statements.push(`COMMENT ON COLUMN ${ref}.${activeName} IS ${column.comment?.trim() ? quoteLiteral(column.comment.trim()) : "NULL"}`);
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

export function buildCreateIndex(dialect: SqlDialect, db: string, schema: string, table: string, name: string, columns: string[], unique: boolean, options: { method?: string; predicate?: string; includeColumns?: string[]; expressionSql?: string } = {}): string {
  if (!name.trim() || (columns.length === 0 && !options.expressionSql?.trim())) throw new Error("Index name and at least one column or expression are required.");
  if (dialect === "mysql" && (options.predicate?.trim() || options.includeColumns?.length)) throw new Error("MySQL does not support partial indexes or INCLUDE columns.");
  if (dialect === "sqlite" && options.includeColumns?.length) throw new Error("SQLite does not support INCLUDE columns.");
  if (dialect === "sqlite" && options.method?.trim()) throw new Error("SQLite does not support selectable index methods.");
  const method = options.method?.trim() ? ` USING ${options.method.trim()}` : "";
  const include = options.includeColumns?.length ? ` INCLUDE (${options.includeColumns.map((column) => quoteIdent(dialect, column)).join(", ")})` : "";
  const predicate = options.predicate?.trim() ? ` WHERE ${options.predicate.trim()}` : "";
  const indexedValues = [...columns.map((column) => quoteIdent(dialect, column)), ...(options.expressionSql?.trim() ? [options.expressionSql.trim()] : [])].join(", ");
  return dialect === "mysql"
    ? `CREATE ${unique ? "UNIQUE " : ""}INDEX ${quoteIdent(dialect, name)}${method} ON ${tableRef(dialect, db, schema, table)} (${indexedValues})`
    : `CREATE ${unique ? "UNIQUE " : ""}INDEX ${quoteIdent(dialect, name)} ON ${tableRef(dialect, db, schema, table)}${method} (${indexedValues})${include}${predicate}`;
}

export function buildDropIndex(dialect: SqlDialect, db: string, schema: string, table: string, name: string): string {
  if (dialect === "mysql") return `DROP INDEX ${quoteIdent(dialect, name)} ON ${tableRef(dialect, db, schema, table)}`;
  if (dialect === "postgres") return `DROP INDEX ${quoteIdent(dialect, schema || "public")}.${quoteIdent(dialect, name)}`;
  return `DROP INDEX ${quoteIdent(dialect, name)}`;
}

export function buildEditIndex(dialect: SqlDialect, db: string, schema: string, table: string, originalName: string, name: string, columns: string[], unique: boolean, options: { method?: string; predicate?: string; includeColumns?: string[]; expressionSql?: string } = {}): string[] {
  const create = buildCreateIndex(dialect, db, schema, table, name, columns, unique, options);
  const drop = buildDropIndex(dialect, db, schema, table, originalName);
  // A renamed replacement can be created first, which avoids an unindexed
  // window if non-transactional MySQL DDL fails. Same-name replacements must
  // necessarily drop first.
  return originalName === name ? [drop, create] : [create, drop];
}

export function buildAddForeignKey(dialect: SqlDialect, db: string, schema: string, table: string, fk: ForeignKeyInfo): string {
  if (dialect === "sqlite") throw new Error("SQLite foreign keys are changed through table recreation in the Columns tab.");
  const localColumns = fk.columns?.filter(Boolean).length ? fk.columns.filter(Boolean) : [fk.column].filter(Boolean);
  const remoteColumns = fk.foreignColumns?.filter(Boolean).length ? fk.foreignColumns.filter(Boolean) : [fk.foreignColumn].filter(Boolean);
  if (!fk.name.trim() || localColumns.length === 0 || !fk.foreignTable.trim() || remoteColumns.length === 0) throw new Error("Constraint name, local column, referenced table, and referenced column are required.");
  if (localColumns.length !== remoteColumns.length) throw new Error("Foreign keys require the same number of local and referenced columns.");
  const foreignRef = dialect === "mysql"
    ? `${quoteIdent(dialect, fk.foreignSchema || db)}.${quoteIdent(dialect, fk.foreignTable)}`
    : `${quoteIdent(dialect, fk.foreignSchema || schema)}.${quoteIdent(dialect, fk.foreignTable)}`;
  return `ALTER TABLE ${tableRef(dialect, db, schema, table)} ADD CONSTRAINT ${quoteIdent(dialect, fk.name)} FOREIGN KEY (${localColumns.map((name) => quoteIdent(dialect, name)).join(", ")}) REFERENCES ${foreignRef} (${remoteColumns.map((name) => quoteIdent(dialect, name)).join(", ")})${fk.onUpdate && fk.onUpdate !== "NO ACTION" ? ` ON UPDATE ${fk.onUpdate}` : ""}${fk.onDelete && fk.onDelete !== "NO ACTION" ? ` ON DELETE ${fk.onDelete}` : ""}`;
}

export function buildDropForeignKey(dialect: SqlDialect, db: string, schema: string, table: string, name: string): string {
  if (dialect === "sqlite") throw new Error("SQLite foreign keys are changed through table recreation in the Columns tab.");
  return `ALTER TABLE ${tableRef(dialect, db, schema, table)} DROP ${dialect === "mysql" ? "FOREIGN KEY" : "CONSTRAINT"} ${quoteIdent(dialect, name)}`;
}
