import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConnectionManagerWindow } from "./components/ConnectionManagerWindow";
import "./index.css";
// Apply saved theme before first render
import "./lib/theme";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConnectionManagerWindow />
  </StrictMode>,
);
