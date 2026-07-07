import { describe, expect, test } from "bun:test";
import { RevisionPromiseCache } from "../src/lib/commandPaletteCache";
import { fuzzySearch } from "../src/lib/fuzzySearch";

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
