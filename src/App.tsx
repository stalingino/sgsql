import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Database,
  ServerCrash,
  Loader2,
  PlugZap,
  Sun,
  Moon,
  Monitor,
} from "lucide-react";
import { waitForSidecar } from "./lib/sidecar";
import { openConnectionManager } from "./lib/openConnectionManager";
import { openConnection, closeConnection } from "./lib/schema";
import { useThemeStore, type ThemeMode } from "./lib/theme";
import { SchemaTree } from "./components/SchemaTree";
import type { ConnectionProfile } from "./lib/types";
import { envBadgeStyle } from "./lib/types";

function App() {
  const [sidecarReady, setSidecarReady] = useState(false);
  const [sidecarError, setSidecarError] = useState(false);
  const [activeConnection, setActiveConnection] = useState<ConnectionProfile | null>(null);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [connectingError, setConnectingError] = useState<string | null>(null);

  const connectionIdRef = useRef<string | null>(null);
  connectionIdRef.current = connectionId;

  useEffect(() => {
    waitForSidecar().then((ok) => {
      setSidecarReady(ok);
      setSidecarError(!ok);
    });
  }, []);

  useEffect(() => {
    const unlisten = listen<ConnectionProfile>("connection-selected", async (event) => {
      setActiveConnection(event.payload);
      // Main window starts hidden; reveal it the first time a connection is picked.
      await getCurrentWindow().show();
      await getCurrentWindow().setFocus();
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  useEffect(() => {
    if (!activeConnection) return;
    let cancelled = false;
    setConnectingError(null);

    const prevConnId = connectionIdRef.current;
    (async () => {
      if (prevConnId) {
        try { await closeConnection(prevConnId); } catch { /* best effort */ }
      }
      try {
        const { connectionId: newId } = await openConnection(activeConnection);
        if (!cancelled) setConnectionId(newId);
      } catch (err: unknown) {
        if (!cancelled) {
          setConnectingError(err instanceof Error ? err.message : String(err));
          setConnectionId(null);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [activeConnection]);

  useEffect(() => {
    return () => {
      if (connectionIdRef.current) closeConnection(connectionIdRef.current).catch(() => {});
    };
  }, []);

  const handleTableSelect = useCallback((db: string, schema: string, table: string) => {
    console.log("[schema] table selected:", { db, schema, table });
  }, []);

  // ── Loading ──────────────────────────────────────────────
  if (!sidecarReady && !sidecarError) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-bg-primary">
        <Database size={40} className="text-accent mb-4" />
        <h1 className="text-2xl font-bold mb-1 text-text-primary">SG SQL</h1>
        <p className="text-text-secondary mb-6 text-sm">Stupidly Good SQL</p>
        <div className="flex items-center gap-2 text-sm text-text-muted">
          <Loader2 size={14} className="animate-spin" />
          Starting up...
        </div>
      </div>
    );
  }

  // ── Error ────────────────────────────────────────────────
  if (sidecarError) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-bg-primary">
        <ServerCrash size={40} className="text-error mb-4" />
        <h1 className="text-2xl font-bold mb-1 text-text-primary">SG SQL</h1>
        <p className="text-text-secondary mb-6 text-sm">Stupidly Good SQL</p>
        <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-error/10 text-error text-sm">
          <span className="w-2 h-2 rounded-full bg-error" />
          Sidecar not reachable
        </div>
      </div>
    );
  }

  const envStyle = activeConnection ? envBadgeStyle(activeConnection.env) : null;
  const envLabel = activeConnection ? (activeConnection.env ? activeConnection.env.slice(0, 4) : "") : "";

  return (
    <div className="flex flex-col h-screen bg-bg-primary">
      {/* ── Top bar ────────────────────────────────────────── */}
      <div
        className="flex items-center justify-between h-10 px-4 border-b border-border bg-bg-secondary shrink-0"
        data-tauri-drag-region
      >
        <div className="flex items-center gap-2 min-w-0">
          {activeConnection ? (
            <>
              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: activeConnection.color }} />
              <span className="text-sm font-semibold text-text-primary truncate">{activeConnection.name}</span>
              {envStyle && (
                <span className="text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0" style={envStyle}>
                  {envLabel}
                </span>
              )}
              <span className="text-xs text-text-muted truncate">
                {activeConnection.type === "sqlite"
                  ? activeConnection.database
                  : `${activeConnection.host}/${activeConnection.database}`}
              </span>
            </>
          ) : (
            <span className="text-sm text-text-muted">No connection</span>
          )}
        </div>
        <button
          onClick={() => openConnectionManager()}
          title="Connections"
          className="flex items-center p-1.5 rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer shrink-0"
        >
          <PlugZap size={14} />
        </button>
      </div>

      {/* ── Body ───────────────────────────────────────────── */}
      {!activeConnection ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <Database size={48} className="text-accent mx-auto mb-4" />
            <h1 className="text-3xl font-bold mb-1 text-text-primary">SG SQL</h1>
            <p className="text-text-secondary mb-6 text-sm">Stupidly Good SQL</p>
            <button
              onClick={() => openConnectionManager()}
              className="flex items-center gap-2 mx-auto px-5 py-2 text-sm rounded-lg bg-accent hover:bg-accent-hover text-white transition-colors cursor-pointer"
            >
              <PlugZap size={14} />
              Open Connection Manager
            </button>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex min-h-0">
          {/* Left sidebar */}
          <aside className="w-[240px] shrink-0 border-r border-border bg-bg-secondary flex flex-col min-h-0">
            <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border shrink-0">
              <Database size={12} className="text-text-muted" />
              <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                Schema
              </span>
            </div>
            <div className="flex-1 overflow-y-auto min-h-0">
              {connectingError && (
                <div className="flex items-start gap-2 px-3 py-4 text-xs text-error">
                  <ServerCrash size={14} className="shrink-0 mt-0.5" />
                  {connectingError}
                </div>
              )}
              {!connectionId && !connectingError && (
                <div className="flex items-center gap-2 px-3 py-4 text-xs text-text-muted">
                  <Loader2 size={12} className="animate-spin" />
                  Connecting...
                </div>
              )}
              {connectionId && (
                <SchemaTree
                  connectionId={connectionId}
                  connectionType={activeConnection.type}
                  connectionDatabase={activeConnection.database}
                  onTableSelect={handleTableSelect}
                />
              )}
            </div>
          </aside>

          {/* Main content */}
          <main className="flex-1 flex items-center justify-center min-h-0 bg-bg-primary">
            <div className="text-center text-text-muted text-sm">
              <Table2Icon />
              <p className="mt-3">Select a table to get started</p>
            </div>
          </main>
        </div>
      )}

      {/* ── Status bar ─────────────────────────────────────── */}
      <StatusBar connectionId={connectionId} activeConnection={activeConnection} />
    </div>
  );
}

function Table2Icon() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mx-auto text-text-muted opacity-30">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18M3 15h18M9 3v18" />
    </svg>
  );
}

