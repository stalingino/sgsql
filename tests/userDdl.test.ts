import { describe, expect, test } from "bun:test";
import {
  accountRef,
  attributesOf,
  buildAccountChanges,
  buildDropAccount,
  buildGrantDiff,
  buildRoleDiff,
  emptyGrants,
  maskPasswords,
  type AccountDraft,
  type EditableGrants,
} from "../src/lib/userDdl";

function draft(overrides: Partial<AccountDraft> = {}): AccountDraft {
  return {
    name: "app",
    host: "%",
    password: "",
    attrs: attributesOf(null, "mysql"),
    roles: [],
    grants: emptyGrants(),
    ...overrides,
  };
}

describe("userDdl", () => {
  test("account references are quoted per dialect", () => {
    expect(accountRef("mysql", "it's", "10.0.%")).toBe("'it\\'s'@'10.0.%'");
    expect(accountRef("postgres", 'we"ird')).toBe('"we""ird"');
  });

  test("creates a MySQL user with password, limit and lock, then grants", () => {
    const statements = buildAccountChanges("mysql", null, draft({
      password: "s3cret",
      attrs: { ...attributesOf(null, "mysql"), connLimit: 5, locked: true },
      roles: ["reader"],
      grants: {
        ...emptyGrants(),
        databases: [{ db: "cams", privileges: ["SELECT", "INSERT"], withGrant: false }],
        tables: [{ db: "cams", schema: "", table: "audit", privileges: ["SELECT"], withGrant: true }],
      },
    }));
    expect(statements).toEqual([
      "CREATE USER 'app'@'%' IDENTIFIED BY 's3cret' WITH MAX_USER_CONNECTIONS 5 ACCOUNT LOCK",
      "GRANT 'reader'@'%' TO 'app'@'%'",
      "GRANT SELECT, INSERT ON `cams`.* TO 'app'@'%'",
      "GRANT SELECT ON `cams`.`audit` TO 'app'@'%' WITH GRANT OPTION",
    ]);
  });

  test("creates a Postgres login role spelling out only non-default options", () => {
    const statements = buildAccountChanges("postgres", null, draft({
      password: "pw",
      attrs: { ...attributesOf(null, "postgres"), canLogin: true, createDb: true, connLimit: 10 },
      grants: {
        ...emptyGrants(),
        databases: [{ db: "shop", privileges: ["CONNECT"], withGrant: false }],
        schemas: [{ db: "shop", schema: "public", privileges: ["USAGE"], withGrant: false }],
        tables: [{ db: "shop", schema: "public", table: "orders", privileges: ["SELECT", "UPDATE"], withGrant: false }],
      },
    }));
    expect(statements).toEqual([
      "CREATE ROLE \"app\" LOGIN CREATEDB CONNECTION LIMIT 10 PASSWORD 'pw'",
      "GRANT CONNECT ON DATABASE \"shop\" TO \"app\"",
      "GRANT USAGE ON SCHEMA \"public\" TO \"app\"",
      "GRANT SELECT, UPDATE ON TABLE \"public\".\"orders\" TO \"app\"",
    ]);
  });

  test("grant diff emits only the delta and handles the grant option", () => {
    const before: EditableGrants = {
      global: { privileges: ["PROCESS"], withGrant: false },
      databases: [
        { db: "cams", privileges: ["SELECT", "INSERT", "UPDATE"], withGrant: false },
        { db: "old", privileges: ["SELECT"], withGrant: true },
      ],
      schemas: [],
      tables: [],
    };
    const after: EditableGrants = {
      global: { privileges: [], withGrant: false },
      databases: [
        { db: "cams", privileges: ["SELECT", "DELETE"], withGrant: true },
        { db: "old", privileges: ["SELECT"], withGrant: false },
        { db: "new", privileges: ["SELECT"], withGrant: false },
      ],
      schemas: [],
      tables: [],
    };
    expect(buildGrantDiff("mysql", "'app'@'%'", before, after)).toEqual([
      "REVOKE PROCESS ON *.* FROM 'app'@'%'",
      "REVOKE INSERT, UPDATE ON `cams`.* FROM 'app'@'%'",
      "GRANT SELECT, DELETE ON `cams`.* TO 'app'@'%' WITH GRANT OPTION",
      "REVOKE GRANT OPTION ON `old`.* FROM 'app'@'%'",
      "GRANT SELECT ON `new`.* TO 'app'@'%'",
    ]);
  });

  test("postgres revokes the grant option per privilege", () => {
    const before: EditableGrants = { ...emptyGrants(), tables: [{ db: "d", schema: "public", table: "t", privileges: ["SELECT"], withGrant: true }] };
    const after: EditableGrants = { ...emptyGrants(), tables: [{ db: "d", schema: "public", table: "t", privileges: ["SELECT"], withGrant: false }] };
    expect(buildGrantDiff("postgres", '"r"', before, after)).toEqual([
      'REVOKE GRANT OPTION FOR SELECT ON TABLE "public"."t" FROM "r"',
    ]);
  });

  test("unchanged drafts produce no statements", () => {
    const before = draft({ roles: ["a"], grants: { ...emptyGrants(), databases: [{ db: "x", privileges: ["SELECT"], withGrant: false }] } });
    const after = draft({ roles: ["a"], grants: { ...emptyGrants(), databases: [{ db: "x", privileges: ["SELECT"], withGrant: false }] } });
    expect(buildAccountChanges("mysql", before, after)).toEqual([]);
  });

  test("edits alter attributes, password and roles", () => {
    const before = draft({ attrs: attributesOf({ name: "r", canLogin: true, superuser: false, locked: false, roles: [] }, "postgres"), roles: ["a", "b"] });
    const after = draft({
      password: "new",
      attrs: { ...before.attrs, locked: true, createRole: true, validUntil: "2030-01-01" },
      roles: ["b", "c"],
    });
    expect(buildAccountChanges("postgres", before, after)).toEqual([
      "ALTER ROLE \"app\" NOLOGIN CREATEROLE VALID UNTIL '2030-01-01'",
      "ALTER ROLE \"app\" PASSWORD 'new'",
      "GRANT \"c\" TO \"app\"",
      "REVOKE \"a\" FROM \"app\"",
    ]);
  });

  test("mysql lock and role grants", () => {
    const before = draft();
    const after = draft({ attrs: { ...before.attrs, locked: true }, roles: ["reader@localhost"] });
    expect(buildAccountChanges("mysql", before, after)).toEqual([
      "ALTER USER 'app'@'%' ACCOUNT LOCK",
      "GRANT 'reader'@'localhost' TO 'app'@'%'",
    ]);
    expect(buildRoleDiff("mysql", "'app'@'%'", ["x"], [])).toEqual(["REVOKE 'x'@'%' FROM 'app'@'%'"]);
  });

  test("drops with optional ownership reassignment", () => {
    expect(buildDropAccount("mysql", "'app'@'%'")).toEqual(["DROP USER 'app'@'%'"]);
    expect(buildDropAccount("postgres", '"app"', { reassignTo: "owner" })).toEqual([
      'REASSIGN OWNED BY "app" TO "owner"',
      'DROP OWNED BY "app"',
      'DROP ROLE "app"',
    ]);
  });

  test("masks passwords for review", () => {
    expect(maskPasswords([
      "CREATE USER 'a'@'%' IDENTIFIED BY 'it\\'s' ACCOUNT LOCK",
      "ALTER ROLE \"a\" PASSWORD 'x''y' LOGIN",
    ])).toEqual([
      "CREATE USER 'a'@'%' IDENTIFIED BY '••••••••' ACCOUNT LOCK",
      "ALTER ROLE \"a\" PASSWORD '••••••••' LOGIN",
    ]);
  });
});
