import { getConfig, saveConfig } from "./config";

export const SEARCH_LRU_MAX = 50;

export function promoteSearchLru(entries: string[], key: string, max = SEARCH_LRU_MAX): string[] {
  return [key, ...entries.filter((entry) => entry !== key)].slice(0, max);
}

export function getSearchLru(scope: string): string[] {
  return getConfig().searchLru?.[scope] ?? [];
}

export function touchSearchLru(scope: string, key: string): string[] {
  const next = promoteSearchLru(getSearchLru(scope), key);
  saveConfig({
    searchLru: {
      ...getConfig().searchLru,
      [scope]: next,
    },
  });
  return next;
}
