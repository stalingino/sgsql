import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

function storageKey(label: string, field: "pos" | "size") {
  return `sgsql-win-${label}-${field}`;
}

export interface SavedWindowState {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

/** Read saved position/size for a window label (without restoring). */
export function getSavedWindowState(label: string): SavedWindowState {
  try {
    const pos = localStorage.getItem(storageKey(label, "pos"));
    const size = localStorage.getItem(storageKey(label, "size"));
    return {
      ...(pos ? JSON.parse(pos) : {}),
      ...(size ? JSON.parse(size) : {}),
    };
  } catch {
    return {};
  }
}

/**
 * Hook — call once inside the window's root component.
 * Restores saved position/size on mount, then saves on every move/resize.
 */
export function useWindowPersist() {
  useEffect(() => {
    const win = getCurrentWindow();
    const label = win.label;
    let saveTimer: ReturnType<typeof setTimeout>;
    let unlistenMoved: (() => void) | undefined;
    let unlistenResized: (() => void) | undefined;

    const save = async () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        try {
          const sf = await win.scaleFactor();
          const pos = await win.outerPosition();
          const size = await win.outerSize();
          localStorage.setItem(
            storageKey(label, "pos"),
            JSON.stringify({ x: pos.x / sf, y: pos.y / sf }),
          );
          localStorage.setItem(
            storageKey(label, "size"),
            JSON.stringify({ width: size.width / sf, height: size.height / sf }),
          );
        } catch {
          // window may be closing
        }
      }, 300);
    };

    (async () => {
      // Restore saved state
      try {
        const saved = getSavedWindowState(label);
        if (saved.width && saved.height) {
          const { LogicalSize } = await import("@tauri-apps/api/dpi");
          await win.setSize(new LogicalSize(saved.width, saved.height));
        }
        if (saved.x !== undefined && saved.y !== undefined) {
          const { LogicalPosition } = await import("@tauri-apps/api/dpi");
          await win.setPosition(new LogicalPosition(saved.x, saved.y));
        }
      } catch {
        // first run — no saved state
      }

      // Start listening
      unlistenMoved = await win.onMoved(() => save());
      unlistenResized = await win.onResized(() => save());
    })();

    return () => {
      clearTimeout(saveTimer);
      unlistenMoved?.();
      unlistenResized?.();
    };
  }, []);
}
