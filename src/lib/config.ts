import { invoke } from "@tauri-apps/api/core";

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
  queryStack?: string[]; // LIFO — last closed query on top
  settings?: AppSettings;
}

export interface AppSettings {
  /** Default ORDER BY for data table loads. e.g. "id DESC" or "" for none */
  defaultOrderBy?: string;
}

/* ── In-memory cache ────────────────────────────────────── */

let cache: AppConfig = {};
let _loaded = false;

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
  try {
    await invoke("config_save", { data: cache });
  } catch (e) {
    console.warn("[config] save failed:", e);
  }
}

/* ── Query stack helpers ────────────────────────────────── */

const STACK_MAX = 50;

export function queryStackPop(): string {
  const stack = cache.queryStack ?? [];
  if (stack.length === 0) return "";
  const sql = stack[stack.length - 1];
  cache.queryStack = stack.slice(0, -1);
  // Fire-and-forget save — just the stack changed
  saveConfig({ queryStack: cache.queryStack });
  return sql;
}

export function queryStackPush(sql: string): void {
  if (!sql.trim()) return;
  const stack = cache.queryStack ?? [];
  stack.push(sql);
  if (stack.length > STACK_MAX) stack.shift();
  cache.queryStack = stack;
  saveConfig({ queryStack: cache.queryStack });
}

export { _loaded as configLoaded };
