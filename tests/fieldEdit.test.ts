import { describe, expect, test } from "bun:test";
import { isBooleanType, isNumericType, sizeForValue } from "../src/lib/fieldEdit";

describe("isNumericType", () => {
  test("matches integer and decimal spellings", () => {
    for (const t of ["int4", "integer", "bigint", "smallint", "tinyint", "int(11)", "numeric(10,2)", "decimal", "float8", "double precision", "real", "serial", "money"]) {
      expect(isNumericType(t)).toBe(true);
    }
  });
  test("rejects text-ish and interval types", () => {
    for (const t of ["text", "varchar(255)", "interval", "point", "jsonb", "bool", "timestamp"]) {
      expect(isNumericType(t)).toBe(false);
    }
  });
});

describe("isBooleanType", () => {
  test("matches bool, boolean and MySQL tinyint(1)", () => {
    expect(isBooleanType("bool")).toBe(true);
    expect(isBooleanType("boolean")).toBe(true);
    expect(isBooleanType("tinyint(1)")).toBe(true);
    expect(isBooleanType("tinyint(4)")).toBe(false);
    expect(isBooleanType("text")).toBe(false);
  });
});

describe("sizeForValue", () => {
  test("short plain text is small", () => {
    expect(sizeForValue("hello", "plaintext")).toBe("sm");
  });
  test("json is at least medium", () => {
    expect(sizeForValue("{}", "json")).toBe("md");
  });
  test("multi-line or long text grows", () => {
    expect(sizeForValue("a\nb\nc", "plaintext")).toBe("md");
    expect(sizeForValue("x".repeat(3000), "plaintext")).toBe("lg");
    expect(sizeForValue(Array(30).fill("line").join("\n"), "json")).toBe("lg");
  });
});
