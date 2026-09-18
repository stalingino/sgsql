import { invoke } from "@tauri-apps/api/core";
import {
  popQueryHistory,
  pushQueryHistory,
  type QueryHistory,
} from "./queryHistory";

/* ── Shape ──────────────────────────────────────────────── */

export interface WindowState {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface AppConfig {
  theme?: "dark" | "light" | "system";
  windows?: Record<string, WindowState>;
  sidebar?: { visible: boolean; width: number };
  console?: { visible: boolean; height: number; split?: number };
  detailPanel?: { visible: boolean; width: number };
  /** @deprecated Unscoped history from older releases; deliberately not restored. */
  queryStack?: string[];
  queryHistory?: QueryHistory; // LIFO stacks scoped by connection profile + database
  searchLru?: Record<string, string[]>; // Most-recently selected palette item first
  settings?: AppSettings;
}

export interface AppSettings {
  /** Default ORDER BY for data table loads. e.g. "id DESC" or "" for none */
  defaultOrderBy?: string;
}

/* ── In-memory cache ────────────────────────────────────── */

let cache: AppConfig = {};
let _loaded = false;
let saveQueue: Promise<void> = Promise.resolve();

export async function loadConfig(): Promise<AppConfig> {
  try {
    const data = await invoke<AppConfig>("config_load");
    cache = data ?? {};
  } catch {
    cache = {};
  }
  _loaded = true;
  return cache;
}

export function getConfig(): AppConfig {
  return cache;
}

/** Merge partial update into cache and flush to disk. */
export async function saveConfig(partial: Partial<AppConfig>): Promise<void> {
  // Deep-merge top-level keys that are objects
  for (const [k, v] of Object.entries(partial) as [keyof AppConfig, unknown][]) {
    if (v !== null && typeof v === "object" && !Array.isArray(v) &&
        cache[k] !== null && typeof cache[k] === "object" && !Array.isArray(cache[k])) {
      (cache as any)[k] = { ...(cache as any)[k], ...v };
    } else {
      (cache as any)[k] = v;
    }
  }
  // Tauri commands may complete out of order. Serialize immutable snapshots so
  // a slower, older write can never overwrite newer query history or UI state.
  const snapshot = structuredClone(cache);
  saveQueue = saveQueue.then(async () => {
    try {
      await invoke("config_save", { data: snapshot });
    } catch (e) {
      console.warn("[config] save failed:", e);
    }
  });
  await saveQueue;
}

/* ── Query history helpers ──────────────────────────────── */

export function queryHistoryPop(profileId: string, database: string): string {
  const result = popQueryHistory(cache.queryHistory ?? {}, profileId, database);
  if (!result.sql) return "";
  cache.queryHistory = result.history;
  void saveConfig({ queryHistory: result.history });
  return result.sql;
}

export function queryHistoryPush(profileId: string, database: string, sql: string): Promise<void> {
  return queryHistoryPushMany(profileId, database, [sql]);
}

export function queryHistoryPushMany(
  profileId: string,
  database: string,
  sqlStatements: readonly string[],
): Promise<void> {
  const current = cache.queryHistory ?? {};
  const next = pushQueryHistory(current, profileId, database, sqlStatements);
  if (next === current) return Promise.resolve();
  cache.queryHistory = next;
  return saveConfig({ queryHistory: next });
}

export { _loaded as configLoaded };
