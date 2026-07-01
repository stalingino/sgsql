import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { nanoid } from "nanoid";
import {
  createDefaultProfile,
  DEFAULT_CONNECTION_FOLDER,
  type ConnectionProfile,
} from "../lib/types";
import type { ConnectionTestResult } from "../lib/types";
import { sidecarFetch } from "../lib/sidecar";
import { keychainSet, keychainGet, keychainDelete } from "../lib/keychain";

interface ConnectionSecrets {
  password: string;
  sshPassword: string;
}

function normalizeProfile(profile: ConnectionProfile): ConnectionProfile {
  const normalized = { ...createDefaultProfile(), ...profile, password: "", sshPassword: "" };
  normalized.group = normalized.group?.trim() || DEFAULT_CONNECTION_FOLDER;
  return normalized;
}

function normalizeFolders(folders: string[], profiles: ConnectionProfile[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const add = (value: string) => {
    const name = value.trim();
    const key = name.toLocaleLowerCase();
    if (!name || seen.has(key)) return;
    seen.add(key);
    result.push(name);
  };
  folders.forEach(add);
  profiles.forEach((profile) => add(profile.group || DEFAULT_CONNECTION_FOLDER));
  if (!seen.has(DEFAULT_CONNECTION_FOLDER.toLocaleLowerCase())) result.unshift(DEFAULT_CONNECTION_FOLDER);
  const canonical = new Map(result.map((name) => [name.toLocaleLowerCase(), name]));
  profiles.forEach((profile) => {
    profile.group = canonical.get((profile.group || DEFAULT_CONNECTION_FOLDER).toLocaleLowerCase())
      ?? DEFAULT_CONNECTION_FOLDER;
  });
  return result;
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
  folders: string[];
  loaded: boolean;

  loadProfiles: () => Promise<void>;
  addProfile: (profile: Omit<ConnectionProfile, "id">) => Promise<ConnectionProfile>;
  updateProfile: (id: string, updates: Partial<ConnectionProfile>) => Promise<void>;
  deleteProfile: (id: string) => Promise<void>;
  reorderProfiles: (profiles: ConnectionProfile[]) => Promise<void>;
  createFolder: (name: string) => Promise<void>;
  reorderFolders: (folders: string[]) => Promise<void>;
  importProfiles: (profiles: ConnectionProfile[], folders?: string[]) => Promise<number>;
  testConnection: (profile: ConnectionProfile) => Promise<ConnectionTestResult>;
  getProfileWithPassword: (id: string) => Promise<ConnectionProfile | null>;
}

// Tauri commands run concurrently. Keep writes ordered so a slower, older save
// cannot overwrite a more recent drag/drop update on disk.
let encryptedSaveQueue: Promise<void> = Promise.resolve();

/** Save profiles (without passwords) to the encrypted store. */
function saveEncrypted(profiles: ConnectionProfile[], folders: string[]): Promise<void> {
  // Snapshot the payload now: callers often update Zustand immediately after
  // scheduling a save, and queued writes must retain their original state.
  const clean = profiles.map((p) => ({ ...p, password: "", sshPassword: "" }));
  const data = { version: 2, profiles: clean, folders: normalizeFolders(folders, clean) };
  const save = encryptedSaveQueue
    .catch(() => undefined)
    .then(() => invoke<void>("encrypted_store_save", { data }));

  // A failed write must reject its own caller without blocking later writes.
  encryptedSaveQueue = save.catch(() => undefined);
  return save;
}

/** Load profiles and folders, migrating the legacy profile-array format. */
async function loadEncrypted(): Promise<{ profiles: ConnectionProfile[]; folders: string[] }> {
  const data = await invoke<ConnectionProfile[] | { profiles?: ConnectionProfile[]; folders?: string[] }>("encrypted_store_load");
  const rawProfiles = Array.isArray(data) ? data : data?.profiles ?? [];
  const profiles = rawProfiles.map(normalizeProfile);
  const folders = normalizeFolders(Array.isArray(data) ? [] : data?.folders ?? [], profiles);
  return { profiles, folders };
}

export const useConnectionsStore = create<ConnectionsState>((set, get) => ({
  profiles: [],
  folders: [DEFAULT_CONNECTION_FOLDER],
  loaded: false,

  loadProfiles: async () => {
    try {
      const { profiles, folders } = await loadEncrypted();
      set({ profiles, folders, loaded: true });
    } catch (e) {
      console.error("[store] load failed:", e);
      set({ profiles: [], folders: [DEFAULT_CONNECTION_FOLDER], loaded: true });
    }
  },

  addProfile: async (profile) => {
    const id = nanoid();
    const password = (profile as ConnectionProfile).password || "";
    const sshPassword = profile.sshAuthMode === "keychain" ? profile.sshPassword || "" : "";
    const newProfile = normalizeProfile({ ...profile, id } as ConnectionProfile);
    await setSecrets(id, { password, sshPassword });

    const profiles = [...get().profiles, newProfile];
    const folders = normalizeFolders(get().folders, profiles);
    set({ profiles, folders });
    await saveEncrypted(profiles, folders);
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
    const folders = normalizeFolders(get().folders, profiles);
    set({ profiles, folders });
    await saveEncrypted(profiles, folders);
  },

  deleteProfile: async (id) => {
    await keychainDelete(id).catch(() => {});

    const profiles = get().profiles.filter((p) => p.id !== id);
    set({ profiles });
    await saveEncrypted(profiles, get().folders);
  },

  reorderProfiles: async (profiles) => {
    // Preserve identity/order exactly as given; passwords stay in the keychain.
    const clean = profiles.map((p) => ({ ...p, password: "", sshPassword: "" }));
    const folders = normalizeFolders(get().folders, clean);
    set({ profiles: clean, folders });
    await saveEncrypted(clean, folders);
  },

  createFolder: async (name) => {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Folder name is required");
    if (get().folders.some((folder) => folder.toLocaleLowerCase() === trimmed.toLocaleLowerCase())) {
      throw new Error("A folder with that name already exists");
    }
    const folders = [...get().folders, trimmed];
    set({ folders });
    await saveEncrypted(get().profiles, folders);
  },

  reorderFolders: async (folders) => {
    const normalized = normalizeFolders(folders, get().profiles);
    set({ folders: normalized });
    await saveEncrypted(get().profiles, normalized);
  },

  importProfiles: async (incoming, importedFolders = []) => {
    const created: ConnectionProfile[] = [];
    for (const raw of incoming) {
      const id = nanoid();
      const normalized = normalizeProfile({ ...raw, id } as ConnectionProfile);
      await setSecrets(id, {
        password: raw.password || "",
        sshPassword: normalized.sshAuthMode === "keychain" ? raw.sshPassword || "" : "",
      });
      created.push(normalized);
    }
    const profiles = [...get().profiles, ...created];
    const folders = normalizeFolders([...get().folders, ...importedFolders], profiles);
    set({ profiles, folders });
    await saveEncrypted(profiles, folders);
    return created.length;
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
