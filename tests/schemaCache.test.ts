import { describe, expect, test } from "bun:test";
import { ConnectionSchemaCache } from "../src/lib/schemaCache";

describe("connection schema cache", () => {
  test("preserves table lists independently while switching connections", () => {
    const caches = new ConnectionSchemaCache<string>();
    const first = caches.forConnection("first", 0);
    first.set("app", new Map([["public", ["users"]]]));

    const second = caches.forConnection("second", 0);
    second.set("app", new Map([["public", ["orders"]]]));

    expect(caches.forConnection("first", 0).get("app")?.get("public")).toEqual(["users"]);
    expect(caches.forConnection("second", 0).get("app")?.get("public")).toEqual(["orders"]);
  });

  test("invalidates only the revised connection", () => {
    const caches = new ConnectionSchemaCache<string>();
    const original = caches.forConnection("first", 0);
    const other = caches.forConnection("second", 0);

    expect(caches.forConnection("first", 1)).not.toBe(original);
    expect(caches.forConnection("second", 0)).toBe(other);
  });
});
