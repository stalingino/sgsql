import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConnectionManagerWindow } from "./components/ConnectionManagerWindow";
import "./index.css";
import { loadConfig } from "./lib/config";
import { initTheme } from "./lib/theme";

// Load config and apply theme before rendering
loadConfig().then(() => {
  initTheme();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ConnectionManagerWindow />
    </StrictMode>,
  );
});
