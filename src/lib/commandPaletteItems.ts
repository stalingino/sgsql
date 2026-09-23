import type { CatalogInfo } from "./schema";

export interface PaletteItem {
  kind: "db" | "table" | "view";
  db: string;
  schema: string;
  name: string;
  score: number;
}

type ConnectionType = "postgres" | "mysql" | "sqlite";

const MYSQL_MANAGEMENT_DATABASES = new Set(["information_schema", "mysql", "performance_schema", "sys"]);

export function isManagementDatabase(type: ConnectionType, db: string): boolean {
  return type === "mysql" && MYSQL_MANAGEMENT_DATABASES.has(db.toLowerCase());
}

function defaultSchema(type: ConnectionType): string {
  if (type === "postgres") return "public";
  if (type === "sqlite") return "main";
  return "";
}

export function paletteItems(
  catalog: CatalogInfo,
  connectionType: ConnectionType,
  preferredDb: string,
): PaletteItem[] {
  const items: PaletteItem[] = [...catalog.databases]
    .sort((a, b) => Number(isManagementDatabase(connectionType, a)) - Number(isManagementDatabase(connectionType, b)))
    .map((db) => ({ kind: "db", db, schema: "", name: db, score: 0 }));

  const orderedTables = [...catalog.tables]
    .filter((table) => !isManagementDatabase(connectionType, table.db) || table.db === preferredDb)
    .sort((a, b) => {
      if ((a.db === preferredDb) !== (b.db === preferredDb)) return a.db === preferredDb ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  for (const table of orderedTables) {
    items.push({
      kind: table.type === "view" ? "view" : "table",
      db: table.db,
      schema: table.schema || defaultSchema(connectionType),
      name: table.name,
      score: 0,
    });
  }
  return items;
}
