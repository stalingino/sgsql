import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { ServerWebSocket } from "bun";
import { clearQueryLog, subscribeQueryLog, unsubscribeQueryLog, type QueryLogSocketData } from "../sidecar/lib/queryLogHub";
import { instrumentConnection } from "../sidecar/lib/queryTrace";

describe("sidecar query trace", () => {
  const messages: string[] = [];
  const socket = { send: (message: string) => { messages.push(message); } } as unknown as ServerWebSocket<QueryLogSocketData>;

  beforeEach(() => {
    clearQueryLog();
    messages.length = 0;
    subscribeQueryLog(socket);
  });

  afterEach(() => unsubscribeQueryLog(socket));

  test("streams each SQLite driver execution and retains it for snapshots", () => {
    const entry = instrumentConnection("connection-1", "sample.db", { type: "sqlite", client: new Database(":memory:") });
    if (entry.type !== "sqlite") throw new Error("Unexpected connection type");

    entry.client.run("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
    entry.client.query("INSERT INTO users (name) VALUES (?)").run("Ada");
    entry.client.query("SELECT * FROM users").all();
    entry.client.close();

    const streamed = messages
      .map((message) => JSON.parse(message))
      .filter((message) => message.type === "entry")
      .map((message) => message.entry);
    expect(streamed.map((item) => item.query)).toEqual([
      "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)",
      "INSERT INTO users (name) VALUES (?)",
      "SELECT * FROM users",
    ]);
    expect(streamed[2]).toMatchObject({ connectionId: "connection-1", db: "sample.db", rowCount: 1 });

    const snapshotMessages: string[] = [];
    const snapshotSocket = { send: (message: string) => { snapshotMessages.push(message); } } as unknown as ServerWebSocket<QueryLogSocketData>;
    subscribeQueryLog(snapshotSocket);
    expect(JSON.parse(snapshotMessages[0]).entries).toHaveLength(3);
    unsubscribeQueryLog(snapshotSocket);
  });
});
