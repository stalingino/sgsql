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

  test("fuzzy-matches relation and column typos", () => {
    const relationSql = "SELECT * FROM usres";
    const relationSuggestions = buildSqlCompletions({
      target: getCompletionTarget(relationSql, relationSql.length),
      catalog,
      references: [],
      columnsByTable: new Map(),
      defaultSchema: "public",
      dialect: "postgres",
    });
    expect(relationSuggestions[0]?.label).toBe("users");

    const reference = catalog[0];
    const columnSql = "SELECT nme FROM users";
    const columnSuggestions = buildSqlCompletions({
      target: getCompletionTarget(columnSql, 10),
      catalog,
      references: [reference],
      columnsByTable: new Map([
        [catalogTableKey(reference), [{ name: "name", dataType: "text" } as any]],
      ]),
      defaultSchema: "public",
      dialect: "postgres",
    });
    expect(columnSuggestions.map((item) => item.label)).toEqual(["name"]);
  });

  test("keeps direct table-name prefixes first with stable filter text", () => {
    const noisyCatalog: CatalogTable[] = [
      { db: "app", schema: "public", name: "axis_mel_guarantor_details", type: "table" },
      { db: "app", schema: "public", name: "migration_loan_accounts_backup", type: "table" },
      { db: "app", schema: "public", name: "global_settings", type: "table" },
      { db: "app", schema: "public", name: "customer_global_history", type: "table" },
    ];

    for (const prefix of ["g", "gl", "glo", "glob", "globa"]) {
      const sql = `SELECT * FROM ${prefix}`;
      const suggestions = buildSqlCompletions({
        target: getCompletionTarget(sql, sql.length),
        catalog: noisyCatalog,
        references: [],
        columnsByTable: new Map(),
        defaultSchema: "public",
        dialect: "postgres",
      });

      expect(suggestions[0]?.label).toBe("global_settings");
      expect(suggestions[0]?.filterText).toBe("global_settings");
    }
  });

  test("does not match table names merely because their schema matches", () => {
    const sql = "SELECT * FROM fin";
    const suggestions = buildSqlCompletions({
      target: getCompletionTarget(sql, sql.length),
      catalog: [
        { db: "app", schema: "financialForms", name: "unrelated_table", type: "table" },
        { db: "app", schema: "public", name: "financial_accounts", type: "table" },
      ],
      references: [],
      columnsByTable: new Map(),
      defaultSchema: "public",
      dialect: "postgres",
    });

    expect(suggestions.filter((item) => item.kind !== "schema").map((item) => item.label)).toEqual(["financial_accounts"]);
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
