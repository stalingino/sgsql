import { describe, expect, test } from "bun:test";
import { RevisionPromiseCache } from "../src/lib/commandPaletteCache";
import { paletteItems } from "../src/lib/commandPaletteItems";
import { fuzzySearch } from "../src/lib/fuzzySearch";
import type { CatalogInfo } from "../src/lib/schema";

describe("command palette catalog cache", () => {
  test("deduplicates mounts until the schema revision changes", async () => {
    const cache = new RevisionPromiseCache<string[]>();
    let loads = 0;
    const load = async () => { loads += 1; return ["users"]; };

    const first = cache.get("connection", 0, load);
    const second = cache.get("connection", 0, load);
    expect(second).toBe(first);
    expect(await second).toEqual(["users"]);
    expect(loads).toBe(1);
    expect(cache.peek("connection", 0)).toEqual(["users"]);

    expect(await cache.get("connection", 1, load)).toEqual(["users"]);
    expect(loads).toBe(2);
    expect(cache.peek("connection", 0)).toBeUndefined();
  });
});

describe("command palette ranking", () => {
  test("prefers full prefixes, then matches landing on a word boundary", () => {
    // "audit_users" lands "user" right after a separator (a real word), so it
    // outranks "xuser" where "user" is just a coincidental tail substring.
    const names = ["audit_users", "user_archive", "xuser", "users"];
    expect(fuzzySearch(names, "user")).toEqual([
      "users",
      "user_archive",
      "audit_users",
      "xuser",
    ]);
  });

  test("prefers the shortest name within the same match class", () => {
    const names = ["accounts_archive", "account", "accounts"];
    expect(fuzzySearch(names, "acc")).toEqual([
      "account",
      "accounts",
      "accounts_archive",
    ]);
  });
});

describe("MySQL management databases in the command palette", () => {
  const catalog: CatalogInfo = {
    databases: ["mysql", "app", "information_schema", "analytics", "performance_schema", "sys"],
    tables: [
      { db: "app", schema: "", name: "users", type: "table" },
      { db: "mysql", schema: "", name: "user", type: "table" },
      { db: "information_schema", schema: "", name: "TABLES", type: "view" },
      { db: "performance_schema", schema: "", name: "threads", type: "table" },
      { db: "sys", schema: "", name: "version", type: "view" },
    ],
  };

  test("lists management databases after regular databases", () => {
    const dbs = paletteItems({ ...catalog, tables: [] }, "mysql", "app")
      .filter((item) => item.kind === "db")
      .map((item) => item.db);
    expect(dbs).toEqual(["app", "analytics", "mysql", "information_schema", "performance_schema", "sys"]);
  });

  test("hides management tables while a regular database is selected", () => {
    const tables = paletteItems(catalog, "mysql", "app").filter((item) => item.kind !== "db");
    expect(tables.map((item) => `${item.db}.${item.name}`)).toEqual(["app.users"]);
  });

  test("shows only the selected management database's tables", () => {
    const tables = paletteItems(catalog, "mysql", "information_schema")
      .filter((item) => item.kind !== "db");
    expect(tables.map((item) => `${item.db}.${item.name}`)).toEqual(["information_schema.TABLES", "app.users"]);
  });
});
