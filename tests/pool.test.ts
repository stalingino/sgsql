import { describe, expect, test } from "bun:test";
import { closeConnection, getConnection, setConnection } from "../sidecar/lib/pool";
import type { ConnectionProfile } from "../sidecar/lib/types";

const profile = { id: "same-connection" } as ConnectionProfile;

describe("connection pool lifecycle", () => {
  test("closing an old client does not remove a replacement with the same id", async () => {
    let finishClosing!: () => void;
    const closing = new Promise<void>((resolve) => { finishClosing = resolve; });
    const oldClient = { type: "postgres", client: { end: () => closing } } as const;
    const replacement = { type: "postgres", client: { end: async () => {} } } as const;

    setConnection(profile.id, oldClient as never, profile);
    const closeOld = closeConnection(profile.id);
    setConnection(profile.id, replacement as never, profile);

    finishClosing();
    await closeOld;

    expect(getConnection(profile.id)).toBe(replacement);
    await closeConnection(profile.id);
  });
});
