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
  Table2,
  Eye,
  PanelLeft,
  PanelBottom,
  Plus,
} from "lucide-react";
import { waitForSidecar } from "./lib/sidecar";
import { openConnectionManager } from "./lib/openConnectionManager";
import { closeConnection } from "./lib/schema";
import { useThemeStore, type ThemeMode, initTheme } from "./lib/theme";
import { useWindowPersist } from "./lib/useWindowPersist";
import { loadConfig, getConfig, saveConfig, queryStackPop, queryStackPush } from "./lib/config";
import { useQueryLog } from "./lib/queryLog";
import { SchemaTree } from "./components/SchemaTree";
import { DataTable } from "./components/DataTable";
import { QueryEditor } from "./components/QueryEditor";
import { QueryConsole } from "./components/QueryConsole";
import type { ConnectionProfile } from "./lib/types";
import { envBadgeStyle } from "./lib/types";

/* ── Tab types ──────────────────────────────────────────── */

interface ContentTab {
  id: string;
  db: string;
  schema: string;
  table: string;
  type: "table" | "view" | "query";
  sql?: string; // live SQL for query tabs (not stored by ID)
}

interface Tab {
  id: string;
  profile: ConnectionProfile;
  connectionId: string | null;
  connectingError: string | null;
  serverVersion: string;
  contentTabs: ContentTab[];
  activeContentTabId: string | null;
}

let tabCounter = 0;
function nextTabId() {
  return `tab-${++tabCounter}`;
}

