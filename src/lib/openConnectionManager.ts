import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

export async function openConnectionManager(): Promise<void> {
  const existing = await WebviewWindow.getByLabel("connection-manager");
  if (existing) {
    await existing.setFocus();
    return;
  }

  new WebviewWindow("connection-manager", {
    url: "/connection-manager.html",
    title: "SG SQL Connections",
    width: 740,
    height: 520,
    resizable: false,
    center: true,
    decorations: true,
  });
}
