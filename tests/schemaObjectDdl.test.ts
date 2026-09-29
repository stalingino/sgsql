import { describe, expect, test } from "bun:test";
import { buildSchemaObjectReplacement } from "../src/lib/schemaObjectDdl";

describe("schema object definition replacement", () => {
  test("uses CREATE OR REPLACE for regular Postgres views", () => {
    expect(buildSchemaObjectReplacement({
      ddl: 'CREATE VIEW "public"."active_users" AS SELECT 1;',
      type: "view",
      dialect: "postgres",
      db: "app",
      schema: "public",
      name: "active_users",
    })).toEqual(['CREATE OR REPLACE VIEW "public"."active_users" AS SELECT 1;']);
  });

  test("recreates SQLite views inside the apply transaction", () => {
    expect(buildSchemaObjectReplacement({
      ddl: "CREATE VIEW active_users AS SELECT 1;",
      type: "view",
      dialect: "sqlite",
      db: "main",
      schema: "main",
      name: "active_users",
    })).toEqual(['DROP VIEW IF EXISTS "active_users"', "CREATE VIEW active_users AS SELECT 1;"]);
  });

  test("recreates MySQL functions with qualified identifiers", () => {
    expect(buildSchemaObjectReplacement({
      ddl: "CREATE FUNCTION total() RETURNS INT RETURN 1;",
      type: "function",
      dialect: "mysql",
      db: "sales",
      schema: "",
      name: "total",
    })).toEqual(["DROP FUNCTION IF EXISTS `sales`.`total`", "CREATE FUNCTION total() RETURNS INT RETURN 1;"]);
  });

  test("does not duplicate OR REPLACE", () => {
    const ddl = "CREATE OR REPLACE FUNCTION public.total() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;";
    expect(buildSchemaObjectReplacement({
      ddl,
      type: "function",
      dialect: "postgres",
      db: "app",
      schema: "public",
      name: "total",
    })).toEqual([ddl]);
  });

  test("splits Oracle package spec and body at SQL*Plus terminators", () => {
    const ddl = 'CREATE OR REPLACE EDITIONABLE PACKAGE "APP"."PKG" AS FUNCTION f RETURN NUMBER; END;\n/\n  CREATE OR REPLACE EDITIONABLE PACKAGE BODY "APP"."PKG" AS FUNCTION f RETURN NUMBER IS BEGIN RETURN 1; END; END;\n/';
    expect(buildSchemaObjectReplacement({ ddl, type: "function", dialect: "oracle", db: "FREEPDB1", schema: "APP", name: "PKG" })).toEqual([
      'CREATE OR REPLACE EDITIONABLE PACKAGE "APP"."PKG" AS FUNCTION f RETURN NUMBER; END;',
      'CREATE OR REPLACE EDITIONABLE PACKAGE BODY "APP"."PKG" AS FUNCTION f RETURN NUMBER IS BEGIN RETURN 1; END; END;',
    ]);
  });

  test("keeps Oracle views as CREATE OR REPLACE and recreates materialized views", () => {
    expect(buildSchemaObjectReplacement({ ddl: 'CREATE VIEW "APP"."V" AS SELECT 1 FROM dual', type: "view", dialect: "oracle", db: "FREEPDB1", schema: "APP", name: "V" }))
      .toEqual(['CREATE OR REPLACE VIEW "APP"."V" AS SELECT 1 FROM dual']);
    expect(buildSchemaObjectReplacement({ ddl: 'CREATE MATERIALIZED VIEW "APP"."MV" AS SELECT 1 FROM dual', type: "view", dialect: "oracle", db: "FREEPDB1", schema: "APP", name: "MV" }))
      .toEqual(['DROP MATERIALIZED VIEW "APP"."MV"', 'CREATE MATERIALIZED VIEW "APP"."MV" AS SELECT 1 FROM dual']);
  });
});
