import { describe, expect, test } from "bun:test";
import { fuzzySearch } from "../src/lib/fuzzySearch";

describe("fuzzySearch", () => {
  test("returns the original order for an empty query", () => {
    expect(fuzzySearch(["orders", "users"], " ")).toEqual(["orders", "users"]);
  });

  test("ranks close and typo-tolerant matches", () => {
    expect(fuzzySearch(["audit_log", "customers", "customer_orders"], "custmer")).toEqual([
      "customers",
      "customer_orders",
    ]);
  });

  test("searches weighted object fields", () => {
    const connections = [
      { name: "Production", host: "db.internal" },
      { name: "Local", host: "production.test" },
    ];
    expect(fuzzySearch(connections, "production", {
      keys: [{ name: "name", weight: 2 }, "host"],
    })[0]).toBe(connections[0]);
  });
});
