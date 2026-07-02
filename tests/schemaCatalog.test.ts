import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { closeConnection, setConnection } from "../sidecar/lib/pool";
import { handleSchemaRequest } from "../sidecar/routes/schema";

const connectionIds: string[] = [];

afterEach(async () => {
  while (connectionIds.length) await closeConnection(connectionIds.pop()!);
});

describe("search catalog route", () => {
  test("returns all SQLite relations in one catalog request", async () => {
    const id = `catalog-test-${crypto.randomUUID()}`;
    const client = new Database(":memory:");
    client.run("CREATE TABLE users (id INTEGER PRIMARY KEY)");
    client.run("CREATE VIEW active_users AS SELECT * FROM users");
    setConnection(id, { type: "sqlite", client }, { id, name: id, type: "sqlite", database: ":memory:" } as any);
    connectionIds.push(id);

    const request = new Request(`http://localhost/schema/${id}/catalog?db=main`);
    const response = await handleSchemaRequest(request, `/schema/${id}/catalog`, {});
    const result = await response.json() as any;

    expect(response.status).toBe(200);
    expect(result.databases).toEqual(["main"]);
    expect(result.tables).toEqual([
      { db: "main", schema: "main", name: "active_users", type: "VIEW" },
      { db: "main", schema: "main", name: "users", type: "BASE TABLE" },
    ]);
  });
});
