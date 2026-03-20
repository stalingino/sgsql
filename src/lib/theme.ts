import { create } from "zustand";

export type ThemeMode = "dark" | "light" | "system";

interface ThemeState {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
}

const STORAGE_KEY = "sgsql-theme";

function getSystemTheme(): "dark" | "light" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(mode: ThemeMode) {
  const resolved = mode === "system" ? getSystemTheme() : mode;
  document.documentElement.setAttribute("data-theme", resolved);
}

// Load saved mode or default to system
const savedMode = (localStorage.getItem(STORAGE_KEY) as ThemeMode) || "system";
applyTheme(savedMode);

// Watch system preference changes
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  const current = (localStorage.getItem(STORAGE_KEY) as ThemeMode) || "system";
  if (current === "system") applyTheme("system");
});

export const useThemeStore = create<ThemeState>((set) => ({
  mode: savedMode,
  setMode: (mode) => {
    localStorage.setItem(STORAGE_KEY, mode);
    applyTheme(mode);
    set({ mode });
  },
}));
