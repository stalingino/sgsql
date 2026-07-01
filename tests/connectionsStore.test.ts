import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ConnectionProfile } from "../src/lib/types";

type PendingSave = {
  data: unknown;
  resolve: () => void;
};

const pendingSaves: PendingSave[] = [];

mock.module("@tauri-apps/api/core", () => ({
  invoke: (_command: string, payload: { data: unknown }) => new Promise<void>((resolve) => {
    pendingSaves.push({ data: payload.data, resolve });
  }),
}));

mock.module("../src/lib/keychain", () => ({
  keychainSet: async () => undefined,
  keychainGet: async () => "",
  keychainDelete: async () => undefined,
}));

const { useConnectionsStore } = await import("../src/stores/connections");

function profile(id: string): ConnectionProfile {
  return {
    id,
    name: id,
    type: "postgres",
    host: "localhost",
    port: 5432,
    database: "postgres",
    username: "postgres",
    password: "",
    ssl: false,
    color: "#000000",
    env: "",
    group: "Connections",
    useSsh: false,
    sshHost: "",
    sshPort: 22,
    sshUsername: "",
    sshAuthMode: "keychain",
    sshPassword: "",
    sshPrivateKey: "",
    sshUsePrivateKey: false,
  };
}

describe("connection order persistence", () => {
  beforeEach(() => {
    pendingSaves.length = 0;
    useConnectionsStore.setState({
      profiles: [profile("a"), profile("b")],
      folders: ["Connections"],
      loaded: true,
    });
  });

  test("serializes saves so the newest drag order is written last", async () => {
    const [a, b] = useConnectionsStore.getState().profiles;
    const first = useConnectionsStore.getState().reorderProfiles([b, a]);
    const second = useConnectionsStore.getState().reorderProfiles([a, b]);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pendingSaves).toHaveLength(1);

    pendingSaves[0].resolve();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pendingSaves).toHaveLength(2);

    pendingSaves[1].resolve();
    await second;

    const savedOrders = pendingSaves.map(({ data }) =>
      (data as { profiles: ConnectionProfile[] }).profiles.map(({ id }) => id),
    );
    expect(savedOrders).toEqual([["b", "a"], ["a", "b"]]);
  });
});
