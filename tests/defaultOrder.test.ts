import { describe, expect, test } from "bun:test";
import { parseDefaultOrderBy } from "../src/lib/defaultOrder";

describe("default table ordering", () => {
  test("uses id descending when the setting has not been stored", () => {
    expect(parseDefaultOrderBy(undefined)).toEqual({ column: "id", dir: "DESC" });
  });

  test("uses the configured column and direction", () => {
    expect(parseDefaultOrderBy("created_at ASC")).toEqual({ column: "created_at", dir: "ASC" });
  });

  test("keeps an explicitly empty setting as no default ordering", () => {
    expect(parseDefaultOrderBy("  ")).toBeNull();
  });
});
