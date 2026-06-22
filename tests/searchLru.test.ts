import { describe, expect, test } from "bun:test";
import { promoteSearchLru } from "../src/lib/searchLru";

describe("search LRU", () => {
  test("moves a reused item to the front without duplicates", () => {
    expect(promoteSearchLru(["table-a", "table-b", "table-c"], "table-b"))
      .toEqual(["table-b", "table-a", "table-c"]);
  });

  test("evicts the least recently used item at capacity", () => {
    expect(promoteSearchLru(["a", "b", "c"], "d", 3)).toEqual(["d", "a", "b"]);
  });
});
