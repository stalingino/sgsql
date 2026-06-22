import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { nanoid } from "nanoid";
import { createDefaultProfile, type ConnectionProfile } from "../lib/types";
import type { ConnectionTestResult } from "../lib/types";
import { sidecarFetch } from "../lib/sidecar";
import { keychainSet, keychainGet, keychainDelete } from "../lib/keychain";

interface ConnectionSecrets {
  password: string;
  sshPassword: string;
}

function normalizeProfile(profile: ConnectionProfile): ConnectionProfile {
  return { ...createDefaultProfile(), ...profile, password: "", sshPassword: "" };
}

async function getSecrets(id: string): Promise<ConnectionSecrets> {
  const raw = await keychainGet(id).catch(() => "");
  if (!raw) return { password: "", sshPassword: "" };
  try {
    const parsed = JSON.parse(raw) as Partial<ConnectionSecrets> & { version?: number };
    if (parsed.version === 1) {
      return { password: parsed.password ?? "", sshPassword: parsed.sshPassword ?? "" };
    }
  } catch { /* Legacy entries stored only the database password. */ }
  return { password: raw, sshPassword: "" };
}

async function setSecrets(id: string, secrets: ConnectionSecrets): Promise<void> {
  await keychainSet(id, JSON.stringify({ version: 1, ...secrets }));
}

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
  const clean = profiles.map((p) => ({ ...p, password: "", sshPassword: "" }));
  await invoke("encrypted_store_save", { data: clean });
}

/** Load profiles from the encrypted store */
async function loadEncrypted(): Promise<ConnectionProfile[]> {
  const data = await invoke<ConnectionProfile[]>("encrypted_store_load");
  return (data || []).map(normalizeProfile);
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
    const sshPassword = profile.sshAuthMode === "keychain" ? profile.sshPassword || "" : "";
    const newProfile: ConnectionProfile = { ...profile, id, password: "", sshPassword: "" };
    await setSecrets(id, { password, sshPassword });

    const profiles = [...get().profiles, newProfile];
    set({ profiles });
    await saveEncrypted(profiles);
    return newProfile;
  },

  updateProfile: async (id, updates) => {
    const existing = await getSecrets(id);
    const password = updates.password ? updates.password : existing.password;
    const sshPassword = updates.sshAuthMode && updates.sshAuthMode !== "keychain"
      ? ""
      : updates.sshPassword || existing.sshPassword;
    await setSecrets(id, { password, sshPassword });

    const profiles = get().profiles.map((p) =>
      p.id === id ? { ...p, ...updates, password: "", sshPassword: "" } : p,
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
    const secrets = await getSecrets(id);
    return {
      ...profile,
      password: secrets.password,
      sshPassword: profile.sshAuthMode === "keychain" ? secrets.sshPassword : "",
    };
  },

  testConnection: async (profile) => {
    let fullProfile = profile;
    if (profile.id && !profile.password) {
      const secrets = await getSecrets(profile.id);
      fullProfile = {
        ...profile,
        password: secrets.password,
        sshPassword: profile.sshAuthMode === "keychain" ? secrets.sshPassword : profile.sshPassword,
      };
    }
    return sidecarFetch<ConnectionTestResult>("/connections/test", {
      method: "POST",
      body: JSON.stringify(fullProfile),
    });
  },
}));
