import { describe, expect, test } from "bun:test";
import { fuzzyMatch, fuzzySearch, matchSegments } from "../src/lib/fuzzySearch";

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

  test("prefers word/camelCase-boundary hits over a same-length scattered match", () => {
    // Same letters, same gaps, same overall length - only difference is that
    // "con-ma..." lands "ma" right after a separator while "xxxconxxxma..." doesn't.
    const names = ["xxxconxxxmaxxx", "con-maxxxxxxxx"];
    expect(fuzzySearch(names, "conma")).toEqual(["con-maxxxxxxxx", "xxxconxxxmaxxx"]);
  });

  test("prefers a shorter target when both match equally tightly", () => {
    expect(fuzzySearch(["connection-manager-window", "connection-manager"], "conman")).toEqual([
      "connection-manager",
      "connection-manager-window",
    ]);
  });

  test("still ranks a plain prefix match first", () => {
    expect(fuzzySearch(["userGroups", "user"], "user")).toEqual(["user", "userGroups"]);
  });
});

describe("fuzzyMatch", () => {
  test("returns null when query is not a subsequence", () => {
    expect(fuzzyMatch("orders", "xyz")).toBeNull();
  });

  test("returns matched indices for highlighting", () => {
    expect(fuzzyMatch("connection-manager", "conma")?.indices).toEqual([0, 1, 2, 11, 12]);
  });
});

describe("matchSegments", () => {
  test("splits text into matched/unmatched runs", () => {
    expect(matchSegments("connection-manager", [0, 1, 2, 11, 12])).toEqual([
      { text: "con", matched: true },
      { text: "nection-", matched: false },
      { text: "ma", matched: true },
      { text: "nager", matched: false },
    ]);
  });

  test("returns a single unmatched segment when there are no indices", () => {
    expect(matchSegments("orders", [])).toEqual([{ text: "orders", matched: false }]);
  });
});
