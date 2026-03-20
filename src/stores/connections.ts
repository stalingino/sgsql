import { create } from "zustand";
import { load, type Store } from "@tauri-apps/plugin-store";
import { nanoid } from "nanoid";
import type { ConnectionProfile } from "../lib/types";
import { sidecarFetch } from "../lib/sidecar";
import type { ConnectionTestResult } from "../lib/types";

interface ConnectionsState {
  profiles: ConnectionProfile[];
  loaded: boolean;

  // Actions
  loadProfiles: () => Promise<void>;
  addProfile: (profile: Omit<ConnectionProfile, "id">) => Promise<ConnectionProfile>;
  updateProfile: (id: string, updates: Partial<ConnectionProfile>) => Promise<void>;
  deleteProfile: (id: string) => Promise<void>;
  testConnection: (profile: ConnectionProfile) => Promise<ConnectionTestResult>;
}

let storeInstance: Store | null = null;

async function getStore(): Promise<Store> {
  if (!storeInstance) {
    storeInstance = await load("connections.json", { autoSave: true, defaults: {} });
  }
  return storeInstance;
}

export const useConnectionsStore = create<ConnectionsState>((set, get) => ({
  profiles: [],
  loaded: false,

  loadProfiles: async () => {
    try {
      const store = await getStore();
      const profiles = await store.get<ConnectionProfile[]>("connections");
      set({ profiles: profiles || [], loaded: true });
    } catch {
      set({ profiles: [], loaded: true });
    }
  },

  addProfile: async (profile) => {
    const newProfile: ConnectionProfile = { ...profile, id: nanoid() };
    const profiles = [...get().profiles, newProfile];
    set({ profiles });
    const store = await getStore();
    await store.set("connections", profiles);
    return newProfile;
  },

  updateProfile: async (id, updates) => {
    const profiles = get().profiles.map((p) =>
      p.id === id ? { ...p, ...updates } : p,
    );
    set({ profiles });
    const store = await getStore();
    await store.set("connections", profiles);
  },

  deleteProfile: async (id) => {
    const profiles = get().profiles.filter((p) => p.id !== id);
    set({ profiles });
    const store = await getStore();
    await store.set("connections", profiles);
  },

  testConnection: async (profile) => {
    return sidecarFetch<ConnectionTestResult>("/connections/test", {
      method: "POST",
      body: JSON.stringify(profile),
    });
  },
}));
