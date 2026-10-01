import { useEffect } from "react";
import { availableMonitors, getCurrentWindow } from "@tauri-apps/api/window";
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

const MIN_WIDTH = 400;
const MIN_HEIGHT = 300;

/**
 * Drop saved geometry that would produce an unusable window: sizes recorded
 * while minimized (Windows reports ~160x28 at -32000,-32000) or a position
 * that is no longer on any connected monitor.
 */
export async function getUsableWindowState(label: string): Promise<SavedWindowState> {
  const saved = getSavedWindowState(label);
  const result: SavedWindowState = {};
  if (saved.width && saved.height && saved.width >= MIN_WIDTH && saved.height >= MIN_HEIGHT) {
    result.width = saved.width;
    result.height = saved.height;
  }
  if (saved.x !== undefined && saved.y !== undefined) {
    try {
      const monitors = await availableMonitors();
      // A point just inside the title bar must land on some monitor.
      const px = saved.x + 50;
      const py = saved.y + 10;
      const onScreen = monitors.some((m) => {
        const sf = m.scaleFactor;
        const left = m.position.x / sf;
        const top = m.position.y / sf;
        return px >= left && py >= top
          && px < left + m.size.width / sf && py < top + m.size.height / sf;
      });
      if (onScreen) {
        result.x = saved.x;
        result.y = saved.y;
      }
    } catch {
      // monitor info unavailable — fall back to the default position
    }
  }
  return result;
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
          if (await win.isMinimized() || !(await win.isVisible())) return;
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
        const saved = await getUsableWindowState(label);
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
