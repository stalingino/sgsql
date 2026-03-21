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
  X,
} from "lucide-react";
import { waitForSidecar } from "./lib/sidecar";
import { openConnectionManager } from "./lib/openConnectionManager";
import { closeConnection } from "./lib/schema";
import { useThemeStore, type ThemeMode } from "./lib/theme";
import { SchemaTree } from "./components/SchemaTree";
import type { ConnectionProfile } from "./lib/types";
import { envBadgeStyle } from "./lib/types";

/* ── Tab types ──────────────────────────────────────────── */

interface Tab {
  id: string;
  profile: ConnectionProfile;
  connectionId: string | null;
  connectingError: string | null;
}

let tabCounter = 0;
function nextTabId() {
  return `tab-${++tabCounter}`;
}

/* ── App ────────────────────────────────────────────────── */

function App() {
  const [sidecarReady, setSidecarReady] = useState(false);
  const [sidecarError, setSidecarError] = useState(false);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  /* ── Sidecar boot ─────────────────────────────────────── */

  useEffect(() => {
    waitForSidecar().then((ok) => {
      setSidecarReady(ok);
      setSidecarError(!ok);
    });
  }, []);

  /* ── Listen for connection-selected events ────────────── */

  useEffect(() => {
    const unlisten = listen<{ profile: ConnectionProfile; connectionId: string }>(
      "connection-selected",
      async (event) => {
        const { profile, connectionId: preOpenedId } = event.payload;

        const tabId = nextTabId();
        const newTab: Tab = {
          id: tabId,
          profile,
          connectionId: preOpenedId,
          connectingError: null,
        };

        setTabs((prev) => [...prev, newTab]);
        setActiveTabId(tabId);

        // Main window starts hidden; reveal it when a connection is picked.
        await getCurrentWindow().show();
        await getCurrentWindow().setFocus();
      },
    );
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  /* ── Close a tab ──────────────────────────────────────── */

  const closeTab = useCallback((tabId: string) => {
    const tab = tabsRef.current.find((t) => t.id === tabId);
    if (tab?.connectionId) {
      closeConnection(tab.connectionId).catch(() => {});
    }

    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId);
      return next;
    });

    setActiveTabId((prevActive) => {
      if (prevActive !== tabId) return prevActive;
      // Switch to the nearest remaining tab
      const current = tabsRef.current;
      const idx = current.findIndex((t) => t.id === tabId);
      const remaining = current.filter((t) => t.id !== tabId);
      if (remaining.length === 0) return null;
      const newIdx = Math.min(idx, remaining.length - 1);
      return remaining[newIdx].id;
    });
  }, []);

  /* ── Cleanup on unmount ───────────────────────────────── */

  useEffect(() => {
    return () => {
      for (const tab of tabsRef.current) {
        if (tab.connectionId) closeConnection(tab.connectionId).catch(() => {});
      }
    };
  }, []);

  const handleTableSelect = useCallback((db: string, schema: string, table: string) => {
    console.log("[schema] table selected:", { db, schema, table });
  }, []);

  /* ── Loading ──────────────────────────────────────────── */

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

  /* ── Error ─────────────────────────────────────────────── */

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

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  return (
    <div className="flex flex-col h-screen bg-bg-primary">
      {/* ── Tab bar ─────────────────────────────────────────── */}
      <div
        className="flex items-center h-9 border-b border-border bg-bg-secondary shrink-0"
        data-tauri-drag-region
      >
        {/* Tabs */}
        <div className="flex items-center min-w-0 flex-1 overflow-x-auto no-scrollbar">
          {tabs.map((tab) => (
            <TabItem
              key={tab.id}
              tab={tab}
              active={tab.id === activeTabId}
              onActivate={() => setActiveTabId(tab.id)}
              onClose={() => closeTab(tab.id)}
            />
          ))}
        </div>

        {/* New connection button */}
        <button
          onClick={() => openConnectionManager()}
          title="New Connection"
          className="flex items-center p-1.5 mx-1 rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer shrink-0"
        >
          <PlugZap size={14} />
        </button>
      </div>

      {/* ── Body ────────────────────────────────────────────── */}
      {!activeTab ? (
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
              {activeTab.connectingError && (
                <div className="flex items-start gap-2 px-3 py-4 text-xs text-error">
                  <ServerCrash size={14} className="shrink-0 mt-0.5" />
                  {activeTab.connectingError}
                </div>
              )}
              {!activeTab.connectionId && !activeTab.connectingError && (
                <div className="flex items-center gap-2 px-3 py-4 text-xs text-text-muted">
                  <Loader2 size={12} className="animate-spin" />
                  Connecting...
                </div>
              )}
              {activeTab.connectionId && (
                <SchemaTree
                  connectionId={activeTab.connectionId}
                  connectionType={activeTab.profile.type}
                  connectionDatabase={activeTab.profile.database}
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

      {/* ── Status bar ──────────────────────────────────────── */}
      <StatusBar activeTab={activeTab} />
    </div>
  );
}

/* ── Tab item ───────────────────────────────────────────── */

function TabItem({
  tab,
  active,
  onActivate,
  onClose,
}: {
  tab: Tab;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
}) {
  const envStyle = envBadgeStyle(tab.profile.env);
  const connected = !!tab.connectionId;
  const connecting = !tab.connectionId && !tab.connectingError;
  const hasError = !!tab.connectingError;

  return (
    <div
      onClick={onActivate}
      className={`group relative flex items-center gap-1.5 h-full px-3 text-xs cursor-pointer select-none border-r border-border min-w-0 max-w-[180px] transition-colors ${
        active
          ? "bg-bg-primary text-text-primary"
          : "bg-bg-secondary text-text-muted hover:text-text-secondary hover:bg-bg-hover"
      }`}
      style={{ paddingTop: 6, paddingBottom: 6 }}
    >
      {/* Connection status dot */}
      <span
        className={`w-2 h-2 rounded-full shrink-0 ${
          hasError ? "bg-error" : connecting ? "bg-warning animate-pulse" : "bg-success"
        }`}
        style={connected ? { backgroundColor: tab.profile.color || undefined } : undefined}
      />

      {/* Name */}
      <span className="truncate font-medium">{tab.profile.name || "Untitled"}</span>

      {/* Env badge */}
      {envStyle && (
        <span
          className="text-[9px] px-1 py-px rounded font-medium shrink-0 leading-tight"
          style={envStyle}
        >
          {tab.profile.env.slice(0, 4)}
        </span>
      )}

      {/* Close button */}
      <button
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        className="shrink-0 ml-auto p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-bg-active transition-all cursor-pointer text-text-muted hover:text-text-primary"
      >
        <X size={10} />
      </button>

      {/* Active indicator line */}
      {active && (
        <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-accent" />
      )}
    </div>
  );
}

/* ── Table icon placeholder ─────────────────────────────── */

function Table2Icon() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mx-auto text-text-muted opacity-30">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18M3 15h18M9 3v18" />
    </svg>
  );
}

/* ── Status bar ─────────────────────────────────────────── */

function StatusBar({ activeTab }: { activeTab: Tab | null }) {
  const { mode, setMode } = useThemeStore();

  return (
    <div className="flex items-center justify-between h-6 px-3 border-t border-border bg-bg-secondary shrink-0 text-[11px] text-text-muted">
      {/* Left: connection status */}
      <div className="flex items-center gap-2">
        {activeTab?.connectionId && (
          <>
            <span className="w-1.5 h-1.5 rounded-full bg-success" />
            <span>Connected · {activeTab.profile.type}</span>
          </>
        )}
        {activeTab && !activeTab.connectionId && !activeTab.connectingError && (
          <>
            <Loader2 size={9} className="animate-spin" />
            <span>Connecting...</span>
          </>
        )}
        {activeTab?.connectingError && (
          <span className="text-error">Connection failed</span>
        )}
        {!activeTab && <span>Not connected</span>}
      </div>

      {/* Right: theme toggle */}
      <div className="flex items-center gap-0.5">
        <ThemeButton current={mode} value="light" setMode={setMode} icon={<Sun size={11} />} label="Light" />
        <ThemeButton current={mode} value="dark" setMode={setMode} icon={<Moon size={11} />} label="Dark" />
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
