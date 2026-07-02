import { describe, expect, test } from "bun:test";
import { comparePaletteNames, RevisionPromiseCache } from "../src/lib/commandPaletteCache";

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
  test("prefers full prefixes, then first-letter matches", () => {
    const names = ["audit_users", "user_archive", "xuser", "users"];
    expect(names.sort((a, b) => comparePaletteNames(a, b, "user"))).toEqual([
      "users",
      "user_archive",
      "xuser",
      "audit_users",
    ]);
  });

  test("prefers the shortest name within the same match class", () => {
    const names = ["accounts_archive", "account", "accounts"];
    expect(names.sort((a, b) => comparePaletteNames(a, b, "acc"))).toEqual([
      "account",
      "accounts",
      "accounts_archive",
    ]);
  });
});
