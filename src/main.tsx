import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { loadConfig } from "./lib/config";
import { startQueryLog } from "./lib/queryLog";
import "./index.css";

// Settings must be available before a table can mount and issue its first query.
loadConfig().then(() => {
  startQueryLog();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
