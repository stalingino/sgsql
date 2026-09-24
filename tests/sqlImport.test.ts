import { describe, expect, test } from "bun:test";
import { prepareSqlImport } from "../src/lib/sqlImport";

describe("SQL dump import", () => {
  test("removes dump transaction wrappers so SGSql can own the outer transaction", () => {
    expect(prepareSqlImport(`
      -- generated dump
      BEGIN;
      CREATE TABLE people (id integer primary key);
      INSERT INTO people VALUES (1);
      COMMIT;
    `, "postgres")).toEqual([
      "CREATE TABLE people (id integer primary key);",
      "INSERT INTO people VALUES (1);",
    ]);
  });

  test("preserves semicolons inside strings and PostgreSQL dollar quotes", () => {
    expect(prepareSqlImport(`
      INSERT INTO notes VALUES ('one;two');
      CREATE FUNCTION answer() RETURNS int AS $$ BEGIN RETURN 42; END $$ LANGUAGE plpgsql;
    `, "postgres")).toHaveLength(2);
  });

  test("keeps MySQL DELIMITER routines intact and removes the client directives", () => {
    const statements = prepareSqlImport(`
      DELIMITER $$
      CREATE PROCEDURE execute_db(IN db_name varchar(64))
      BEGIN
        SET @statement = CONCAT('TRUNCATE TABLE ', db_name, '.items');
        PREPARE stmt1 FROM @statement;
        EXECUTE stmt1;
        DEALLOCATE PREPARE stmt1;
      END$$
      DELIMITER ;
      CALL execute_db('financialForms');
    `, "mysql");

    expect(statements).toHaveLength(2);
    expect(statements[0]).toStartWith("CREATE PROCEDURE execute_db");
    expect(statements[0]).toContain("DEALLOCATE PREPARE stmt1;");
    expect(statements[0]).not.toContain("DELIMITER");
    expect(statements[1]).toBe("CALL execute_db('financialForms')");
  });

  test("does not impose the regular query runner's statement cap", () => {
    const dump = Array.from({ length: 782 }, (_, index) => `INSERT INTO items VALUES (${index});`).join("\n");
    expect(prepareSqlImport(dump, "mysql")).toHaveLength(782);
  });

  test("rejects empty imports", () => {
    expect(() => prepareSqlImport("-- comments only", "sqlite")).toThrow("non-empty SQL dump");
  });
});
