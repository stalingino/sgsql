import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { loadConfig } from "./lib/config";
import { startQueryLog } from "./lib/queryLog";
import "./index.css";

// Settings must be available before a table can mount and issue its first query.
loadConfig().then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ErrorBoundary label="SGSql">
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
  startQueryLog();
});
