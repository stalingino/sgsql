import { describe, expect, test } from "bun:test";
import {
  buildAddForeignKey,
  buildColumnMigration,
  buildCreateIndex,
  buildDropIndex,
  buildEditIndex,
  buildCreateTable,
  buildCreateTableStatements,
  quoteIdent,
  type EditableColumn,
} from "../src/lib/schemaDdl";

const column = (name: string, patch: Partial<EditableColumn> = {}): EditableColumn => ({
  id: `column-${name}`,
  originalName: name,
  name,
  type: "integer",
  nullable: false,
  defaultValue: "",
  isPk: false,
  ...patch,
});

describe("schema DDL generation", () => {
  test("quotes identifiers for each dialect", () => {
    expect(quoteIdent("postgres", 'odd"name')).toBe('"odd""name"');
    expect(quoteIdent("mysql", "odd`name")).toBe("`odd``name`");
  });

  test("generates PostgreSQL column alterations and primary key changes", () => {
    const original = [column("id"), column("name", { type: "text", nullable: true })];
    const columns = [
      column("id", { isPk: true }),
      column("name", { name: "display_name", type: "varchar(100)", nullable: false, defaultValue: "'unknown'" }),
    ];
    const sql = buildColumnMigration({ dialect: "postgres", db: "app", schema: "public", table: "users", original, columns });
    expect(sql).toContain('ALTER TABLE "public"."users" RENAME COLUMN "name" TO "display_name"');
    expect(sql).toContain('ALTER TABLE "public"."users" ALTER COLUMN "display_name" TYPE varchar(100)');
    expect(sql.at(-1)).toBe('ALTER TABLE "public"."users" ADD PRIMARY KEY ("id")');
  });

  test("uses CHANGE COLUMN for MySQL", () => {
    const original = [column("total")];
    const columns = [column("total", { type: "decimal(12,2)", nullable: true })];
    expect(buildColumnMigration({ dialect: "mysql", db: "shop", schema: "", table: "orders", original, columns })).toEqual([
      "ALTER TABLE `shop`.`orders` CHANGE COLUMN `total` `total` decimal(12,2)",
    ]);
  });

  test("generates SQLite table recreation statements for atomic sidecar execution", () => {
    const original = [column("id", { isPk: true }), column("legacy", { type: "text", nullable: true })];
    const columns = [column("id", { isPk: true }), { ...column("title", { type: "text", nullable: true }), originalName: null }];
    const sql = buildColumnMigration({
      dialect: "sqlite", db: "main", schema: "main", table: "notes", original, columns,
      indexes: [{ name: "notes_title_idx", columns: ["title"], unique: false }],
    });
    expect(sql[0].startsWith('CREATE TABLE "__sgsql_notes_')).toBe(true);
    expect(sql.some((statement) => statement.startsWith('INSERT INTO "__sgsql_notes_') && statement.includes('SELECT "id" FROM "notes"'))).toBe(true);
    expect(sql).toContain('CREATE INDEX "notes_title_idx" ON "notes" ("title")');
    expect(sql.at(-1)).toBe('CREATE INDEX "notes_title_idx" ON "notes" ("title")');
  });

  test("recreates a SQLite table for foreign-key-only changes", () => {
    const columns = [column("user_id")];
    const sql = buildColumnMigration({
      dialect: "sqlite", db: "main", schema: "main", table: "notes", original: columns, columns,
      originalForeignKeys: [],
      foreignKeys: [{ name: "notes_user_fk", column: "user_id", foreignSchema: "main", foreignTable: "users", foreignColumn: "id" }],
    });
    expect(sql.some((statement) => statement.includes('CONSTRAINT "notes_user_fk" FOREIGN KEY ("user_id")'))).toBe(true);
  });

  test("generates index and foreign-key statements", () => {
    expect(buildCreateIndex("postgres", "app", "audit", "events", "events_kind_idx", ["kind"], true)).toBe(
      'CREATE UNIQUE INDEX "events_kind_idx" ON "audit"."events" ("kind")',
    );
    expect(buildDropIndex("mysql", "app", "", "events", "events_kind_idx")).toBe(
      "DROP INDEX `events_kind_idx` ON `app`.`events`",
    );
    expect(buildAddForeignKey("postgres", "app", "public", "orders", {
      name: "orders_user_fk", column: "user_id", foreignSchema: "identity", foreignTable: "users", foreignColumn: "id",
    })).toContain('REFERENCES "identity"."users" ("id")');
  });

  test("edits an index by dropping and recreating it", () => {
    expect(buildEditIndex("mysql", "app", "", "events", "old_idx", "new_idx", ["kind", "created_at"], true)).toEqual([
      "CREATE UNIQUE INDEX `new_idx` ON `app`.`events` (`kind`, `created_at`)",
      "DROP INDEX `old_idx` ON `app`.`events`",
    ]);
  });

  test("generates physical column positioning for MySQL", () => {
    const original = [column("first"), column("second")];
    const sql = buildColumnMigration({ dialect: "mysql", db: "app", schema: "", table: "items", original, columns: [column("second"), column("first")] });
    expect(sql).toEqual([
      "ALTER TABLE `app`.`items` MODIFY COLUMN `second` integer NOT NULL FIRST",
      "ALTER TABLE `app`.`items` MODIFY COLUMN `first` integer NOT NULL AFTER `second`",
    ]);
  });

  test("rejects unsafe PostgreSQL physical reordering", () => {
    const original = [column("first"), column("second")];
    expect(() => buildColumnMigration({ dialect: "postgres", db: "app", schema: "public", table: "items", original, columns: [column("second"), column("first")] })).toThrow("does not support safely reordering");
  });

  test("preserves advanced SQLite DDL, indexes, triggers, and table options", () => {
    const original = [column("id", { isPk: true }), column("name", { type: "TEXT", nullable: true })];
    const columns = [...original, { ...column("created_at", { type: "TEXT", nullable: true }), originalName: null }];
    const sql = buildColumnMigration({
      dialect: "sqlite", db: "main", schema: "main", table: "notes", original, columns,
      originalDdl: 'CREATE TABLE "notes" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT COLLATE NOCASE, CHECK(length(name) > 0)) STRICT;',
      indexes: [{ name: "notes_lower_idx", columns: [], unique: false, definition: "CREATE INDEX notes_lower_idx ON notes(lower(name)) WHERE name IS NOT NULL" }],
      triggers: ["CREATE TRIGGER notes_touch AFTER UPDATE ON notes BEGIN UPDATE notes SET name = new.name WHERE id = new.id; END"],
    });
    expect(sql[0]).toContain('"id" INTEGER PRIMARY KEY AUTOINCREMENT');
    expect(sql[0]).toContain('"name" TEXT COLLATE NOCASE');
    expect(sql[0]).toContain("CHECK(length(name) > 0)");
    expect(sql[0]).toEndWith("STRICT");
    expect(sql).toContain("CREATE INDEX notes_lower_idx ON notes(lower(name)) WHERE name IS NOT NULL");
    expect(sql.at(-1)).toStartWith("CREATE TRIGGER notes_touch");
  });

  test("creates tables with composite keys and advanced index options", () => {
    const columns = [column("tenant_id", { isPk: true }), column("id", { isPk: true }), column("email", { type: "text", unique: true })];
    expect(buildCreateTable("postgres", "app", "audit", "events", columns)).toContain('PRIMARY KEY ("tenant_id", "id")');
    expect(buildCreateIndex("postgres", "app", "audit", "events", "events_email_idx", ["email"], true, { method: "btree", includeColumns: ["id"], predicate: "email IS NOT NULL" })).toBe(
      'CREATE UNIQUE INDEX "events_email_idx" ON "audit"."events" USING btree ("email") INCLUDE ("id") WHERE email IS NOT NULL',
    );
    expect(buildCreateIndex("postgres", "app", "audit", "events", "events_lower_email_idx", [], false, { expressionSql: "lower(email)" })).toBe(
      'CREATE INDEX "events_lower_email_idx" ON "audit"."events" (lower(email))',
    );
  });

  test("emits PostgreSQL comments as part of create-table batches", () => {
    const statements = buildCreateTableStatements("postgres", "app", "public", "users", [column("id", { comment: "Stable identifier" })]);
    expect(statements).toEqual([
      'CREATE TABLE "public"."users" (\n  "id" integer NOT NULL\n)',
      `COMMENT ON COLUMN "public"."users"."id" IS 'Stable identifier'`,
    ]);
  });

  test("generates composite foreign keys with actions", () => {
    expect(buildAddForeignKey("postgres", "app", "public", "orders", {
      name: "orders_tenant_user_fk", column: "tenant_id", columns: ["tenant_id", "user_id"], foreignSchema: "identity", foreignTable: "users", foreignColumn: "tenant_id", foreignColumns: ["tenant_id", "id"], onUpdate: "CASCADE", onDelete: "SET NULL",
    })).toBe('ALTER TABLE "public"."orders" ADD CONSTRAINT "orders_tenant_user_fk" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "identity"."users" ("tenant_id", "id") ON UPDATE CASCADE ON DELETE SET NULL');
  });

  test("rejects duplicate column names", () => {
    expect(() => buildColumnMigration({
      dialect: "postgres", db: "app", schema: "public", table: "users", original: [column("id")], columns: [column("id"), { ...column("ID"), originalName: null }],
    })).toThrow("Duplicate column name");
  });
});
