import { describe, expect, test } from "bun:test";
import {
  buildSqlCompletions,
  catalogTableKey,
  findTableReferences,
  getCompletionTarget,
  quoteCompletionIdentifier,
  type CatalogTable,
} from "../src/lib/sqlAutocomplete";

const catalog: CatalogTable[] = [
  { db: "app", schema: "public", name: "users", type: "table" },
  { db: "app", schema: "audit", name: "users", type: "view" },
  { db: "app", schema: "public", name: "orders", type: "table" },
];

describe("SQL autocomplete", () => {
  test("offers schema-qualified PostgreSQL relations", () => {
    const sql = "SELECT * FROM us";
    const target = getCompletionTarget(sql, sql.length);
    const suggestions = buildSqlCompletions({
      target,
      catalog,
      references: [],
      columnsByTable: new Map(),
      defaultSchema: "public",
      dialect: "postgres",
    });

    expect(suggestions.map((item) => item.insertText)).toContain("users");
    expect(suggestions.map((item) => item.insertText)).toContain("audit.users");
  });

  test("resolves aliases and restricts qualified column suggestions", () => {
    const statement = "SELECT u.na FROM users AS u JOIN orders o ON o.user_id = u.id";
    const references = findTableReferences(statement, catalog, "public");
    const columnsByTable = new Map([
      [catalogTableKey(catalog[0]), [{ name: "name", dataType: "text" } as any]],
      [catalogTableKey(catalog[2]), [{ name: "number", dataType: "text" } as any]],
    ]);
    const cursor = statement.indexOf("u.na") + 4;
    const suggestions = buildSqlCompletions({
      target: getCompletionTarget(statement, cursor),
      catalog,
      references,
      columnsByTable,
      defaultSchema: "public",
      dialect: "postgres",
    });

    expect(references.map((reference) => reference.alias)).toEqual(["u", "o"]);
    expect(suggestions.map((item) => item.label)).toEqual(["name"]);
  });

  test("replaces the whole token and quotes reserved identifiers", () => {
    const sql = "SELECT * FROM users WHERE name";
    const nameStart = sql.indexOf("name");
    const target = getCompletionTarget(sql, nameStart + 2);
    expect(target.replaceEnd).toBe(nameStart + 4);
    expect(quoteCompletionIdentifier("order", "postgres")).toBe('"order"');
    expect(quoteCompletionIdentifier("order", "mysql")).toBe("`order`");
  });

  test("opens completion when explicitly forced at an empty prefix", () => {
    const sql = "SELECT * FROM ";
    const target = getCompletionTarget(sql, sql.length, true);

    expect(target.shouldOpen).toBe(true);
    expect(target.relationPosition).toBe(true);
  });

});
