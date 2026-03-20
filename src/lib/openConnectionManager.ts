import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

let connManagerWindow: WebviewWindow | null = null;

export async function openConnectionManager(): Promise<void> {
  // Focus existing window if it's still open
  if (connManagerWindow) {
    try {
      await connManagerWindow.setFocus();
      return;
    } catch {
      // Window was closed, create a new one
      connManagerWindow = null;
    }
  }

  const webview = new WebviewWindow("connection-manager", {
    url: "/connection-manager.html",
    title: "Connections",
    width: 740,
    height: 500,
    resizable: false,
    center: true,
    decorations: true,
  });

  connManagerWindow = webview;

  webview.once("tauri://destroyed", () => {
    connManagerWindow = null;
  });
}