/* ── Status bar ──────────────────────────────────────────── */

function StatusBar({
  connectionId,
  activeConnection,
}: {
  connectionId: string | null;
  activeConnection: ConnectionProfile | null;
}) {
  const { mode, setMode } = useThemeStore();

  return (
    <div className="flex items-center justify-between h-6 px-3 border-t border-border bg-bg-secondary shrink-0 text-[11px] text-text-muted">
      {/* Left: connection status */}
      <div className="flex items-center gap-2">
        {activeConnection && connectionId && (
          <>
            <span className="w-1.5 h-1.5 rounded-full bg-success" />
            <span>Connected · {activeConnection.type}</span>
          </>
        )}
        {activeConnection && !connectionId && (
          <>
            <Loader2 size={9} className="animate-spin" />
            <span>Connecting...</span>
          </>
        )}
        {!activeConnection && <span>Not connected</span>}
      </div>

      {/* Right: theme toggle */}
      <div className="flex items-center gap-0.5">
        <ThemeButton current={mode} value="light" setMode={setMode} icon={<Sun size={11} />} label="Light" />
        <ThemeButton current={mode} value="dark"  setMode={setMode} icon={<Moon size={11} />} label="Dark" />
        <ThemeButton current={mode} value="system" setMode={setMode} icon={<Monitor size={11} />} label="System" />
      </div>
    </div>
  );
}

function ThemeButton({
  current, value, setMode, icon, label,
}: {
  current: ThemeMode;
  value: ThemeMode;
  setMode: (m: ThemeMode) => void;
  icon: React.ReactNode;
  label: string;
}) {
  const active = current === value;
  return (
    <button
      onClick={() => setMode(value)}
      title={label}
      className={`flex items-center px-1.5 py-0.5 rounded transition-colors cursor-pointer ${
        active
          ? "bg-bg-active text-text-primary"
          : "text-text-muted hover:text-text-secondary hover:bg-bg-hover"
      }`}
    >
      {icon}
    </button>
  );
}

export default App;
