import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { waitForSidecar } from "./lib/sidecar";
import { openConnectionManager } from "./lib/openConnectionManager";
import type { ConnectionProfile } from "./lib/types";

function App() {
  const [sidecarReady, setSidecarReady] = useState(false);
  const [sidecarError, setSidecarError] = useState(false);
  const [activeConnection, setActiveConnection] = useState<ConnectionProfile | null>(null);

  useEffect(() => {
    waitForSidecar().then((ok) => {
      setSidecarReady(ok);
      setSidecarError(!ok);
      if (ok) openConnectionManager();
    });
  }, []);

  // Listen for connection-selected event from the connection manager window
  useEffect(() => {
    const unlisten = listen<ConnectionProfile>("connection-selected", (event) => {
      setActiveConnection(event.payload);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Loading state
  if (!sidecarReady && !sidecarError) {
    return (
      <div className="flex flex-col items-center justify-center h-screen">
        <h1 className="text-2xl font-bold mb-1">SG SQL</h1>
        <p className="text-text-secondary mb-6 text-sm">Stupidly Good SQL</p>
        <div className="flex items-center gap-2 text-sm text-text-muted">
          <span className="w-2 h-2 rounded-full bg-warning animate-pulse" />
          Starting up...
        </div>
      </div>
    );
  }

  // Error state
  if (sidecarError) {
    return (
      <div className="flex flex-col items-center justify-center h-screen">
        <h1 className="text-2xl font-bold mb-1">SG SQL</h1>
        <p className="text-text-secondary mb-6 text-sm">Stupidly Good SQL</p>
        <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-error/10 text-error text-sm">
          <span className="w-2 h-2 rounded-full bg-error" />
          Sidecar not reachable
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-bg-primary">
      {/* Top bar */}
      <div className="flex items-center justify-between h-10 px-4 border-b border-border bg-bg-secondary shrink-0" data-tauri-drag-region>
        <div className="flex items-center gap-2">
          {activeConnection && (
            <>
              <span
                className="w-2 h-2 rounded-full"
                style={{ backgroundColor: activeConnection.color }}
              />
              <span className="text-sm font-medium">{activeConnection.name}</span>
              <span className="text-xs text-text-muted">
                {activeConnection.type === "sqlite"
                  ? activeConnection.database
                  : `${activeConnection.host}:${activeConnection.port}/${activeConnection.database}`}
              </span>
            </>
          )}
          {!activeConnection && (
            <span className="text-sm text-text-muted">No connection</span>
          )}
        </div>
        <button
          onClick={() => openConnectionManager()}
          className="px-3 py-1 text-xs rounded-md border border-border-light text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
        >
          Connections
        </button>
      </div>

      {/* Main area */}
      <div className="flex-1 flex items-center justify-center">
        {!activeConnection ? (
          <div className="text-center">
            <h1 className="text-3xl font-bold mb-1">SG SQL</h1>
            <p className="text-text-secondary mb-6 text-sm">Stupidly Good SQL</p>
            <button
              onClick={() => openConnectionManager()}
              className="px-5 py-2 text-sm rounded-lg bg-accent hover:bg-accent-hover text-white transition-colors cursor-pointer"
            >
              Open Connection Manager
            </button>
          </div>
        ) : (
          <div className="text-center text-text-muted text-sm">
            Connected to <span className="text-text-primary font-medium">{activeConnection.name}</span>
            <br />
            <span className="text-xs">Schema browser coming in Phase 3</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
