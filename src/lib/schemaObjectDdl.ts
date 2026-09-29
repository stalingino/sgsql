import { quoteIdent } from "./schemaDdl";

export type DefinitionObjectType = "view" | "function";
export type DefinitionDialect = "postgres" | "mysql" | "sqlite" | "oracle";

interface DefinitionReplacement {
  ddl: string;
  type: DefinitionObjectType;
  dialect: DefinitionDialect;
  db: string;
  schema: string;
  name: string;
}

function qualifiedName({ dialect, db, schema, name }: Omit<DefinitionReplacement, "ddl" | "type">): string {
  if (dialect === "mysql") return `${quoteIdent(dialect, db)}.${quoteIdent(dialect, name)}`;
  if (dialect === "postgres") return `${quoteIdent(dialect, schema || "public")}.${quoteIdent(dialect, name)}`;
  if (dialect === "oracle" && schema) return `${quoteIdent(dialect, schema)}.${quoteIdent(dialect, name)}`;
  return quoteIdent(dialect, name);
}

/**
 * Oracle stored code ends each unit with a SQL*Plus `/` line, and a package
 * comes back as spec plus body in one text; each unit is its own statement.
 */
function oracleUnits(ddl: string): string[] {
  return ddl.split(/^\s*\/\s*$/m).map((unit) => unit.trim()).filter(Boolean);
}

function createOrReplace(ddl: string): string {
  if (/^\s*CREATE\s+OR\s+REPLACE\b/i.test(ddl)) return ddl;
  return ddl.replace(/^(\s*CREATE)\s+/i, "$1 OR REPLACE ");
}

/** Build the safest replacement sequence supported by each database. */
export function buildSchemaObjectReplacement(input: DefinitionReplacement): string[] {
  const ddl = input.ddl.trim();
  if (!ddl) return [];
  const ref = qualifiedName(input);

  if (input.dialect === "oracle") {
    if (/^CREATE\s+MATERIALIZED\s+VIEW\b/i.test(ddl)) return [`DROP MATERIALIZED VIEW ${ref}`, ddl];
    return oracleUnits(ddl).map(createOrReplace);
  }

  if (input.type === "view") {
    if (input.dialect === "sqlite") return [`DROP VIEW IF EXISTS ${ref}`, ddl];
    if (input.dialect === "postgres" && /^CREATE\s+MATERIALIZED\s+VIEW\b/i.test(ddl)) {
      return [`DROP MATERIALIZED VIEW IF EXISTS ${ref}`, ddl];
    }
    return [createOrReplace(ddl)];
  }

  if (input.dialect === "mysql") return [`DROP FUNCTION IF EXISTS ${ref}`, ddl];
  return [createOrReplace(ddl)];
}
