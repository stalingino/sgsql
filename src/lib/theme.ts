import { create } from "zustand";
import { getConfig, saveConfig } from "./config";

export type ThemeMode = "dark" | "light" | "system";

interface ThemeState {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
}

function getSystemTheme(): "dark" | "light" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(mode: ThemeMode) {
  const resolved = mode === "system" ? getSystemTheme() : mode;
  document.documentElement.setAttribute("data-theme", resolved);
}

// Applied immediately when config is loaded (called from App.tsx after loadConfig)
export function initTheme() {
  const mode = (getConfig().theme as ThemeMode) || "system";
  applyTheme(mode);

  // Re-apply on system preference change
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if ((getConfig().theme || "system") === "system") applyTheme("system");
  });

  return mode;
}

export const useThemeStore = create<ThemeState>((set) => ({
  mode: "system",
  setMode: (mode) => {
    saveConfig({ theme: mode });
    applyTheme(mode);
    set({ mode });
  },
}));
