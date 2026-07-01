import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getSavedWindowState } from "./useWindowPersist";

export async function openConnectionManager(): Promise<void> {
  const existing = await WebviewWindow.getByLabel("connection-manager");
  if (existing) {
    await existing.setFocus();
    return;
  }

  const saved = getSavedWindowState("connection-manager");

  new WebviewWindow("connection-manager", {
    url: "/connection-manager.html",
    title: "SG SQL Connections",
    width: saved.width ?? 520,
    height: saved.height ?? 560,
    x: saved.x,
    y: saved.y,
    center: saved.x === undefined, // only center if no saved position
    resizable: true,
    decorations: true,
  });
}
