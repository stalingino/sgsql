import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getConfig, saveConfig } from "./config";

export interface SavedWindowState {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

/** Read saved state for a window label from the config cache. */
export function getSavedWindowState(label: string): SavedWindowState {
  return getConfig().windows?.[label] ?? {};
}

/**
 * Hook — call once inside a window's root component.
 * Restores saved position/size on mount, then saves on move/resize stop.
 */
export function useWindowPersist() {
  useEffect(() => {
    const win = getCurrentWindow();
    const label = win.label;
    let saveTimer: ReturnType<typeof setTimeout>;
    let unlistenMoved: (() => void) | undefined;
    let unlistenResized: (() => void) | undefined;

    const save = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        try {
          const sf = await win.scaleFactor();
          const pos = await win.outerPosition();
          const size = await win.outerSize();
          saveConfig({
            windows: {
              ...getConfig().windows,
              [label]: {
                x: pos.x / sf,
                y: pos.y / sf,
                width: size.width / sf,
                height: size.height / sf,
              },
            },
          });
        } catch {
          // window may be closing
        }
      }, 500);
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
