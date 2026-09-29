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

describe("Oracle statement splitting", () => {
  const texts = (sql: string) => splitSqlStatements(sql, "oracle").map((statement) => statement.text);

  test("keeps PL/SQL blocks whole and splits at slash lines", () => {
    const sql = "BEGIN\n  UPDATE t SET a = 1;\n  COMMIT;\nEND;\n/\nSELECT * FROM t;\n";
    expect(texts(sql)).toEqual(["BEGIN\n  UPDATE t SET a = 1;\n  COMMIT;\nEND;", "SELECT * FROM t;"]);
  });

  test("ends an anonymous block at its closing END without a slash", () => {
    const sql = "DECLARE n NUMBER; BEGIN IF 1 = 1 THEN n := CASE WHEN 1 = 1 THEN 1 END; END IF; LOOP EXIT; END LOOP; END;\nSELECT 1 FROM dual;";
    expect(texts(sql)).toEqual([
      "DECLARE n NUMBER; BEGIN IF 1 = 1 THEN n := CASE WHEN 1 = 1 THEN 1 END; END IF; LOOP EXIT; END LOOP; END;",
      "SELECT 1 FROM dual;",
    ]);
  });

  test("keeps procedures, triggers and packages whole", () => {
    const sql = [
      "CREATE OR REPLACE PROCEDURE p AS c NUMBER := CASE WHEN 1 = 1 THEN 1 END; BEGIN NULL; END;",
      "CREATE OR REPLACE TRIGGER trg BEFORE INSERT ON t FOR EACH ROW BEGIN :NEW.a := 1; END;",
      "CREATE PACKAGE pkg AS PROCEDURE p; FUNCTION f RETURN NUMBER; END pkg;\n/",
      "SELECT 2 FROM dual",
    ].join("\n");
    expect(texts(sql)).toEqual([
      "CREATE OR REPLACE PROCEDURE p AS c NUMBER := CASE WHEN 1 = 1 THEN 1 END; BEGIN NULL; END;",
      "CREATE OR REPLACE TRIGGER trg BEFORE INSERT ON t FOR EACH ROW BEGIN :NEW.a := 1; END;",
      "CREATE PACKAGE pkg AS PROCEDURE p; FUNCTION f RETURN NUMBER; END pkg;",
      "SELECT 2 FROM dual",
    ]);
  });

  test("understands q-quotes, backslashes and division", () => {
    expect(texts("SELECT q'[it's; here]' FROM dual; SELECT 'C:\\' FROM dual; SELECT 4 / 2 FROM dual")).toEqual([
      "SELECT q'[it's; here]' FROM dual;",
      "SELECT 'C:\\' FROM dual;",
      "SELECT 4 / 2 FROM dual",
    ]);
  });

  test("other dialects are unchanged", () => {
    expect(splitSqlStatements("BEGIN; SELECT 1; COMMIT;").map((statement) => statement.text)).toEqual(["BEGIN;", "SELECT 1;", "COMMIT;"]);
  });

  test("limits rows with FETCH FIRST", () => {
    expect(applyRowLimit("SELECT * FROM t;", 100, "oracle")).toBe("SELECT * FROM t FETCH FIRST 100 ROWS ONLY");
    expect(applyRowLimit("SELECT * FROM t WHERE ROWNUM <= 5", 100, "oracle")).toBe("SELECT * FROM t WHERE ROWNUM <= 5");
    expect(applyRowLimit("SELECT * FROM t OFFSET 5 ROWS FETCH NEXT 5 ROWS ONLY", 100, "oracle")).toBe("SELECT * FROM t OFFSET 5 ROWS FETCH NEXT 5 ROWS ONLY");
  });
});
