import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Database,
  ServerCrash,
  Loader2,
  Cable,
  Sun,
  Moon,
  Monitor,
  X,
  Table2,
  Eye,
  PanelLeft,
  PanelBottom,
  PanelRight,
  Plus,
  Settings,
  StopCircle,
  FilePenLine,
  RefreshCw,
} from "lucide-react";
import { DragDropProvider, type DragEndEvent } from "@dnd-kit/react";
import { useSortable } from "@dnd-kit/react/sortable";
import { waitForSidecar, CONNECTION_RESTORED_EVENT } from "./lib/sidecar";
import { openConnectionManager } from "./lib/openConnectionManager";
import { closeConnection, reloadConnection } from "./lib/schema";
import { useThemeStore, type ThemeMode, initTheme } from "./lib/theme";
import { useWindowPersist } from "./lib/useWindowPersist";
import { loadConfig, getConfig, saveConfig, queryStackPop, queryStackPush } from "./lib/config";
import { useExecutionQueue } from "./lib/executionQueue";
import { useEditStore } from "./lib/editStore";
import { notifySchemaChanged } from "./lib/schemaRevision";
import { SchemaTree } from "./components/SchemaTree";
import { DataTable } from "./components/DataTable";
import { QueryEditor } from "./components/QueryEditor";
import { QueryConsole } from "./components/QueryConsole";
import { DetailPanel } from "./components/DetailPanel";
import { SettingsModal } from "./components/SettingsModal";
import { KeyboardShortcutsModal } from "./components/KeyboardShortcutsModal";
import { CommandPalette } from "./components/CommandPalette";
import { ChangeHistoryPanel } from "./components/ChangeHistoryPopup";
import type { CellSelection, CellRevealRequest, SortState } from "./components/ResultGrid";
import type { ConnectionProfile } from "./lib/types";
import { envBadgeStyle } from "./lib/types";
import { modKey } from "./lib/platform";

/* ── Tab types ──────────────────────────────────────────── */

interface ContentTab {
  id: string;
  db: string;
  schema: string;
  table: string;
  type: "table" | "view" | "query";
  sql?: string;
  viewMode?: "data" | "structure";
  sort?: SortState | null;
}

interface DbWorkspace {
  db: string;
  contentTabs: ContentTab[];
  activeContentTabId: string | null;
}

interface Tab {
  id: string;
  profile: ConnectionProfile;
  connectionId: string | null;
  connectingError: string | null;
  serverVersion: string;
  openDbs: string[];
  activeDbName: string | null;
  workspaces: Record<string, DbWorkspace>;
}

let tabCounter = 0;
function nextTabId() {
  return `tab-${++tabCounter}`;
}

