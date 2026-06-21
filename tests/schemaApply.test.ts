import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { handleSchemaApply } from "../sidecar/routes/schema";
import { closeConnection, setConnection } from "../sidecar/lib/pool";

const connectionIds: string[] = [];

function connection() {
  const id = `schema-test-${crypto.randomUUID()}`;
  const client = new Database(":memory:");
  setConnection(id, { type: "sqlite", client }, { id, name: id, type: "sqlite", database: ":memory:" } as any);
  connectionIds.push(id);
  return { id, client };
}

afterEach(async () => {
  while (connectionIds.length) await closeConnection(connectionIds.pop()!);
});

describe("schema apply route", () => {
  test("commits a valid SQLite schema batch atomically", async () => {
    const { id, client } = connection();
    const request = new Request(`http://localhost/schema/${id}/apply`, { method: "POST", body: JSON.stringify({ statements: ["CREATE TABLE items (id INTEGER PRIMARY KEY)", "CREATE INDEX items_id_idx ON items(id)"] }) });
    const response = await handleSchemaApply(request, `/schema/${id}/apply`, {});
    expect(response.status).toBe(200);
    expect((await response.json() as any).atomic).toBe(true);
    expect(client.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'items'").get()).toBeTruthy();
  });

  test("rolls back the whole SQLite batch when a statement fails", async () => {
    const { id, client } = connection();
    const request = new Request(`http://localhost/schema/${id}/apply`, { method: "POST", body: JSON.stringify({ statements: ["CREATE TABLE doomed (id INTEGER)", "INVALID DDL"] }) });
    const response = await handleSchemaApply(request, `/schema/${id}/apply`, {});
    expect(response.status).toBe(500);
    expect(client.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'doomed'").get()).toBeNull();
  });
});
