import { describe, expect, test } from "bun:test";
import { exportTableReference, finishExport, serializeExport, serializeExportChunk } from "../src/lib/dataExport";

const base = { columns: ["id", "display name"], dialect: "postgres" as const, table: "people", schema: "public" };

describe("data export", () => {
  test("streams valid JSON across chunks", () => {
    const text = serializeExportChunk({ ...base, format: "json", rows: [[1, "Ada"]], first: true })
      + serializeExportChunk({ ...base, format: "json", rows: [[2, "Lin"]], first: false })
      + finishExport("json", true);
    expect(JSON.parse(text)).toEqual([{ id: 1, "display name": "Ada" }, { id: 2, "display name": "Lin" }]);
  });

  test("writes a valid empty JSON array", () => {
    const text = serializeExportChunk({ ...base, format: "json", rows: [], first: true })
      + finishExport("json", false);
    expect(JSON.parse(text)).toEqual([]);
  });

  test("serializes a complete copy payload", () => {
    const text = serializeExport({ ...base, format: "json", rows: [[1, "Ada"]] });
    expect(JSON.parse(text)).toEqual([{ id: 1, "display name": "Ada" }]);
  });

  test("escapes CSV and emits a header once", () => {
    const text = serializeExportChunk({ ...base, format: "csv", rows: [[1, "A, B"], [2, 'A "B"']], first: true });
    expect(text).toBe('id,display name\n1,"A, B"\n2,"A ""B"""\n');
  });

  test("writes NDJSON", () => {
    const text = serializeExportChunk({ ...base, format: "ndjson", rows: [[1, "Ada"]], first: true });
    expect(JSON.parse(text.trim())).toEqual({ id: 1, "display name": "Ada" });
  });

  test("uses dialect-aware qualified INSERT identifiers", () => {
    expect(exportTableReference("postgres", "db", "odd schema", "people")).toBe('"odd schema"."people"');
    expect(exportTableReference("mysql", "app-db", "", "people")).toBe('`app-db`.`people`');
    const text = serializeExportChunk({ ...base, format: "sql", rows: [[1, "O'Brien"]], first: true });
    expect(text).toContain('INSERT INTO "public"."people" ("id", "display name")');
    expect(text).toContain("'O''Brien'");
  });

  test("escapes MySQL identifiers and serializes non-finite numbers as NULL", () => {
    const text = serializeExportChunk({
      columns: ["odd`column", "value"],
      dialect: "mysql",
      database: "app`db",
      table: "items`archive",
      format: "sql",
      rows: [[1, Number.NaN]],
      first: true,
    });
    expect(text).toContain("INSERT INTO `app``db`.`items``archive` (`odd``column`, `value`)");
    expect(text).toContain("(1, NULL)");
  });
});