function nextContentTabId() {
  return `ct-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function moveTab<T extends { id: string }>(items: T[], sourceId: string, targetId: string): T[] {
  const sourceIndex = items.findIndex((item) => item.id === sourceId);
  const targetIndex = items.findIndex((item) => item.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return items;

  const reordered = [...items];
  const [source] = reordered.splice(sourceIndex, 1);
  reordered.splice(targetIndex, 0, source);
  return reordered;
}

function contentTabTitle(tab: ContentTab): string {
  return tab.type === "query"
    ? tab.table
    : [tab.db, tab.schema, tab.table].filter(Boolean).join(".");
}

function defaultSchema(type: "postgres" | "mysql" | "sqlite"): string {
  if (type === "postgres") return "public";
  if (type === "sqlite") return "main";
  return "";
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
  const [detailPanelVisible, setDetailPanelVisible] = useState(false);
  const [cellSelection, setCellSelection] = useState<CellSelection | null>(null);
  const [cellRevealRequest, setCellRevealRequest] = useState<CellRevealRequest | null>(null);
  const cellRevealRequestIdRef = useRef(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState<false | "all" | "db-only">(false);
  const [reconnectNotice, setReconnectNotice] = useState<string | null>(null);
  const [reloadingConnection, setReloadingConnection] = useState(false);

  // Execution queue — subscribe to the connections map for reactivity
  const execConnections = useExecutionQueue((s) => s.connections);
  const execCancel = useExecutionQueue((s) => s.cancel);

  // Edit store — subscribe for change count reactivity
  const editChanges = useEditStore((s) => s.changes);
  const editInserts = useEditStore((s) => s.inserts);
  const editDeletes = useEditStore((s) => s.deletes);
  const editChangeCount = editChanges.size + editInserts.length + editDeletes.size;

  // Track whether detail panel was already open (for focus vs scroll-only behavior)
  const detailPanelWasOpenRef = useRef(detailPanelVisible);

  // Load config on mount — sets theme, panel states
  const { setMode: setThemeMode } = useThemeStore();
  useEffect(() => {
    loadConfig().then((cfg) => {
      const mode = initTheme();
      setThemeMode(cfg.theme || mode);
      if (cfg.sidebar?.visible !== undefined) setSidebarVisible(cfg.sidebar.visible);
      if (cfg.console?.visible !== undefined) setConsoleVisible(cfg.console.visible);
      if (cfg.detailPanel?.visible !== undefined) setDetailPanelVisible(cfg.detailPanel.visible);
      setConfigReady(true);
    });
  }, []);

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const openedConnectionIdsRef = useRef(new Set<string>());
  const addQueryTabRef = useRef<(() => void) | null>(null);
  const requestAddQueryTabRef = useRef<(() => void) | null>(null);
  const pendingAddQueryTabRef = useRef(false);
  const saveAllChangesRef = useRef<(() => void) | null>(null);
  const closeContentTabRef = useRef<(id: string) => void>(() => {});
  const closeDbRef = useRef<(db: string) => void>(() => {});
  const closeTabRef = useRef<(id: string) => void>(() => {});
  const reloadActiveConnectionRef = useRef<(() => void) | null>(null);
  const toggleViewModeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let clearTimer: ReturnType<typeof setTimeout> | undefined;
    const handleRestored = (event: Event) => {
      const detail = (event as CustomEvent<{ connectionId?: string }>).detail;
      const tab = tabsRef.current.find((candidate) => candidate.connectionId === detail?.connectionId);
      setReconnectNotice(tab ? `Reconnected to ${tab.profile.name}` : "Database connection restored");
      clearTimeout(clearTimer);
      clearTimer = setTimeout(() => setReconnectNotice(null), 6_000);
    };
    window.addEventListener(CONNECTION_RESTORED_EVENT, handleRestored);
    return () => {
      window.removeEventListener(CONNECTION_RESTORED_EVENT, handleRestored);
      clearTimeout(clearTimer);
    };
  }, []);

  /* ── Global keyboard shortcuts ────────────────────────── */

  useEffect(() => {
    // Capture phase: Monaco's own keybinding service listens on its container
    // in the bubble phase and calls stopPropagation() for anything it recognizes
    // (Cmd+/, Cmd+K chords, etc.), which otherwise swallows these before a
    // bubble-phase document listener would ever see them. Intercepting during
    // capture guarantees product shortcuts always win over the embedded editor.
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "p") {
        e.preventDefault();
        e.stopPropagation();
        setCommandPaletteOpen((prev) => prev ? false : "all");
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        e.stopPropagation();
        setCommandPaletteOpen((prev) => prev ? false : "db-only");
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "e") {
        e.preventDefault();
        e.stopPropagation();
        requestAddQueryTabRef.current?.();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "n") {
        e.preventDefault();
        e.stopPropagation();
        openConnectionManager();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "l") {
        e.preventDefault();
        e.stopPropagation();
        setSidebarVisible((v) => {
          const next = !v;
          saveConfig({ sidebar: { ...getConfig().sidebar, visible: next, width: getConfig().sidebar?.width ?? 280 } });
          return next;
        });
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        e.stopPropagation();
        setSettingsOpen(true);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        e.preventDefault();
        e.stopPropagation();
        setShortcutsOpen((v) => !v);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ".") {
        e.preventDefault();
        e.stopPropagation();
        setConsoleVisible((visible) => {
          const next = !visible;
          saveConfig({ console: { ...getConfig().console, visible: next, height: getConfig().console?.height ?? 180 } });
          return next;
        });
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "o") {
        e.preventDefault();
        e.stopPropagation();
        setDetailPanelVisible((v) => {
          const next = !v;
          saveConfig({ detailPanel: { ...getConfig().detailPanel, visible: next, width: getConfig().detailPanel?.width ?? 300 } });
          return next;
        });
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "r") {
        e.preventDefault();
        e.stopPropagation();
        reloadActiveConnectionRef.current?.();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "t") {
        e.preventDefault();
        e.stopPropagation();
        toggleViewModeRef.current?.();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        e.stopPropagation();
        saveAllChangesRef.current?.();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "w") {
        e.preventDefault();
        e.stopPropagation();
        const curTabId = activeTabIdRef.current;
        if (!curTabId) {
          // No tabs left — close the window
          getCurrentWindow().close();
          return;
        }
        const curTab = tabsRef.current.find((t) => t.id === curTabId);
        if (!curTab) return;

        // 1. If active db has content tabs, close the active one
        if (curTab.activeDbName) {
          const ws = curTab.workspaces[curTab.activeDbName];
          if (ws && ws.contentTabs.length > 0) {
            const toClose = ws.activeContentTabId || ws.contentTabs[ws.contentTabs.length - 1].id;
            closeContentTabRef.current(toClose);
            return;
          }
          // 2. No content tabs — close the active db tab
          closeDbRef.current(curTab.activeDbName);
          return;
        }

        // 3. No open dbs — close the connection tab
        closeTabRef.current(curTabId);
      }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
        // Undo the latest pending database edit, including inserts and deletes.
        const editStore = useEditStore.getState();
        if (editStore.changeCount() > 0) {
          e.preventDefault();
          e.stopPropagation();
          editStore.revertLast();
        }
        // Otherwise let native undo work (e.g. in the Monaco editor)
      }
    };
    document.addEventListener("keydown", handler, { capture: true });
    return () => document.removeEventListener("keydown", handler, { capture: true });
  }, []);

  /* ── Sidecar boot ─────────────────────────────────────── */

  useEffect(() => {
    waitForSidecar().then((ok) => {
      setSidecarReady(ok);
      setSidecarError(!ok);
    });
  }, []);

  /* ── Clean up all connections when main window is closed ── */

  useEffect(() => {
    const unlisten = getCurrentWindow().onCloseRequested(async () => {
      // Reset the UI and duplicate-event guard before closing connections. The
      // connection manager is shown immediately by Tauri, so a user can start
      // reconnecting while these requests are still in flight.
      const tabsToClose = tabsRef.current;
      tabsRef.current = [];
      openedConnectionIdsRef.current.clear();
      setTabs([]);
      setActiveTabId(null);

      await Promise.all(tabsToClose.map((tab) =>
        tab.connectionId ? closeConnection(tab.connectionId).catch(() => {}) : Promise.resolve(),
      ));
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  /* ── Listen for connection-selected events ────────────── */

  useEffect(() => {
    const unlisten = listen<{ profile: ConnectionProfile; connectionId: string; serverVersion?: string }>(
      "connection-selected",
      async (event) => {
        const { profile, connectionId: preOpenedId, serverVersion } = event.payload;
        const existingTab = tabsRef.current.find((candidate) => candidate.connectionId === preOpenedId);
        if (existingTab) {
          setActiveTabId(existingTab.id);
          await getCurrentWindow().show();
          await getCurrentWindow().setFocus();
          return;
        }
        if (openedConnectionIdsRef.current.has(preOpenedId)) {
          return;
        }
        openedConnectionIdsRef.current.add(preOpenedId);

        const tabId = nextTabId();
        const initialDbs = profile.database ? [profile.database] : [];
        const initialWorkspaces: Record<string, DbWorkspace> = {};
        if (profile.database) {
          // Default database known up front — jump straight into a fresh query
          // tab instead of making the user click "+ SQL" after connecting.
          const restoredSql = queryStackPop();
          const ct: ContentTab = {
            id: nextContentTabId(),
            db: profile.database,
            schema: defaultSchema(profile.type),
            table: "Query 1",
            type: "query",
            sql: restoredSql || "",
          };
          initialWorkspaces[profile.database] = {
            db: profile.database,
            contentTabs: [ct],
            activeContentTabId: ct.id,
          };
        }

        const newTab: Tab = {
          id: tabId,
          profile,
          connectionId: preOpenedId,
          connectingError: null,
          serverVersion: serverVersion || "",
          openDbs: initialDbs,
          activeDbName: profile.database || null,
          workspaces: initialWorkspaces,
        };

        setTabs((prev) => [...prev, newTab]);
        setActiveTabId(tabId);

        // No default database — prompt for one right away instead of leaving
        // the user staring at an empty schema tree.
        if (!profile.database) {
          setCommandPaletteOpen("db-only");
        }

        await getCurrentWindow().show();
        await getCurrentWindow().setFocus();
      },
    );
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  /* ── Close a connection tab ────────────────────────────── */

  const closeTab = useCallback((tabId: string) => {
    const tab = tabsRef.current.find((t) => t.id === tabId);
    if (tab?.connectionId) {
      openedConnectionIdsRef.current.delete(tab.connectionId);
      closeConnection(tab.connectionId).catch(() => {});
    }

    setTabs((prev) => prev.filter((t) => t.id !== tabId));

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

  /* ── DB workspace helpers ──────────────────────────────── */

  const openDb = useCallback((db: string) => {
    setTabs((prev) => prev.map((t) => {
      if (t.id !== activeTabId) return t;
      const newDbs = t.openDbs.includes(db) ? t.openDbs : [...t.openDbs, db];
      const newWorkspaces = { ...t.workspaces };
      if (!newWorkspaces[db]) {
        newWorkspaces[db] = { db, contentTabs: [], activeContentTabId: null };
      }
      return { ...t, openDbs: newDbs, activeDbName: db, workspaces: newWorkspaces };
    }));
  }, [activeTabId]);

  const closeDb = useCallback((db: string) => {
    setTabs((prev) => prev.map((t) => {
      if (t.id !== activeTabId) return t;
      const newDbs = t.openDbs.filter((d) => d !== db);
      const newWorkspaces = { ...t.workspaces };
      // Save query SQL before removing
      const ws = newWorkspaces[db];
      if (ws) {
        for (const ct of ws.contentTabs) {
          if (ct.type === "query" && ct.sql) queryStackPush(ct.sql);
        }
      }
      delete newWorkspaces[db];
      const newActive = t.activeDbName === db
        ? (newDbs.length > 0 ? newDbs[newDbs.length - 1] : null)
        : t.activeDbName;
      if (t.activeDbName === db) setCellSelection(null);
      return { ...t, openDbs: newDbs, activeDbName: newActive, workspaces: newWorkspaces };
    }));
  }, [activeTabId]);

  const setActiveDb = useCallback((db: string) => {
    setTabs((prev) => prev.map((t) =>
      t.id !== activeTabId ? t : { ...t, activeDbName: db }
    ));
  }, [activeTabId]);

  const reorderDbs = useCallback((sourceDb: string, targetDb: string) => {
    setTabs((prev) => prev.map((tab) => {
      if (tab.id !== activeTabId) return tab;
      const sourceIndex = tab.openDbs.indexOf(sourceDb);
      const targetIndex = tab.openDbs.indexOf(targetDb);
      if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return tab;

      const openDbs = [...tab.openDbs];
      const [source] = openDbs.splice(sourceIndex, 1);
      openDbs.splice(targetIndex, 0, source);
      return { ...tab, openDbs };
    }));
  }, [activeTabId]);

  /* ── Content tab helpers (now workspace-scoped) ────────── */

  const handleTableSelect = useCallback((db: string, schema: string, table: string, type: "table" | "view" = "table") => {
    setTabs((prev) => prev.map((tab) => {
      if (tab.id !== activeTabId) return tab;
      const ws = tab.workspaces[db];
      if (!ws) return tab;

      const existing = ws.contentTabs.find(
        (ct) => ct.db === db && ct.schema === schema && ct.table === table,
      );
      if (existing) {
        const updatedWs = { ...ws, activeContentTabId: existing.id };
        return { ...tab, activeDbName: db, workspaces: { ...tab.workspaces, [db]: updatedWs } };
      }

      const ct: ContentTab = { id: nextContentTabId(), db, schema, table, type };
      const updatedWs = {
        ...ws,
        contentTabs: [...ws.contentTabs, ct],
        activeContentTabId: ct.id,
      };
      return { ...tab, activeDbName: db, workspaces: { ...tab.workspaces, [db]: updatedWs } };
    }));
  }, [activeTabId]);

  const closeContentTab = useCallback((contentTabId: string) => {
    setTabs((prev) => prev.map((tab) => {
      if (tab.id !== activeTabId || !tab.activeDbName) return tab;
      const ws = tab.workspaces[tab.activeDbName];
      if (!ws) return tab;

      const closing = ws.contentTabs.find((ct) => ct.id === contentTabId);
      if (closing?.type === "query" && closing.sql) {
        queryStackPush(closing.sql);
      }
      const idx = ws.contentTabs.findIndex((ct) => ct.id === contentTabId);
      const next = ws.contentTabs.filter((ct) => ct.id !== contentTabId);
      let newActiveId = ws.activeContentTabId;
      if (ws.activeContentTabId === contentTabId) {
        newActiveId = next.length === 0 ? null : next[Math.min(idx, next.length - 1)].id;
        setCellSelection(null);
      }
      const updatedWs = { ...ws, contentTabs: next, activeContentTabId: newActiveId };
      return { ...tab, workspaces: { ...tab.workspaces, [tab.activeDbName]: updatedWs } };
    }));
  }, [activeTabId]);

  const handleTableDrop = useCallback((db: string, schema: string, table: string) => {
    setTabs((prev) => prev.map((tab) => {
      if (tab.id !== activeTabId) return tab;
      const ws = tab.workspaces[db];
      if (!ws) return tab;

      const droppedIdx = ws.contentTabs.findIndex((contentTab) =>
        contentTab.type !== "query"
        && contentTab.db === db
        && contentTab.schema === schema
        && contentTab.table === table,
      );
      if (droppedIdx < 0) return tab;

      const dropped = ws.contentTabs[droppedIdx];
      const contentTabs = ws.contentTabs.filter((contentTab) => contentTab.id !== dropped.id);
      const activeContentTabId = ws.activeContentTabId === dropped.id
        ? contentTabs[Math.min(droppedIdx, contentTabs.length - 1)]?.id ?? null
        : ws.activeContentTabId;
      return {
        ...tab,
        workspaces: { ...tab.workspaces, [db]: { ...ws, contentTabs, activeContentTabId } },
      };
    }));
    setCellSelection(null);
  }, [activeTabId]);

  closeContentTabRef.current = closeContentTab;
  closeDbRef.current = closeDb;
  closeTabRef.current = closeTab;

  const setActiveContentTab = useCallback((contentTabId: string) => {
    setTabs((prev) => prev.map((tab) => {
      if (tab.id !== activeTabId || !tab.activeDbName) return tab;
      const ws = tab.workspaces[tab.activeDbName];
      if (!ws) return tab;
      const updatedWs = { ...ws, activeContentTabId: contentTabId };
      return { ...tab, workspaces: { ...tab.workspaces, [tab.activeDbName]: updatedWs } };
    }));
  }, [activeTabId]);

  const reorderContentTabs = useCallback((sourceId: string, targetId: string) => {
    setTabs((prev) => prev.map((tab) => {
      if (tab.id !== activeTabId || !tab.activeDbName) return tab;
      const workspace = tab.workspaces[tab.activeDbName];
      if (!workspace) return tab;
      const contentTabs = moveTab(workspace.contentTabs, sourceId, targetId);
      return contentTabs === workspace.contentTabs
        ? tab
        : { ...tab, workspaces: { ...tab.workspaces, [tab.activeDbName]: { ...workspace, contentTabs } } };
    }));
  }, [activeTabId]);

  const reorderConnectionTabs = useCallback((sourceId: string, targetId: string) => {
    setTabs((prev) => moveTab(prev, sourceId, targetId));
  }, []);

  const addQueryTab = useCallback(() => {
    setTabs((prev) => prev.map((tab) => {
      if (tab.id !== activeTabId || !tab.activeDbName) return tab;
      const ws = tab.workspaces[tab.activeDbName];
      if (!ws) return tab;

      const restoredSql = queryStackPop();
      const queryCount = ws.contentTabs.filter((ct) => ct.type === "query").length;
      const ct: ContentTab = {
        id: nextContentTabId(),
        db: tab.activeDbName,
        schema: defaultSchema(tab.profile.type),
        table: `Query ${queryCount + 1}`,
        type: "query",
        sql: restoredSql || "",
      };
      const updatedWs = {
        ...ws,
        contentTabs: [...ws.contentTabs, ct],
        activeContentTabId: ct.id,
      };
      return { ...tab, workspaces: { ...tab.workspaces, [tab.activeDbName]: updatedWs } };
    }));
  }, [activeTabId]);
  addQueryTabRef.current = addQueryTab;

  /* ── Save all pending changes ────────────────────────── */

  const execQueue = useExecutionQueue((s) => s.execute);
  const saveAllChanges = useCallback(async () => {
    const store = useEditStore.getState();
    const statements = store.buildAllSql();
    if (statements.length === 0) return;

    const refreshedTables = [];
    for (const { sql, type, id, connectionId, db, schema, table, rowKey } of statements) {
      try {
        await execQueue(connectionId, sql, db);
        // Remove from store on success
        if (type === "update") {
          if (rowKey) store.removeRow(rowKey);
        } else if (type === "insert") {
          store.removeInsert(id);
        } else if (type === "delete") {
          if (rowKey) store.removeDelete(rowKey);
        }
        refreshedTables.push({ connectionId, db, schema, table });
      } catch (err) {
        console.error("Failed to save:", err);
        break; // Stop on first error
      }
    }
    if (refreshedTables.length > 0) store.requestDataRefresh(refreshedTables);
  }, [execQueue]);
  saveAllChangesRef.current = saveAllChanges;

  /* ── Track detail panel visibility for scroll/focus ───── */

  const handleCellSelection = useCallback((sel: CellSelection | null) => {
    detailPanelWasOpenRef.current = detailPanelVisible;
    setCellRevealRequest(null);
    setCellSelection(sel);
    // Auto-open detail pane for new insert rows
    if (sel?.insertId && !detailPanelVisible) {
      setDetailPanelVisible(true);
    }
  }, [detailPanelVisible]);

  const handleDetailFieldActivate = useCallback((colIndex: number) => {
    if (!cellSelection) return;
    setCellRevealRequest({
      rowIndex: cellSelection.rowIndex,
      colIndex,
      requestId: ++cellRevealRequestIdRef.current,
    });
  }, [cellSelection]);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  // Opening a new SQL query tab requires an active database. If none is set yet
  // (e.g. a server-level connection with no default database), open the database
  // picker instead of no-op'ing — selecting a db there chains straight into
  // creating the query tab (see onSelectDb below).
  const requestAddQueryTab = useCallback(() => {
    if (activeTab?.activeDbName) {
      addQueryTab();
    } else {
      pendingAddQueryTabRef.current = true;
      setCommandPaletteOpen("db-only");
    }
  }, [activeTab, addQueryTab]);
  requestAddQueryTabRef.current = requestAddQueryTab;

  const activeWorkspace = activeTab?.activeDbName
    ? activeTab.workspaces[activeTab.activeDbName] ?? null
    : null;
  const activeContentTab = activeWorkspace?.contentTabs.find((tab) => tab.id === activeWorkspace.activeContentTabId);

  // Clear the selected cell/row whenever the visible table/query view changes —
  // otherwise the detail panel keeps showing a row from a tab/connection that's
  // no longer on screen.
  useEffect(() => {
    setCellSelection(null);
  }, [activeTabId, activeTab?.activeDbName, activeContentTab?.id]);

  /* ── Loading ──────────────────────────────────────────── */

  if (!configReady || (!sidecarReady && !sidecarError)) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-bg-primary">
        <Database size={40} className="text-accent mb-4" />
        <h1 className="text-2xl font-bold mb-1 text-text-primary">SGSql</h1>
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
        <h1 className="text-2xl font-bold mb-1 text-text-primary">SGSql</h1>
        <p className="text-text-secondary mb-6 text-sm">Stupidly Good SQL</p>
        <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-error/10 text-error text-sm">
          <span className="w-2 h-2 rounded-full bg-error" />
          Sidecar not reachable
        </div>
      </div>
    );
  }

  const isRunning = activeTab?.connectionId
    ? (execConnections.get(activeTab.connectionId)?.running ?? false)
    : false;

  const reloadActiveConnection = async () => {
    if (!activeTab?.connectionId || reloadingConnection) return;
    setReloadingConnection(true);
    try {
      await reloadConnection(activeTab.connectionId);
      notifySchemaChanged(activeTab.connectionId);
      setReconnectNotice(`Reloaded ${activeTab.profile.name}`);
      window.setTimeout(() => setReconnectNotice(null), 6_000);
      const openTables = Object.values(activeTab.workspaces).flatMap((workspace) =>
        workspace.contentTabs
          .filter((contentTab) => contentTab.type !== "query")
          .map((contentTab) => ({
            connectionId: activeTab.connectionId!,
            db: contentTab.db,
            schema: contentTab.schema,
            table: contentTab.table,
          })),
      );
      if (openTables.length > 0) useEditStore.getState().requestDataRefresh(openTables);
    } catch (error) {
      setReconnectNotice(error instanceof Error ? error.message : "Failed to reload connection");
      window.setTimeout(() => setReconnectNotice(null), 6_000);
    } finally {
      setReloadingConnection(false);
    }
  };
  reloadActiveConnectionRef.current = reloadActiveConnection;

  const toggleActiveViewMode = () => {
    if (!activeTab || !activeWorkspace || !activeContentTab) return;
    if (activeContentTab.type === "query") return;
    const nextMode: "data" | "structure" = (activeContentTab.viewMode ?? "data") === "data" ? "structure" : "data";
    setTabs((prev) => prev.map((tab) => {
      if (tab.id !== activeTab.id) return tab;
      const ws = tab.workspaces[activeWorkspace.db];
      if (!ws) return tab;
      return { ...tab, workspaces: { ...tab.workspaces, [activeWorkspace.db]: { ...ws, contentTabs: ws.contentTabs.map((content) => content.id === activeContentTab.id ? { ...content, viewMode: nextMode } : content) } } };
    }));
  };
  toggleViewModeRef.current = toggleActiveViewMode;

  return (
    <div className="flex flex-col h-screen bg-bg-primary no-select">
      {/* ── Tab bar ─────────────────────────────────────────── */}
      <div
        className="flex items-center h-9 border-b border-border bg-bg-secondary shrink-0"
        data-tauri-drag-region
      >
        {/* Left toolbar */}
        <div className="flex items-center gap-0.5 mx-1 shrink-0">
          <button
            onClick={() => openConnectionManager()}
            title="New Connection"
            className="flex items-center gap-1 px-2 py-1 rounded-md border border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover hover:border-text-muted transition-colors cursor-pointer"
          >
            <Cable size={14} />
          </button>
        </div>

        {/* Tabs */}
        <DragDropProvider
          onDragEnd={(event: DragEndEvent) => {
            const { source, target, canceled } = event.operation;
            if (canceled || !target || !source || !("index" in source) || !("index" in target)) return;
            const sourceIdx = source.index as number;
            const targetIdx = target.index as number;
            if (sourceIdx !== targetIdx) {
              const sourceId = tabs[sourceIdx]?.id;
              const targetId = tabs[targetIdx]?.id;
              if (sourceId && targetId) {
                reorderConnectionTabs(sourceId, targetId);
              }
            }
          }}
        >
          <div className="flex items-center min-w-0 flex-1 overflow-x-auto no-scrollbar">
            {tabs.map((tab, index) => (
              <TabItem
                key={tab.id}
                tab={tab}
                index={index}
                active={tab.id === activeTabId}
                onActivate={() => setActiveTabId(tab.id)}
                onClose={() => closeTab(tab.id)}
              />
            ))}
          </div>
        </DragDropProvider>

        {/* Right toolbar */}
        <div className="flex items-center gap-0.5 mx-1 shrink-0 relative">
          {/* Kill running query */}
          {isRunning && activeTab?.connectionId && (
            <button
              onClick={() => execCancel(activeTab.connectionId!)}
              title="Kill running query"
              className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-error hover:bg-error/10 transition-colors cursor-pointer border border-error/30"
            >
              <StopCircle size={12} />
              Kill
            </button>
          )}

          {/* Spacer */}
          <div className="w-px h-4 bg-border mx-1" />

          {/* Reload active connection */}
          <button
            onClick={reloadActiveConnection}
            disabled={!activeTab?.connectionId || reloadingConnection}
            title={`Reload connection (${modKey("R")})`}
            className="flex items-center p-1.5 rounded-md transition-colors cursor-pointer text-text-muted hover:text-text-secondary hover:bg-bg-hover disabled:opacity-35 disabled:cursor-default disabled:hover:bg-transparent"
          >
            <RefreshCw size={14} className={reloadingConnection ? "animate-spin" : ""} />
          </button>

          {/* Toggle sidebar */}
          <button
            onClick={() => setSidebarVisible((v) => {
              const next = !v;
              saveConfig({ sidebar: { ...getConfig().sidebar, visible: next, width: getConfig().sidebar?.width ?? 280 } });
              return next;
            })}
            title={`${sidebarVisible ? "Hide" : "Show"} sidebar (${modKey("L")})`}
            className={`flex items-center p-1.5 rounded-md transition-colors cursor-pointer ${
              sidebarVisible
                ? "text-text-primary bg-bg-active"
                : "text-text-muted hover:text-text-secondary hover:bg-bg-hover"
            }`}
          >
            <PanelLeft size={14} />
          </button>

          {/* Toggle detail panel */}
          <button
            onClick={() => setDetailPanelVisible((v) => {
              const next = !v;
              saveConfig({ detailPanel: { ...getConfig().detailPanel, visible: next, width: getConfig().detailPanel?.width ?? 300 } });
              return next;
            })}
            title={`${detailPanelVisible ? "Hide" : "Show"} detail panel (${modKey("O")})`}
            className={`flex items-center p-1.5 rounded-md transition-colors cursor-pointer ${
              detailPanelVisible
                ? "text-text-primary bg-bg-active"
                : "text-text-muted hover:text-text-secondary hover:bg-bg-hover"
            }`}
          >
            <PanelRight size={14} />
          </button>

          {/* Settings */}
          <button
            onClick={() => setSettingsOpen(true)}
            title={`Settings (${modKey(",")})`}
            className="flex items-center p-1.5 rounded-md transition-colors cursor-pointer text-text-muted hover:text-text-secondary hover:bg-bg-hover"
          >
            <Settings size={14} />
          </button>
        </div>
      </div>

      {/* Settings modal */}
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onShowShortcuts={() => { setSettingsOpen(false); setShortcutsOpen(true); }}
      />
      <KeyboardShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />

      {/* Command Palette */}
      {commandPaletteOpen && activeTab?.connectionId && (
        <CommandPalette
          connectionId={activeTab.connectionId}
          connectionType={activeTab.profile.type}
          connectionDatabase={activeTab.profile.database}
          currentDatabase={activeTab.activeDbName}
          cacheKey={activeTab.profile.id}
          mode={commandPaletteOpen}
          onSelectDb={(db) => {
            openDb(db);
            if (pendingAddQueryTabRef.current) {
              pendingAddQueryTabRef.current = false;
              // Use setTimeout to let state settle before opening the query tab
              setTimeout(() => addQueryTabRef.current?.(), 0);
            }
          }}
          onSelectTable={(db, schema, table, type) => {
            // Ensure db is open first
            openDb(db);
            pendingAddQueryTabRef.current = false;
            // Use setTimeout to let state settle before opening the table
            setTimeout(() => handleTableSelect(db, schema, table, type), 0);
          }}
          onClose={() => { pendingAddQueryTabRef.current = false; setCommandPaletteOpen(false); }}
        />
      )}

      {reconnectNotice && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[10000] flex items-center gap-2 rounded-lg border border-success/30 bg-bg-primary px-4 py-2.5 text-xs text-success shadow-2xl">
          <Cable size={13} />
          {reconnectNotice}
        </div>
      )}

      {/* ── Body ────────────────────────────────────────────── */}
      {!activeTab ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <img src="/logo-nobg.png" alt="SGSql" className="w-36 h-36 mx-auto mb-4" />
            <h1 className="text-3xl font-bold mb-1 text-text-primary">SGSql</h1>
            <p className="text-text-secondary mb-6 text-sm">Stupidly Good SQL</p>
            <button
              onClick={() => openConnectionManager()}
              className="flex items-center gap-2 mx-auto px-5 py-2 text-sm rounded-lg bg-accent hover:bg-accent-hover text-white transition-colors cursor-pointer"
            >
              <Cable size={14} />
              Open Connection Manager
            </button>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex-1 flex min-h-0">
            {/* Left sidebar: db tabs always visible, table list toggleable */}
            {activeTab.connectionId && (
              <SchemaTree
                connectionId={activeTab.connectionId}
                connectionType={activeTab.profile.type}
                openDbs={activeTab.openDbs}
                activeDb={activeTab.activeDbName}
                onActiveDbChange={setActiveDb}
                onCloseDb={closeDb}
                onDbReorder={reorderDbs}
                onAddDb={() => setCommandPaletteOpen("db-only")}
                onTableSelect={handleTableSelect}
                onTableDrop={handleTableDrop}
                tableListVisible={sidebarVisible}
              />
            )}
            {!activeTab.connectionId && (
              <aside className="shrink-0 border-r border-border bg-bg-secondary flex flex-col min-h-0">
                {activeTab.connectingError ? (
                  <div className="flex items-start gap-2 px-3 py-4 text-xs text-error w-[90px]">
                    <ServerCrash size={14} className="shrink-0 mt-0.5" />
                  </div>
                ) : (
                  <div className="flex items-center gap-2 px-3 py-4 text-xs text-text-muted w-[90px]">
                    <Loader2 size={12} className="animate-spin" />
                  </div>
                )}
              </aside>
            )}

            {/* Main content */}
            <main className="flex-1 flex flex-col min-h-0 min-w-0 bg-bg-primary">
              {/* Content tab bar — always visible */}
              <div className="flex items-center h-8 border-b border-border bg-bg-secondary shrink-0">
                <DragDropProvider
                  onDragEnd={(event: DragEndEvent) => {
                    const { source, target, canceled } = event.operation;
                    if (canceled || !target || !source || !("index" in source) || !("index" in target) || !activeWorkspace) return;
                    const sourceIdx = source.index as number;
                    const targetIdx = target.index as number;
                    if (sourceIdx !== targetIdx) {
                      const sourceId = activeWorkspace.contentTabs[sourceIdx]?.id;
                      const targetId = activeWorkspace.contentTabs[targetIdx]?.id;
                      if (sourceId && targetId) {
                        reorderContentTabs(sourceId, targetId);
                      }
                    }
                  }}
                >
                  <div className="flex-1 flex items-center h-full overflow-x-auto no-scrollbar">
                    {activeWorkspace?.contentTabs.map((ct, index) => (
                      <ContentTabItem
                        key={ct.id}
                        ct={ct}
                        index={index}
                        active={ct.id === activeWorkspace.activeContentTabId}
                        onActivate={() => setActiveContentTab(ct.id)}
                        onClose={() => closeContentTab(ct.id)}
                      />
                    ))}
                  </div>
                </DragDropProvider>
                <div className="flex items-center px-1.5 shrink-0 border-l border-border">
                  <button
                    onClick={requestAddQueryTab}
                    title={activeTab.activeDbName ? `New SQL query tab (${modKey("E")})` : `Select a database, then start a new SQL query tab (${modKey("E")})`}
                    className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold tracking-wide text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer border border-border"
                  >
                    <Plus size={10} />
                    SQL
                  </button>
                </div>
              </div>

              {/* Content area */}
              {activeTab.connectionId ? (
                <div className="flex-1 relative min-h-0 overflow-hidden z-0">
                  {Object.values(activeTab.workspaces).flatMap((workspace) => workspace.contentTabs.map((ct) => (
                    <div
                      key={ct.id}
                      className="absolute inset-0"
                      style={{ display: workspace.db === activeTab.activeDbName && ct.id === workspace.activeContentTabId ? "block" : "none" }}
                    >
                      {ct.type === "query" ? (
                        <QueryEditor
                          connectionId={activeTab.connectionId!}
                          connectionType={activeTab.profile.type}
                          activeDb={ct.db}
                          initialSql={ct.sql || ""}
                          onCellSelect={handleCellSelection}
                          revealCell={workspace.db === activeTab.activeDbName && ct.id === workspace.activeContentTabId ? cellRevealRequest : null}
                          onSqlChange={(sql) => {
                            setTabs((prev) => prev.map((tab) => {
                              if (tab.id !== activeTab.id) return tab;
                              const ws = tab.workspaces[ct.db];
                              if (!ws) return tab;
                              const updatedWs = {
                                ...ws,
                                contentTabs: ws.contentTabs.map((c) =>
                                  c.id !== ct.id ? c : { ...c, sql }
                                ),
                              };
                              return { ...tab, workspaces: { ...tab.workspaces, [ct.db]: updatedWs } };
                            }));
                          }}
                        />
                      ) : (
                        <DataTable
                          connectionId={activeTab.connectionId!}
                          connectionType={activeTab.profile.type}
                          db={ct.db}
                          schema={ct.schema}
                          table={ct.table}
                          onCellSelect={handleCellSelection}
                          revealCell={workspace.db === activeTab.activeDbName && ct.id === workspace.activeContentTabId ? cellRevealRequest : null}
                          viewMode={ct.viewMode ?? "data"}
                          onViewModeChange={(viewMode) => {
                            setTabs((prev) => prev.map((tab) => {
                              if (tab.id !== activeTab.id) return tab;
                              const ws = tab.workspaces[ct.db];
                              if (!ws) return tab;
                              return { ...tab, workspaces: { ...tab.workspaces, [ct.db]: { ...ws, contentTabs: ws.contentTabs.map((content) => content.id === ct.id ? { ...content, viewMode } : content) } } };
                            }));
                          }}
                          onTableRenamed={(newName) => {
                            setTabs((prev) => prev.map((tab) => {
                              if (tab.id !== activeTab.id) return tab;
                              const ws = tab.workspaces[ct.db];
                              if (!ws) return tab;
                              return { ...tab, workspaces: { ...tab.workspaces, [ct.db]: { ...ws, contentTabs: ws.contentTabs.map((content) => content.id === ct.id ? { ...content, table: newName } : content) } } };
                            }));
                            if (activeTab.connectionId) notifySchemaChanged(activeTab.connectionId);
                          }}
                          sort={ct.sort}
                          onSortChange={(sort) => {
                            setTabs((prev) => prev.map((tab) => {
                              if (tab.id !== activeTab.id) return tab;
                              const ws = tab.workspaces[ct.db];
                              if (!ws) return tab;
                              return { ...tab, workspaces: { ...tab.workspaces, [ct.db]: { ...ws, contentTabs: ws.contentTabs.map((content) => content.id === ct.id ? { ...content, sort } : content) } } };
                            }));
                          }}
                        />
                      )}
                    </div>
                  )))}
                  {!activeContentTab && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
                      <img
                        src="/schema-background.png"
                        alt=""
                        className="w-96 h-96 opacity-[0.12] pointer-events-none select-none [html[data-theme=dark]_&]:invert"
                      />
                      <p className="text-text-muted text-sm">
                        {activeTab.activeDbName ? "Select a table to get started" : "Add a database to get started"}
                      </p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center min-h-0 gap-4">
                  <img
                    src="/schema-background.png"
                    alt=""
                    className="w-96 h-96 opacity-[0.12] pointer-events-none select-none [html[data-theme=dark]_&]:invert"
                  />
                  <p className="text-text-muted text-sm">
                    {activeTab.activeDbName ? "Select a table to get started" : "Add a database to get started"}
                  </p>
                </div>
              )}
              {/* Bottom console panel */}
              {consoleVisible && (
                <ResizableConsole>
                  <ResizableBottomSplit
                    left={<QueryConsole />}
                    right={<ChangeHistoryPanel />}
                  />
                </ResizableConsole>
              )}
            </main>

            {/* Right detail panel */}
            {detailPanelVisible && activeContentTab?.viewMode !== "structure" && (
              <ResizableDetailPanel>
                <aside className="h-full border-l border-border bg-bg-primary">
                  <DetailPanel
                    selection={cellSelection}
                    wasAlreadyOpen={detailPanelWasOpenRef.current}
                    onFieldActivate={handleDetailFieldActivate}
                  />
                </aside>
              </ResizableDetailPanel>
            )}
          </div>
        </div>
      )}

      {/* ── Status bar ──────────────────────────────────────── */}
      <StatusBar
        activeTab={activeTab}
        bottomPanelVisible={consoleVisible}
        editChangeCount={editChangeCount}
        onToggleBottomPanel={() => setConsoleVisible((visible) => {
          const next = !visible;
          saveConfig({ console: { ...getConfig().console, visible: next, height: getConfig().console?.height ?? 180 } });
          return next;
        })}
      />
    </div>
  );
}

/* ── Tab item ───────────────────────────────────────────── */

function TabItem({
  tab,
  index,
  active,
  onActivate,
  onClose,
}: {
  tab: Tab;
  index: number;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
}) {
  const envStyle = envBadgeStyle(tab.profile.env);
  const connecting = !tab.connectionId && !tab.connectingError;
  const hasError = !!tab.connectingError;
  const { ref, isDragSource, isDropTarget } = useSortable({ id: tab.id, index });

  return (
    <div
      ref={ref}
      onClick={onActivate}
      title={tab.profile.name || "Untitled"}
      className={`group relative flex items-center gap-1.5 h-full px-3 text-xs cursor-pointer select-none border-r border-border min-w-0 max-w-[180px] transition-colors ${
        active
          ? "bg-bg-primary text-text-primary"
          : "bg-bg-secondary text-text-muted hover:text-text-secondary hover:bg-bg-hover"
      } ${isDragSource ? "opacity-50" : ""} ${isDropTarget ? "bg-accent/10" : ""}`}
      style={{ paddingTop: 6, paddingBottom: 6 }}
    >
      {envStyle && (
        <span
          className="text-[9px] px-1 py-px rounded font-medium shrink-0 leading-tight"
          style={envStyle}
        >
          {tab.profile.env.slice(0, 4)}
        </span>
      )}
      <span className="truncate font-medium">{tab.profile.name || "Untitled"}</span>
      <button
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        title="Close tab"
        className="close-dot relative w-3.5 h-3.5 shrink-0 ml-auto flex items-center justify-center rounded-full cursor-pointer transition-all"
      >
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
        <span className="close-dot-x hidden text-text-muted">
          <X size={14} />
        </span>
      </button>
      {active && (
        <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-accent" />
      )}
    </div>
  );
}

/* ── Content tab item ──────────────────────────────────── */

function ContentTabItem({
  ct,
  index,
  active,
  onActivate,
  onClose,
}: {
  ct: ContentTab;
  index: number;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
}) {
  const { ref, isDragSource, isDropTarget } = useSortable({ id: ct.id, index });

  return (
    <div
      ref={ref}
      onClick={onActivate}
      title={contentTabTitle(ct)}
      className={`group relative flex items-center gap-1.5 h-full px-3 text-[11px] cursor-pointer select-none border-r border-border min-w-0 max-w-52 transition-colors ${
        active
          ? "bg-bg-primary text-text-primary"
          : "bg-bg-secondary text-text-muted hover:text-text-secondary hover:bg-bg-hover"
      } ${isDragSource ? "opacity-50" : ""} ${isDropTarget ? "bg-accent/10" : ""}`}
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

/* ── Resizable console (bottom panel) ──────────────────── */

function beginResize(cursor: "row-resize" | "col-resize") {
  window.getSelection()?.removeAllRanges();
  document.body.style.cursor = cursor;
  document.body.classList.add("is-resizing");
}

function endResize() {
  document.body.style.cursor = "";
  document.body.classList.remove("is-resizing");
}

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
    e.preventDefault();
    dragging.current = true;
    startY.current = e.clientY;
    startH.current = height;
    beginResize("row-resize");
  };

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      e.preventDefault();
      const delta = startY.current - e.clientY;
      const next = Math.min(500, Math.max(80, startH.current + delta));
      setHeight(next);
    };
    const onMouseUp = (e: MouseEvent) => {
      if (!dragging.current) return;
      dragging.current = false;
      endResize();
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
      if (dragging.current) endResize();
    };
  }, []);

  return (
    <div className="flex flex-col shrink-0 border-t border-border" style={{ height }}>
      <div
        onMouseDown={onMouseDown}
        className="h-[3px] shrink-0 cursor-row-resize hover:bg-accent/50 active:bg-accent transition-colors w-full"
      />
      <div className="flex-1 min-h-0">{children}</div>
    </div>
  );
}

/* ── Resizable split inside the bottom panel ───────────── */

function ResizableBottomSplit({
  left,
  right,
}: {
  left: React.ReactNode;
  right: React.ReactNode;
}) {
  const [leftPercent, setLeftPercent] = useState(() => {
    const saved = getConfig().console?.split;
    return saved === undefined ? 50 : Math.min(70, Math.max(30, saved));
  });
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startPercent = useRef(50);
  const currentPercent = useRef(leftPercent);

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    startX.current = e.clientX;
    startPercent.current = leftPercent;
    currentPercent.current = leftPercent;
    beginResize("col-resize");
  };

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return;
      e.preventDefault();
      const width = containerRef.current.clientWidth;
      if (width === 0) return;
      const next = Math.min(70, Math.max(30, startPercent.current + ((e.clientX - startX.current) / width) * 100));
      currentPercent.current = next;
      setLeftPercent(next);
    };
    const onMouseUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      endResize();
      saveConfig({
        console: {
          visible: getConfig().console?.visible ?? true,
          height: getConfig().console?.height ?? 180,
          split: currentPercent.current,
        },
      });
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      if (dragging.current) endResize();
    };
  }, []);

  return (
    <div ref={containerRef} className="flex h-full min-h-0">
      <div className="min-w-0" style={{ width: `${leftPercent}%` }}>
        {left}
      </div>
      <div
        onMouseDown={onMouseDown}
        title="Resize query log and pending changes"
        className="group w-[5px] shrink-0 cursor-col-resize flex justify-center bg-border/30 hover:bg-accent/15 transition-colors"
      >
        <div className="w-px h-full bg-border group-hover:bg-accent/70 transition-colors" />
      </div>
      <div className="flex-1 min-w-0">
        {right}
      </div>
    </div>
  );
}

/* ── Resizable detail panel (right) ─────────────────────── */

function ResizableDetailPanel({ children }: { children: React.ReactNode }) {
  const [width, setWidth] = useState(() => {
    const saved = getConfig().detailPanel?.width;
    return saved ? Math.min(600, Math.max(200, saved)) : 300;
  });
  const dragging = useRef(false);
  const startX = useRef(0);
  const startW = useRef(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    startX.current = e.clientX;
    startW.current = width;
    beginResize("col-resize");
  };

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      e.preventDefault();
      const delta = startX.current - e.clientX;
      const next = Math.min(600, Math.max(200, startW.current + delta));
      setWidth(next);
    };
    const onMouseUp = (e: MouseEvent) => {
      if (!dragging.current) return;
      dragging.current = false;
      endResize();
      const delta = startX.current - e.clientX;
      const finalWidth = Math.min(600, Math.max(200, startW.current + delta));
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        saveConfig({ detailPanel: { visible: getConfig().detailPanel?.visible ?? true, width: finalWidth } });
      }, 100);
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      if (dragging.current) endResize();
    };
  }, []);

  return (
    <div className="flex shrink-0 h-full" style={{ width }}>
      <div
        onMouseDown={onMouseDown}
        className="w-[3px] shrink-0 cursor-col-resize hover:bg-accent/50 active:bg-accent transition-colors h-full"
      />
      <div className="flex-1 min-w-0 h-full">{children}</div>
    </div>
  );
}

/* ── Status bar ─────────────────────────────────────────── */

function StatusBar({
  activeTab,
  bottomPanelVisible,
  editChangeCount,
  onToggleBottomPanel,
}: {
  activeTab: Tab | null;
  bottomPanelVisible: boolean;
  editChangeCount: number;
  onToggleBottomPanel: () => void;
}) {
  const { mode, setMode } = useThemeStore();

  return (
    <div className="relative flex items-center justify-between h-7 px-3 border-t border-border bg-bg-secondary shrink-0 text-xs text-text-secondary">
      <div className="flex items-center gap-2">
        {activeTab?.connectionId && (
          <>
            <span className="w-1.5 h-1.5 rounded-full bg-success" />
            <span>
              Connected · {activeTab.profile.type}
              {activeTab.serverVersion && ` ${activeTab.serverVersion}`}
              {activeTab.activeDbName && ` · ${activeTab.activeDbName}`}
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
      <div className="absolute left-1/2 -translate-x-1/2 flex items-center">
        <button
          onClick={onToggleBottomPanel}
          title={bottomPanelVisible
            ? `Hide bottom panel (${modKey(".")})`
            : `Show query log and ${editChangeCount} pending change${editChangeCount !== 1 ? "s" : ""} (${modKey(".")})`}
          className={`flex items-center gap-2 px-2 py-1 rounded transition-colors cursor-pointer ${
            bottomPanelVisible
              ? "text-text-primary bg-bg-active"
              : "text-text-muted hover:text-text-secondary hover:bg-bg-hover"
          }`}
        >
          <PanelBottom size={12} />
          <span className={`flex items-center gap-1 text-[10px] font-medium tabular-nums ${
            editChangeCount > 0 ? "text-warning" : "text-text-muted"
          }`}>
            <FilePenLine size={11} />
            <span>{editChangeCount}</span>
          </span>
        </button>
      </div>
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
