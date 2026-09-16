import { describe, expect, test } from "bun:test";
import { applyRowLimit, findSqlVariables, splitSqlStatements, statementAtCursor, statementReturnsRows, substituteSqlVariables, sqlErrorMarker } from "../src/lib/sqlStatements";

describe("SQL statements", () => {
  test("does not split quoted, commented, or dollar-quoted semicolons", () => {
    const sql = "SELECT ';' AS x; -- ;\nSELECT $$a;b$$; /* ; */ SELECT 3;";
    expect(splitSqlStatements(sql).map((item) => item.text)).toEqual([
      "SELECT ';' AS x;",
      "-- ;\nSELECT $$a;b$$;",
      "/* ; */ SELECT 3;",
    ]);
  });

  test("finds the statement at the cursor", () => {
    const sql = "SELECT 1;\nSELECT 2;";
    expect(statementAtCursor(sql, sql.indexOf("2"))?.text).toBe("SELECT 2;");
    expect(statementAtCursor(sql, sql.indexOf(";") + 1)?.text).toBe("SELECT 1;");
  });

  test("classifies CTE and RETURNING results", () => {
    expect(statementReturnsRows("WITH x AS (SELECT 1) SELECT * FROM x")).toBe(true);
    expect(statementReturnsRows("WITH x AS (SELECT 1) UPDATE t SET a=1")).toBe(false);
    expect(statementReturnsRows("UPDATE t SET a=1 RETURNING *")).toBe(true);
    expect(statementReturnsRows("PRAGMA table_info(t)")).toBe(true);
  });

  test("adds only a top-level row limit", () => {
    expect(applyRowLimit("WITH x AS (SELECT * FROM t LIMIT 2) SELECT * FROM x;", 50)).toBe("WITH x AS (SELECT * FROM t LIMIT 2) SELECT * FROM x LIMIT 50");
    expect(applyRowLimit("SELECT * FROM t LIMIT 10", 50)).toBe("SELECT * FROM t LIMIT 10");
    expect(applyRowLimit("UPDATE t SET a=1", 50)).toBe("UPDATE t SET a=1");
    expect(applyRowLimit("UPDATE t SET a=1 RETURNING *", 50)).toBe("UPDATE t SET a=1 RETURNING *");
  });

  test("finds and substitutes variables outside strings and comments", () => {
    const sql = "SELECT * FROM t WHERE id={{ id }} AND name={{name}} ORDER BY {{order:raw}} -- {{ignored}}";
    expect(findSqlVariables(sql).map(({ name, raw }) => ({ name, raw }))).toEqual([
      { name: "id", raw: false }, { name: "name", raw: false }, { name: "order", raw: true },
    ]);
    expect(substituteSqlVariables(sql, { id: "42", name: "O'Brien", order: "created_at DESC" }))
      .toContain("id=42 AND name='O''Brien' ORDER BY created_at DESC");
  });

  test("maps server positions back into the editor", () => {
    const statement = { text: "SELECT bad", start: 20, end: 30 };
    expect(sqlErrorMarker("syntax error at position: 8", statement)).toMatchObject({ start: 27, end: 28 });
  });
});