function nextContentTabId() {
  return `ct-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/* ── App ────────────────────────────────────────────────── */

function App() {
  useWindowPersist();
  const [configReady, setConfigReady] = useState(false);
  const [sidecarReady, setSidecarReady] = useState(false);
  const [sidecarError, setSidecarError] = useState(false);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  // Panel visibility — initialized from config after load
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [consoleVisible, setConsoleVisible] = useState(false);

  // Load config on mount — sets theme, panel states
  const { setMode: setThemeMode } = useThemeStore();
  useEffect(() => {
    loadConfig().then((cfg) => {
      const mode = initTheme();
      setThemeMode(cfg.theme || mode);
      if (cfg.sidebar?.visible !== undefined) setSidebarVisible(cfg.sidebar.visible);
      if (cfg.console?.visible !== undefined) setConsoleVisible(cfg.console.visible);
      setConfigReady(true);
    });
  }, []);

  // Enable/disable query logging when console visibility changes
  const setLogEnabled = useQueryLog((s) => s.setEnabled);
  useEffect(() => {
    setLogEnabled(consoleVisible);
  }, [consoleVisible, setLogEnabled]);

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
    const unlisten = listen<{ profile: ConnectionProfile; connectionId: string; serverVersion?: string }>(
      "connection-selected",
      async (event) => {
        const { profile, connectionId: preOpenedId, serverVersion } = event.payload;

        const tabId = nextTabId();
        const newTab: Tab = {
          id: tabId,
          profile,
          connectionId: preOpenedId,
          connectingError: null,
          serverVersion: serverVersion || "",
          contentTabs: [],
          activeContentTabId: null,
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

  const handleTableSelect = useCallback((db: string, schema: string, table: string, type: "table" | "view" = "table") => {
    setTabs((prev) => prev.map((tab) => {
      if (tab.id !== activeTabId) return tab;

      const existing = tab.contentTabs.find(
        (ct) => ct.db === db && ct.schema === schema && ct.table === table,
      );
      if (existing) {
        return { ...tab, activeContentTabId: existing.id };
      }

      const ct: ContentTab = {
        id: nextContentTabId(),
        db,
        schema,
        table,
        type,
      };
      return {
        ...tab,
        contentTabs: [...tab.contentTabs, ct],
        activeContentTabId: ct.id,
      };
    }));
  }, [activeTabId]);

  const closeContentTab = useCallback((contentTabId: string) => {
    setTabs((prev) => prev.map((tab) => {
      if (tab.id !== activeTabId) return tab;
      const closing = tab.contentTabs.find((ct) => ct.id === contentTabId);
      // Push query SQL to stack on close
      if (closing?.type === "query" && closing.sql) {
        queryStackPush(closing.sql);
      }
      const idx = tab.contentTabs.findIndex((ct) => ct.id === contentTabId);
      const next = tab.contentTabs.filter((ct) => ct.id !== contentTabId);
      let newActiveId = tab.activeContentTabId;
      if (tab.activeContentTabId === contentTabId) {
        newActiveId = next.length === 0 ? null : next[Math.min(idx, next.length - 1)].id;
      }
      return { ...tab, contentTabs: next, activeContentTabId: newActiveId };
    }));
  }, [activeTabId]);

  const setActiveContentTab = useCallback((contentTabId: string) => {
    setTabs((prev) => prev.map((tab) => {
      if (tab.id !== activeTabId) return tab;
      return { ...tab, activeContentTabId: contentTabId };
    }));
  }, [activeTabId]);

  const addQueryTab = useCallback(() => {
    const restoredSql = queryStackPop();
    setTabs((prev) => prev.map((tab) => {
      if (tab.id !== activeTabId) return tab;
      const queryCount = tab.contentTabs.filter((ct) => ct.type === "query").length;
      const ct: ContentTab = {
        id: nextContentTabId(),
        db: "",
        schema: "",
        table: `Query ${queryCount + 1}`,
        type: "query",
        sql: restoredSql || "",
      };
      return {
        ...tab,
        contentTabs: [...tab.contentTabs, ct],
        activeContentTabId: ct.id,
      };
    }));
  }, [activeTabId]);

  /* ── Loading ──────────────────────────────────────────── */

  if (!configReady || (!sidecarReady && !sidecarError)) {
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
        {/* Left toolbar */}
        <div className="flex items-center gap-0.5 mx-1 shrink-0">
          {/* New connection button */}
          <button
            onClick={() => openConnectionManager()}
            title="New Connection"
            className="flex items-center gap-1 px-2 py-1 rounded-md border border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover hover:border-text-muted transition-colors cursor-pointer"
          >
            <Plus size={14} />
          </button>
        </div>

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

        {/* Right toolbar */}
        <div className="flex items-center gap-0.5 mx-1 shrink-0">
          {/* Toggle sidebar */}
          <button
            onClick={() => setSidebarVisible((v) => {
              const next = !v;
              saveConfig({ sidebar: { ...getConfig().sidebar, visible: next, width: getConfig().sidebar?.width ?? 280 } });
              return next;
            })}
            title={sidebarVisible ? "Hide sidebar" : "Show sidebar"}
            className={`flex items-center p-1.5 rounded-md transition-colors cursor-pointer ${
              sidebarVisible
                ? "text-text-primary bg-bg-active"
                : "text-text-muted hover:text-text-secondary hover:bg-bg-hover"
            }`}
          >
            <PanelLeft size={14} />
          </button>

          {/* Toggle console */}
          <button
            onClick={() => setConsoleVisible((v) => {
              const next = !v;
              saveConfig({ console: { ...getConfig().console, visible: next, height: getConfig().console?.height ?? 180 } });
              return next;
            })}
            title={consoleVisible ? "Hide console" : "Show console"}
            className={`flex items-center p-1.5 rounded-md transition-colors cursor-pointer ${
              consoleVisible
                ? "text-text-primary bg-bg-active"
                : "text-text-muted hover:text-text-secondary hover:bg-bg-hover"
            }`}
          >
            <PanelBottom size={14} />
          </button>
        </div>
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
        <div className="flex-1 flex flex-col min-h-0">
          {/* Top section: sidebar + content */}
          <div className="flex-1 flex min-h-0">
            {/* Left sidebar */}
            {sidebarVisible && (
              <ResizableSidebar>
                <aside className="h-full border-r border-border bg-bg-secondary flex flex-col min-h-0">
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
                </aside>
              </ResizableSidebar>
            )}

            {/* Main content */}
            <main className="flex-1 flex flex-col min-h-0 min-w-0 bg-bg-primary">
              {/* Content tab bar — always visible */}
              <div className="flex items-center h-8 border-b border-border bg-bg-secondary shrink-0">
                <div className="flex-1 flex items-center h-full overflow-x-auto no-scrollbar">
                  {activeTab.contentTabs.map((ct) => (
                    <ContentTabItem
                      key={ct.id}
                      ct={ct}
                      active={ct.id === activeTab.activeContentTabId}
                      onActivate={() => setActiveContentTab(ct.id)}
                      onClose={() => closeContentTab(ct.id)}
                    />
                  ))}
                </div>
                <div className="flex items-center px-1.5 shrink-0 border-l border-border">
                  <button
                    onClick={addQueryTab}
                    title="New SQL query tab"
                    className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold tracking-wide text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer border border-border"
                  >
                    <Plus size={10} />
                    SQL
                  </button>
                </div>
              </div>

              {/* Content area */}
              {activeTab.activeContentTabId && activeTab.connectionId ? (
                <div className="flex-1 relative min-h-0 overflow-hidden z-0">
                  {activeTab.contentTabs.map((ct) => (
                    <div
                      key={ct.id}
                      className="absolute inset-0"
                      style={{ display: ct.id === activeTab.activeContentTabId ? "block" : "none" }}
                    >
                      {ct.type === "query" ? (
                        <QueryEditor
                          connectionId={activeTab.connectionId!}
                          initialSql={ct.sql || ""}
                          onSqlChange={(sql) => {
                            setTabs((prev) => prev.map((tab) =>
                              tab.id !== activeTab.id ? tab : {
                                ...tab,
                                contentTabs: tab.contentTabs.map((c) =>
                                  c.id !== ct.id ? c : { ...c, sql }
                                ),
                              }
                            ));
                          }}
                        />
                      ) : (
                        <DataTable
                          connectionId={activeTab.connectionId!}
                          db={ct.db}
                          schema={ct.schema}
                          table={ct.table}
                        />
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center min-h-0 gap-4">
                  <img
                    src="/schema-background.png"
                    alt=""
                    className="w-96 h-96 opacity-[0.12] pointer-events-none select-none [html[data-theme=dark]_&]:invert"
                  />
                  <p className="text-text-muted text-sm">Select a table to get started</p>
                </div>
              )}
            </main>
          </div>

          {/* Bottom console panel */}
          {consoleVisible && (
            <ResizableConsole>
              <QueryConsole />
            </ResizableConsole>
          )}
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
      {/* Env badge */}
      {envStyle && (
        <span
          className="text-[9px] px-1 py-px rounded font-medium shrink-0 leading-tight"
          style={envStyle}
        >
          {tab.profile.env.slice(0, 4)}
        </span>
      )}

      {/* Name */}
      <span className="truncate font-medium">{tab.profile.name || "Untitled"}</span>

      {/* Color dot / close button combo */}
      <button
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        title="Close tab"
        className="close-dot relative w-3.5 h-3.5 shrink-0 ml-auto flex items-center justify-center rounded-full cursor-pointer transition-all"
      >
        {/* Color dot — hidden on hover */}
        <span className="close-dot-color absolute inset-0 flex items-center justify-center">
          <span
            className="w-2 h-2 rounded-full"
            style={{ backgroundColor: tab.profile.color || "#888" }}
          />
          {connecting && (
            <span className="absolute inset-[-1px] rounded-full border-[1.5px] border-warning animate-pulse" />
          )}
          {hasError && (
            <span className="absolute inset-[-1px] rounded-full border-[1.5px] border-error" />
          )}
        </span>
        {/* X icon — shown on hover */}
        <span className="close-dot-x hidden text-text-muted">
          <X size={14} />
        </span>
      </button>

      {/* Active indicator line */}
      {active && (
        <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-accent" />
      )}
    </div>
  );
}

/* ── Content tab item ──────────────────────────────────── */

function ContentTabItem({
  ct,
  active,
  onActivate,
  onClose,
}: {
  ct: ContentTab;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
}) {
  return (
    <div
      onClick={onActivate}
      className={`group relative flex items-center gap-1.5 h-full px-3 text-[11px] cursor-pointer select-none border-r border-border min-w-0 max-w-[160px] transition-colors ${
        active
          ? "bg-bg-primary text-text-primary"
          : "bg-bg-secondary text-text-muted hover:text-text-secondary hover:bg-bg-hover"
      }`}
    >
      {ct.type === "query"
        ? <span className="shrink-0 text-[9px] font-bold text-accent leading-none">SQL</span>
        : ct.type === "view"
          ? <Eye size={12} className="shrink-0 text-purple-400" />
          : <Table2 size={12} className="shrink-0 text-accent" />
      }
      <span className="truncate font-medium">{ct.table}</span>
      <button
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        title="Close"
        className={`shrink-0 ml-auto rounded-sm transition-colors cursor-pointer ${
          active
            ? "text-text-muted hover:text-text-primary"
            : "text-transparent group-hover:text-text-muted hover:!text-text-primary"
        }`}
      >
        <X size={12} />
      </button>
      {active && (
        <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-accent" />
      )}
    </div>
  );
}

/* ── Resizable sidebar ──────────────────────────────────── */

function ResizableSidebar({ children }: { children: React.ReactNode }) {
  const [width, setWidth] = useState(() => {
    const saved = getConfig().sidebar?.width;
    return saved ? Math.min(480, Math.max(180, saved)) : 280;
  });
  const dragging = useRef(false);
  const startX = useRef(0);
  const startW = useRef(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const onMouseDown = (e: React.MouseEvent) => {
    dragging.current = true;
    startX.current = e.clientX;
    startW.current = width;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const next = Math.min(480, Math.max(180, startW.current + e.clientX - startX.current));
      setWidth(next);
    };
    const onMouseUp = (e: MouseEvent) => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      const finalWidth = Math.min(480, Math.max(180, startW.current + e.clientX - startX.current));
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        saveConfig({ sidebar: { visible: getConfig().sidebar?.visible ?? true, width: finalWidth } });
      }, 100);
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  return (
    <div className="flex shrink-0 h-full" style={{ width }}>
      <div className="flex-1 min-w-0 h-full">{children}</div>
      {/* Drag handle */}
      <div
        onMouseDown={onMouseDown}
        className="w-[3px] shrink-0 cursor-col-resize hover:bg-accent/50 active:bg-accent transition-colors h-full"
      />
    </div>
  );
}

/* ── Resizable console (bottom panel) ──────────────────── */

function ResizableConsole({ children }: { children: React.ReactNode }) {
  const [height, setHeight] = useState(() => {
    const saved = getConfig().console?.height;
    return saved ? Math.min(500, Math.max(80, saved)) : 180;
  });
  const dragging = useRef(false);
  const startY = useRef(0);
  const startH = useRef(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const onMouseDown = (e: React.MouseEvent) => {
    dragging.current = true;
    startY.current = e.clientY;
    startH.current = height;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  };

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      // Dragging up should increase height
      const delta = startY.current - e.clientY;
      const next = Math.min(500, Math.max(80, startH.current + delta));
      setHeight(next);
    };
    const onMouseUp = (e: MouseEvent) => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      const delta = startY.current - e.clientY;
      const finalHeight = Math.min(500, Math.max(80, startH.current + delta));
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        saveConfig({ console: { visible: getConfig().console?.visible ?? false, height: finalHeight } });
      }, 100);
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  return (
    <div className="flex flex-col shrink-0 border-t border-border" style={{ height }}>
      {/* Drag handle */}
      <div
        onMouseDown={onMouseDown}
        className="h-[3px] shrink-0 cursor-row-resize hover:bg-accent/50 active:bg-accent transition-colors w-full"
      />
      <div className="flex-1 min-h-0">{children}</div>
    </div>
  );
}

/* ── Status bar ─────────────────────────────────────────── */

function StatusBar({ activeTab }: { activeTab: Tab | null }) {
  const { mode, setMode } = useThemeStore();

  return (
    <div className="flex items-center justify-between h-7 px-3 border-t border-border bg-bg-secondary shrink-0 text-xs text-text-secondary">
      {/* Left: connection status */}
      <div className="flex items-center gap-2">
        {activeTab?.connectionId && (
          <>
            <span className="w-1.5 h-1.5 rounded-full bg-success" />
            <span>
              Connected · {activeTab.profile.type}
              {activeTab.serverVersion && ` ${activeTab.serverVersion}`}
            </span>
          </>
        )}
        {activeTab && !activeTab.connectionId && !activeTab.connectingError && (
          <>
            <Loader2 size={9} className="animate-spin" />
            <span>Connecting...</span>
          </>
        )}
        {activeTab?.connectingError && (
          <span>Connection failed</span>
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
