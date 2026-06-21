import { describe, expect, test } from "bun:test";
import {
  buildAddForeignKey,
  buildColumnMigration,
  buildCreateIndex,
  buildDropIndex,
  buildEditIndex,
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

  test("uses transactional table recreation for SQLite", () => {
    const original = [column("id", { isPk: true }), column("legacy", { type: "text", nullable: true })];
    const columns = [column("id", { isPk: true }), { ...column("title", { type: "text", nullable: true }), originalName: null }];
    const sql = buildColumnMigration({
      dialect: "sqlite", db: "main", schema: "main", table: "notes", original, columns,
      indexes: [{ name: "notes_title_idx", columns: ["title"], unique: false }],
    });
    expect(sql[0]).toBe("PRAGMA foreign_keys = OFF");
    expect(sql).toContain("BEGIN IMMEDIATE");
    expect(sql.some((statement) => statement.startsWith('INSERT INTO "__sgsql_notes_') && statement.includes('SELECT "id" FROM "notes"'))).toBe(true);
    expect(sql).toContain('CREATE INDEX "notes_title_idx" ON "notes" ("title")');
    expect(sql.at(-2)).toBe("COMMIT");
    expect(sql.at(-1)).toBe("PRAGMA foreign_keys = ON");
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
      "DROP INDEX `old_idx` ON `app`.`events`",
      "CREATE UNIQUE INDEX `new_idx` ON `app`.`events` (`kind`, `created_at`)",
    ]);
  });

  test("rejects duplicate column names", () => {
    expect(() => buildColumnMigration({
      dialect: "postgres", db: "app", schema: "public", table: "users", original: [column("id")], columns: [column("id"), { ...column("ID"), originalName: null }],
    })).toThrow("Duplicate column name");
  });
});
