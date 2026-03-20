import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { nanoid } from "nanoid";
import type { ConnectionProfile } from "../lib/types";
import type { ConnectionTestResult } from "../lib/types";
import { sidecarFetch } from "../lib/sidecar";
import { keychainSet, keychainGet, keychainDelete } from "../lib/keychain";

interface ConnectionsState {
  profiles: ConnectionProfile[];
  loaded: boolean;

  loadProfiles: () => Promise<void>;
  addProfile: (profile: Omit<ConnectionProfile, "id">) => Promise<ConnectionProfile>;
  updateProfile: (id: string, updates: Partial<ConnectionProfile>) => Promise<void>;
  deleteProfile: (id: string) => Promise<void>;
  testConnection: (profile: ConnectionProfile) => Promise<ConnectionTestResult>;
  getProfileWithPassword: (id: string) => Promise<ConnectionProfile | null>;
}

/** Save profiles (without passwords) to the encrypted store */
async function saveEncrypted(profiles: ConnectionProfile[]): Promise<void> {
  // Strip passwords before encryption (they're in the keychain)
  const clean = profiles.map((p) => ({ ...p, password: "" }));
  await invoke("encrypted_store_save", { data: clean });
}

/** Load profiles from the encrypted store */
async function loadEncrypted(): Promise<ConnectionProfile[]> {
  const data = await invoke<ConnectionProfile[]>("encrypted_store_load");
  return data || [];
}

export const useConnectionsStore = create<ConnectionsState>((set, get) => ({
  profiles: [],
  loaded: false,

  loadProfiles: async () => {
    try {
      const profiles = await loadEncrypted();
      set({ profiles, loaded: true });
    } catch (e) {
      console.error("[store] load failed:", e);
      set({ profiles: [], loaded: true });
    }
  },

  addProfile: async (profile) => {
    const id = nanoid();
    const password = (profile as ConnectionProfile).password || "";
    const newProfile: ConnectionProfile = { ...profile, id, password: "" };

    if (password) {
      await keychainSet(id, password);
    }

    const profiles = [...get().profiles, newProfile];
    set({ profiles });
    await saveEncrypted(profiles);
    return newProfile;
  },

  updateProfile: async (id, updates) => {
    if (updates.password !== undefined && updates.password !== "") {
      await keychainSet(id, updates.password);
    }

    const profiles = get().profiles.map((p) =>
      p.id === id ? { ...p, ...updates, password: "" } : p,
    );
    set({ profiles });
    await saveEncrypted(profiles);
  },

  deleteProfile: async (id) => {
    await keychainDelete(id).catch(() => {});

    const profiles = get().profiles.filter((p) => p.id !== id);
    set({ profiles });
    await saveEncrypted(profiles);
  },

  getProfileWithPassword: async (id) => {
    const profile = get().profiles.find((p) => p.id === id);
    if (!profile) return null;
    const password = await keychainGet(id);
    return { ...profile, password };
  },

  testConnection: async (profile) => {
    let fullProfile = profile;
    if (profile.id && !profile.password) {
      const password = await keychainGet(profile.id);
      fullProfile = { ...profile, password };
    }
    return sidecarFetch<ConnectionTestResult>("/connections/test", {
      method: "POST",
      body: JSON.stringify(fullProfile),
    });
  },
}));
