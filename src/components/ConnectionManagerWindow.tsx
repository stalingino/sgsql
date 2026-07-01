import { useEffect, useRef, useState, useMemo } from "react";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { DragDropProvider, type DragEndEvent, type DragOverEvent, type DragStartEvent } from "@dnd-kit/react";
import { useSortable } from "@dnd-kit/react/sortable";
import { move } from "@dnd-kit/helpers";
import {
  Plus,
  Trash2,
  FlaskConical,
  Save,
  Zap,
  Database,
  Loader2,
  Search,
  Copy,
  Network,
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  Pencil,
  X,
  FolderPlus,
  Menu,
  Upload,
  Download,
} from "lucide-react";
import { useConnectionsStore } from "../stores/connections";
import {
  type ConnectionProfile,
  type ConnectionEnv,
  createDefaultProfile,
  DB_TYPE_PORTS,
  CONNECTION_COLORS,
  ENV_LABELS,
  DEFAULT_CONNECTION_FOLDER,
} from "../lib/types";
import { formatConnectionUrl, isConnectionUrl, parseConnectionUrl } from "../lib/parseConnectionUrl";
import { openConnection } from "../lib/schema";
import { useWindowPersist } from "../lib/useWindowPersist";
import { reconcileItemGroup, resolveConnectionDropFolder } from "../lib/connectionOrder";

export function ConnectionManagerWindow() {
  useWindowPersist();
  const { profiles, folders, loaded, loadProfiles, addProfile, updateProfile, deleteProfile, reorderProfiles, createFolder, reorderFolders, importProfiles, testConnection, getProfileWithPassword } =
    useConnectionsStore();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ConnectionProfile>(createDefaultProfile());
  const [isNew, setIsNew] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ type: "url" | "ok" | "error"; text: string } | null>(null);
  const [filter, setFilter] = useState("");
  const [contextMenu, setContextMenu] = useState<{ profile: ConnectionProfile; x: number; y: number } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [folderError, setFolderError] = useState<string | null>(null);
  const [dragPreviewProfiles, setDragPreviewProfiles] = useState<ConnectionProfile[] | null>(null);

  const filterRef = useRef<HTMLInputElement>(null);
  const privateKeyRef = useRef<HTMLInputElement>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const folderNameRef = useRef<HTMLInputElement>(null);
  const dragPreviewProfilesRef = useRef<ConnectionProfile[] | null>(null);

  function handleSshToggle(enabled: boolean) {
    updateDraft({ useSsh: enabled });
  }

  function handlePrivateKeyToggle(enabled: boolean) {
    updateDraft({ sshUsePrivateKey: enabled });
  }

  // Auto-focus filter input on launch
  useEffect(() => {
    if (loaded && profiles.length > 0) {
      filterRef.current?.focus();
    }
  }, [loaded, profiles.length > 0]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (folderDialogOpen) requestAnimationFrame(() => folderNameRef.current?.focus());
  }, [folderDialogOpen]);

  const isFiltering = filter.trim().length > 0;
  const visibleProfiles = dragPreviewProfiles ?? profiles;

  const filteredProfiles = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return visibleProfiles;
    return visibleProfiles.filter((p) => fuzzyMatch(q, p));
  }, [visibleProfiles, filter]);

  // Flattened, navigable rows. Every connection belongs to a persisted folder.
  const rows = useMemo(() => {
    const out: ListRow[] = [];
    for (const g of folders) {
      const members = filteredProfiles.filter((p) => (p.group || DEFAULT_CONNECTION_FOLDER) === g);
      if (isFiltering && members.length === 0) continue;
      out.push({ type: "group", name: g, count: members.length });
      // While filtering, force-expand so matches are always visible.
      if (isFiltering || !collapsed.has(g)) {
        for (const p of members) out.push({ type: "conn", profile: p });
      }
    }
    return out;
  }, [filteredProfiles, folders, collapsed, isFiltering]);

  // Keep the keyboard cursor scrolled into view.
  useEffect(() => {
    if (!focusKey) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-rowkey="${cssEscape(focusKey)}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [focusKey, rows]);

  useEffect(() => {
    if (!loaded) loadProfiles();
  }, [loaded, loadProfiles]);

  async function openEditor(p: ConnectionProfile) {
    setSelectedId(p.id);
    setIsNew(false);
    setStatusMsg(null);
    const hydrated = await getProfileWithPassword(p.id);
    setDraft(hydrated ?? p);
    setEditorOpen(true);
    requestAnimationFrame(() => firstFieldRef.current?.focus());
  }

  function handleNewConnection() {
    const def = createDefaultProfile();
    setDraft(def);
    setSelectedId(null);
    setIsNew(true);
    setEditorOpen(true);
    setStatusMsg(null);
    // Land the cursor on the first field so a URL can be pasted immediately.
    requestAnimationFrame(() => {
      firstFieldRef.current?.focus();
      firstFieldRef.current?.select();
    });
  }

  function updateDraft(updates: Partial<ConnectionProfile>) {
    setDraft((d) => {
      const next = { ...d, ...updates };
      if (updates.type && updates.type !== d.type && !updates.port) {
        next.port = DB_TYPE_PORTS[updates.type];
      }
      return next;
    });
  }

  function handleNameChange(value: string) {
    if (isConnectionUrl(value)) {
      const parsed = parseConnectionUrl(value, draft);
      setDraft((d) => ({ ...d, ...parsed }));
      setStatusMsg({ type: "url", text: "Connection URL parsed — fields populated" });
    } else {
      updateDraft({ name: value });
      setStatusMsg(null);
    }
  }

  // Cmd/Ctrl+N — start a fresh connection from anywhere in the window.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && folderDialogOpen) {
        e.preventDefault();
        setFolderDialogOpen(false);
        return;
      }
      if (e.key === "Escape" && editorOpen) {
        e.preventDefault();
        setEditorOpen(false);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        handleNewConnection();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editorOpen, folderDialogOpen]);

  function toggleGroup(name: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }

  /** Move keyboard focus to a row without opening the editor. */
  function focusRow(row: ListRow) {
    if (row.type === "group") {
      setFocusKey(`group:${row.name}`);
    } else {
      setFocusKey(`conn:${row.profile.id}`);
    }
    listRef.current?.focus();
  }

  // Arrow-key tree navigation over the connection list.
  function handleTreeKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") return;
    const idx = rows.findIndex((r) => rowKey(r) === focusKey);
    const row = idx >= 0 ? rows[idx] : null;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (idx < 0) { if (rows[0]) focusRow(rows[0]); return; }
      if (idx < rows.length - 1) focusRow(rows[idx + 1]);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (idx <= 0) { filterRef.current?.focus(); return; }
      focusRow(rows[idx - 1]);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      if (!row) return;
      if (row.type === "group") {
        if (collapsed.has(row.name) && !isFiltering) {
          toggleGroup(row.name);
        } else if (rows[idx + 1]?.type === "conn") {
          focusRow(rows[idx + 1]);
        }
      } else {
        void openEditor(row.profile);
      }
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (!row) return;
      if (row.type === "group") {
        if (!collapsed.has(row.name)) toggleGroup(row.name);
      } else {
        const g = row.profile.group || DEFAULT_CONNECTION_FOLDER;
        if (!collapsed.has(g)) toggleGroup(g);
        setFocusKey(`group:${g}`);
        listRef.current?.focus();
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!row) return;
      if (row.type === "group") toggleGroup(row.name);
      else void connectSavedProfile(row.profile);
    }
  }

  async function handleCreateFolder() {
    try {
      await createFolder(folderName);
      setFolderName("");
      setFolderError(null);
      setFolderDialogOpen(false);
      setStatusMsg({ type: "ok", text: "Folder created" });
    } catch (error) {
      setFolderError(error instanceof Error ? error.message : "Could not create folder");
    }
  }

  function handleExportConnections() {
    const connections = profiles.map((profile) => ({
      ...profile,
      password: "",
      sshPassword: "",
      sshPrivateKey: "",
    }));
    const payload = JSON.stringify({
      version: 1,
      exportedAt: new Date().toISOString(),
      folders,
      connections,
      secretsIncluded: false,
    }, null, 2);
    const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `SGSql-connections-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setMenuOpen(false);
    setStatusMsg({ type: "ok", text: "Connections exported without passwords or private keys" });
  }

  async function handleImportFile(file: File) {
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const container = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
      const rawConnections = Array.isArray(parsed)
        ? parsed
        : Array.isArray(container?.connections)
        ? container.connections
        : Array.isArray(container?.profiles)
        ? container.profiles
        : null;
      if (!rawConnections) throw new Error("This file does not contain a connections list");
      const imported = rawConnections.map((value) => {
        if (!value || typeof value !== "object") throw new Error("The connections file contains an invalid entry");
        const candidate = value as Partial<ConnectionProfile>;
        if (!candidate.name || !["postgres", "mysql", "sqlite"].includes(candidate.type ?? "")) {
          throw new Error("Each imported connection needs a name and supported database type");
        }
        return { ...createDefaultProfile(), ...candidate, id: "" } as ConnectionProfile;
      });
      const importedFolders = Array.isArray(container?.folders)
        ? container.folders.filter((value): value is string => typeof value === "string")
        : [];
      const count = await importProfiles(imported, importedFolders);
      setStatusMsg({ type: "ok", text: `Imported ${count} connection${count === 1 ? "" : "s"}` });
    } catch (error) {
      setStatusMsg({ type: "error", text: error instanceof Error ? error.message : "Import failed" });
    }
  }

  async function handleSave() {
    setSaving(true);
    setStatusMsg(null);
    try {
      if (isNew) {
        const created = await addProfile(draft);
        setSelectedId(created.id);
        setDraft({ ...created, password: draft.password, sshPassword: draft.sshPassword });
        setIsNew(false);
        setStatusMsg({ type: "ok", text: "Connection saved" });
      } else if (selectedId) {
        await updateProfile(selectedId, draft);
        setStatusMsg({ type: "ok", text: "Connection updated" });
      }
    } catch (e: unknown) {
      console.error("[save] failed:", e);
      setStatusMsg({ type: "error", text: e instanceof Error ? e.message : "Save failed" });
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setStatusMsg(null);
    try {
      const result = await testConnection(draft);
      setStatusMsg(
        result.ok
          ? { type: "ok", text: `Connected successfully${result.latency ? ` (${result.latency}ms)` : ""}` }
          : { type: "error", text: result.error ?? "Connection failed" },
      );
    } catch (e: unknown) {
      setStatusMsg({ type: "error", text: e instanceof Error ? e.message : "Failed" });
    } finally {
      setTesting(false);
    }
  }

  async function handleDeleteProfile(id: string) {
    await deleteProfile(id);
    if (selectedId === id) {
      setEditorOpen(false);
      setSelectedId(null);
      setDraft(createDefaultProfile());
      setIsNew(false);
    }
    if (focusKey === `conn:${id}`) setFocusKey(null);
    setStatusMsg(null);
  }

  async function handleDelete() {
    if (!selectedId) return;
    await handleDeleteProfile(selectedId);
  }

  async function handleConnect() {
    // Save first if new
    let profile = draft;
    if (isNew) {
      setSaving(true);
      try {
        const created = await addProfile(draft);
        setSelectedId(created.id);
        setDraft(created);
        setIsNew(false);
        profile = { ...created, password: draft.password, sshPassword: draft.sshPassword };
      } catch (e: unknown) {
        setStatusMsg({ type: "error", text: e instanceof Error ? e.message : "Save failed" });
        setSaving(false);
        return;
      } finally {
        setSaving(false);
      }
    }

    await connectProfile(profile);
  }

  async function connectSavedProfile(profile: ConnectionProfile) {
    const hydrated = await getProfileWithPassword(profile.id);
    await connectProfile(hydrated ?? profile);
  }

  async function connectProfile(profile: ConnectionProfile) {
    if (connecting) return;
    // Open the connection here so the main window opens already connected.
    setConnecting(true);
    setStatusMsg(null);
    let connectionId: string;
    let serverVersion = "";
    try {
      const result = await openConnection(profile);
      connectionId = result.connectionId;
      serverVersion = result.serverVersion || "";
    } catch (e: unknown) {
      setStatusMsg({ type: "error", text: e instanceof Error ? e.message : "Connection failed" });
      setConnecting(false);
      return;
    }

    // Show the main window before closing this one, so Rust doesn't see
    // "all windows hidden" and shut everything down mid-flight.
    const mainWin = await WebviewWindow.getByLabel("main");
    if (mainWin) await mainWin.show();

    // Pass the profile, connectionId, and server version to the main window.
    await emit("connection-selected", { profile, connectionId, serverVersion });
    getCurrentWindow().close();
  }

  async function handleCopyAsUrl(profile: ConnectionProfile) {
    const hydrated = await getProfileWithPassword(profile.id);
    const fullProfile = selectedId === profile.id
      ? {
          ...(hydrated ?? profile),
          password: draft.password || hydrated?.password || "",
          sshPassword: draft.sshPassword || hydrated?.sshPassword || "",
        }
      : hydrated ?? profile;
    await navigator.clipboard.writeText(formatConnectionUrl(fullProfile));
    setStatusMsg({ type: "ok", text: "Connection URL copied" });
    setContextMenu(null);
  }

  // Filter box: type to shortlist, ArrowDown/Enter to dive into the list.
  function handleFilterKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "Enter") {
      if (rows.length === 0) return;
      e.preventDefault();
      focusRow(rows[0]);
    }
  }

  function handleDndStart(event: DragStartEvent) {
    if (event.operation.source?.type !== "connection") return;
    dragPreviewProfilesRef.current = profiles;
    setDragPreviewProfiles(profiles);
  }

  function handleDndOver(event: DragOverEvent) {
    const { source, target } = event.operation;
    if (!source || source.type !== "connection" || !target || target.id === source.id) return;
    const folder = typeof target.data?.folder === "string" ? target.data.folder : null;

    // Follow dnd-kit's controlled multiple-list pattern: update a temporary
    // React-owned projection during dragover. This gives the optimistic plugin
    // fresh groups/indexes, so it animates displacement without reparenting DOM
    // nodes behind React's back.
    const currentProfiles = dragPreviewProfilesRef.current ?? profiles;
    const profileById = new Map(currentProfiles.map((profile) => [connectionDndId(profile.id), profile]));
    const grouped = Object.fromEntries(folders.map((folderName) => [
      folderDndId(folderName),
      currentProfiles
        .filter((profile) => profile.group === folderName)
        .map((profile) => connectionDndId(profile.id)),
    ]));
    const projectedGroups = move(grouped, event);
    const sourceGroup = "group" in source && source.group != null ? String(source.group) : null;
    const targetFolder = resolveConnectionDropFolder(folders, folder, sourceGroup, folder);
    if (!targetFolder) return;
    const destinationGroup = folderDndId(targetFolder);
    const projectedIndex = "index" in source && typeof source.index === "number"
      ? source.index
      : projectedGroups[destinationGroup]?.length ?? 0;
    const destinationIndex = target.type === "folder" || sourceGroup === "folder-order"
      ? projectedGroups[destinationGroup]?.length ?? 0
      : projectedIndex;
    const previewGroups = reconcileItemGroup(
      projectedGroups,
      String(source.id),
      destinationGroup,
      destinationIndex,
    );
    const previewProfiles: ConnectionProfile[] = [];
    for (const folderName of folders) {
      for (const id of previewGroups[folderDndId(folderName)] ?? []) {
        const profile = profileById.get(String(id));
        if (profile) previewProfiles.push({ ...profile, group: folderName });
      }
    }
    if (previewProfiles.length !== currentProfiles.length) return;
    dragPreviewProfilesRef.current = previewProfiles;
    setDragPreviewProfiles(previewProfiles);
    setCollapsed((previous) => {
      if (!previous.has(targetFolder)) return previous;
      const next = new Set(previous);
      next.delete(targetFolder);
      return next;
    });
  }

  async function handleDndEnd(event: DragEndEvent) {
    const { source, target, canceled } = event.operation;
    const previewProfiles = dragPreviewProfilesRef.current;
    dragPreviewProfilesRef.current = null;
    setDragPreviewProfiles(null);
    if (canceled || !source || !target || isFiltering) return;

    try {
      if (source.type === "folder") {
        const folderById = new Map(folders.map((folder) => [folderDndId(folder), folder]));
        const reorderedIds = move([...folderById.keys()], event);
        const reordered = reorderedIds.map((id) => folderById.get(String(id))).filter((folder): folder is string => !!folder);
        if (reordered.length === folders.length) await reorderFolders(reordered);
        return;
      }

      if (source.type !== "connection") return;
      if (previewProfiles?.length === profiles.length) await reorderProfiles(previewProfiles);
    } catch (error) {
      console.error("[connections] could not persist drag order:", error);
      setStatusMsg({
        type: "error",
        text: error instanceof Error ? error.message : "Could not save connection order",
      });
    }
  }

  const isSqlite = draft.type === "sqlite";
  const envMeta = ENV_LABELS[draft.env] ?? ENV_LABELS[""];
  const isDark = document.documentElement.getAttribute("data-theme") !== "light";
  const envColor = isDark ? envMeta.dark : envMeta.light;

  return (
    <div className="relative flex h-screen bg-bg-primary select-none">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-border p-3" data-tauri-drag-region>
          {profiles.length > 0 && (
            <div className="relative min-w-0 flex-1">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
              <input
                ref={filterRef}
                type="text"
                placeholder="Filter connections…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={handleFilterKeyDown}
                className="w-full rounded-md border border-border-light bg-bg-secondary py-1.5 pl-8 pr-2 text-sm text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
                spellCheck={false}
              />
            </div>
          )}
          <button
            onClick={handleNewConnection}
            title="New connection (⌘N)"
            className="flex shrink-0 items-center justify-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm text-white transition-colors hover:bg-accent-hover cursor-pointer"
          >
            <Plus size={14} />
            New Connection
          </button>
          <button
            type="button"
            title="New folder"
            aria-label="New folder"
            onClick={() => { setFolderName(""); setFolderError(null); setFolderDialogOpen(true); }}
            className="rounded-md border border-border-light p-2 text-text-secondary transition hover:bg-bg-hover hover:text-text-primary cursor-pointer"
          >
            <FolderPlus size={15} />
          </button>
          <div className="relative" onPointerDown={(event) => event.stopPropagation()}>
            <button
              type="button"
              title="Connection options"
              aria-label="Connection options"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
              className="rounded-md border border-border-light p-2 text-text-secondary transition hover:bg-bg-hover hover:text-text-primary cursor-pointer"
            >
              <Menu size={15} />
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-full z-[300] mt-1 w-48 rounded-md border border-border bg-bg-primary p-1 shadow-2xl">
                <button
                  type="button"
                  onClick={() => { setMenuOpen(false); importInputRef.current?.click(); }}
                  className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-xs text-text-primary hover:bg-bg-hover cursor-pointer"
                >
                  <Upload size={13} />
                  Import connections…
                </button>
                <button
                  type="button"
                  onClick={handleExportConnections}
                  disabled={profiles.length === 0}
                  className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-xs text-text-primary hover:bg-bg-hover disabled:opacity-40 cursor-pointer"
                >
                  <Download size={13} />
                  Export connections…
                </button>
              </div>
            )}
          </div>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handleImportFile(file);
              event.target.value = "";
            }}
          />
        </div>
        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
        <div
          ref={listRef}
          tabIndex={0}
          role="tree"
          onKeyDown={handleTreeKeyDown}
          className="flex-1 overflow-y-auto px-2 py-1 focus:outline-none"
        >
          <DragDropProvider
            onDragStart={handleDndStart}
            onDragOver={handleDndOver}
            onDragEnd={handleDndEnd}
          >
            {folders.map((folder, folderIndex) => {
              const members = filteredProfiles.filter((profile) => profile.group === folder);
              if (isFiltering && members.length === 0) return null;
              const isOpen = isFiltering || !collapsed.has(folder);
              return (
                <SortableFolder
                  key={folder}
                  folder={folder}
                  index={folderIndex}
                  count={members.length}
                  open={isOpen}
                  focused={focusKey === `group:${folder}`}
                  disabled={isFiltering}
                  onToggle={() => { toggleGroup(folder); setFocusKey(`group:${folder}`); listRef.current?.focus(); }}
                >
                  {isOpen && members.map((profile, index) => (
                    <SortableConnection
                      key={profile.id}
                      profile={profile}
                      index={index}
                      folder={folder}
                      focused={focusKey === `conn:${profile.id}`}
                      disabled={isFiltering}
                      isDark={isDark}
                      onFocus={() => { setFocusKey(`conn:${profile.id}`); listRef.current?.focus(); }}
                      onConnect={() => void connectSavedProfile(profile)}
                      onEdit={() => void openEditor(profile)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        setContextMenu({
                          profile,
                          x: Math.min(event.clientX, window.innerWidth - 160),
                          y: Math.min(event.clientY, window.innerHeight - 80),
                        });
                      }}
                    />
                  ))}
                </SortableFolder>
              );
            })}
          </DragDropProvider>
          {rows.length === 0 && loaded && (
            <div className="flex flex-col items-center gap-2 px-3 py-8 text-center text-sm text-text-muted">
              <Database size={24} className="opacity-30" />
              {filter ? "No matches" : "No connections yet"}
            </div>
          )}
        </div>
        {contextMenu && (
          <div
            className="fixed z-[1000] min-w-36 rounded-md border border-border bg-bg-primary p-1 shadow-2xl"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <button
              onClick={() => { void openEditor(contextMenu.profile); setContextMenu(null); }}
              className="w-full flex items-center gap-2 rounded px-2.5 py-1.5 text-xs text-text-primary hover:bg-bg-hover cursor-pointer"
            >
              <Pencil size={12} />
              Edit
            </button>
            <button
              onClick={() => handleCopyAsUrl(contextMenu.profile)}
              className="w-full flex items-center gap-2 rounded px-2.5 py-1.5 text-xs text-text-primary hover:bg-bg-hover cursor-pointer"
            >
              <Copy size={12} />
              Copy as URL
            </button>
            <button
              onClick={() => { void handleDeleteProfile(contextMenu.profile.id); setContextMenu(null); }}
              className="w-full flex items-center gap-2 rounded px-2.5 py-1.5 text-xs text-error hover:bg-error/10 cursor-pointer"
            >
              <Trash2 size={12} />
              Delete
            </button>
          </div>
        )}
        {!editorOpen && statusMsg && (
          <StatusBar status={statusMsg} onClose={() => setStatusMsg(null)} />
        )}
        {!statusMsg && (
          <div className="flex items-center justify-center gap-1.5 border-t border-border px-3 py-2 text-center text-[11px] text-text-muted">
            {connecting && <Loader2 size={11} className="animate-spin" />}
            {connecting ? "Connecting…" : "Double-click a connection to connect"}
          </div>
        )}
      </div>

      {folderDialogOpen && (
        <div
          role="presentation"
          onMouseDown={(event) => { if (event.target === event.currentTarget) setFolderDialogOpen(false); }}
          className="fixed inset-0 z-[220] flex items-center justify-center bg-black/55 p-5"
        >
          <form
            role="dialog"
            aria-modal="true"
            aria-label="Create folder"
            onSubmit={(event) => { event.preventDefault(); void handleCreateFolder(); }}
            className="w-full max-w-sm rounded-xl border border-border bg-bg-secondary p-4 shadow-2xl"
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-text-primary">New folder</h2>
              <button type="button" aria-label="Close" onClick={() => setFolderDialogOpen(false)} className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text-primary cursor-pointer">
                <X size={15} />
              </button>
            </div>
            <input
              ref={folderNameRef}
              value={folderName}
              onChange={(event) => { setFolderName(event.target.value); setFolderError(null); }}
              placeholder="Folder name"
              className="input-field"
              spellCheck={false}
            />
            {folderError && <div className="mt-2 text-xs text-error">{folderError}</div>}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setFolderDialogOpen(false)} className="rounded-md border border-border-light px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-hover cursor-pointer">Cancel</button>
              <button type="submit" disabled={!folderName.trim()} className="rounded-md bg-accent px-3 py-1.5 text-sm text-white hover:bg-accent-hover disabled:opacity-50 cursor-pointer">Create</button>
            </div>
          </form>
        </div>
      )}

      {editorOpen && (
        <div
          role="presentation"
          onMouseDown={(event) => { if (event.target === event.currentTarget) setEditorOpen(false); }}
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/55 p-5"
        >
          <div role="dialog" aria-modal="true" aria-label={isNew ? "New connection" : "Edit connection"} className="flex max-h-[calc(100vh-40px)] w-full max-w-[680px] flex-col overflow-hidden rounded-xl border border-border bg-bg-secondary shadow-2xl">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2 min-w-0 flex-1 mr-2">
            <h2 className="text-sm font-semibold text-text-primary truncate min-w-0">
              {isNew ? "New Connection" : draft.name || "Connection Details"}
            </h2>
            {envMeta.label && (
              <span
                className="shrink-0 text-[10px] px-1.5 py-0.5 rounded font-medium"
                style={{ backgroundColor: `${envColor}22`, color: envColor }}
              >
                {envMeta.label}
              </span>
            )}
          </div>
          <button type="button" aria-label="Close connection editor" onClick={() => setEditorOpen(false)} className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text-primary cursor-pointer">
            <X size={16} />
          </button>
        </div>

        {/* Form body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {/* Row: Name + Type */}
          <div className="flex gap-3">
            <Field label="Name" className="flex-1">
              <input
                ref={firstFieldRef}
                type="text"
                placeholder="Paste a connection URL or type a name..."
                value={draft.name}
                onChange={(e) => handleNameChange(e.target.value)}
                className="input-field"
                spellCheck={false}
              />
            </Field>
            <Field label="Type" className="w-[140px]">
              <select
                value={draft.type}
                onChange={(e) => updateDraft({ type: e.target.value as ConnectionProfile["type"] })}
                className="input-field"
              >
                <option value="postgres">PostgreSQL</option>
                <option value="mysql">MySQL</option>
                <option value="sqlite">SQLite</option>
              </select>
            </Field>
          </div>

          {isSqlite ? (
            <Field label="Database File">
              <input
                type="text"
                placeholder="/path/to/database.sqlite"
                value={draft.database}
                onChange={(e) => updateDraft({ database: e.target.value })}
                className="input-field"
              />
            </Field>
          ) : (
            <>
              {/* Row: Host + Port */}
              <div className="flex gap-3">
                <Field label="Host" className="flex-1">
                  <input
                    type="text"
                    placeholder="localhost"
                    value={draft.host}
                    onChange={(e) => updateDraft({ host: e.target.value })}
                    className="input-field"
                  />
                </Field>
                <Field label="Port" className="w-[100px]">
                  <input
                    type="number"
                    value={draft.port}
                    onChange={(e) => updateDraft({ port: parseInt(e.target.value) || 0 })}
                    className="input-field"
                  />
                </Field>
              </div>

              {/* Row: Username + Password */}
              <div className="flex gap-3">
                <Field label="Username" className="flex-1">
                  <input
                    type="text"
                    placeholder="postgres"
                    value={draft.username}
                    onChange={(e) => updateDraft({ username: e.target.value })}
                    className="input-field"
                  />
                </Field>
                <Field label="Password" className="flex-1">
                  <input
                    type="password"
                    placeholder="••••••••"
                    value={draft.password}
                    onChange={(e) => updateDraft({ password: e.target.value })}
                    className="input-field"
                  />
                </Field>
              </div>

              {/* Row: Database + Env */}
              <div className="flex gap-3">
                <Field label="Database" className="flex-1">
                  <input
                    type="text"
                    placeholder="mydb"
                    value={draft.database}
                    onChange={(e) => updateDraft({ database: e.target.value })}
                    className="input-field"
                  />
                </Field>
                <Field label="Environment" className="w-[140px]">
                  <select
                    value={draft.env}
                    onChange={(e) => updateDraft({ env: e.target.value as ConnectionEnv })}
                    className="input-field"
                    style={envColor ? { color: envColor } : undefined}
                  >
                    <option value="">— none —</option>
                    <option value="local">Local</option>
                    <option value="development">Development</option>
                    <option value="testing">Testing</option>
                    <option value="staging">Staging</option>
                    <option value="production">Production</option>
                  </select>
                </Field>
              </div>

              {/* SSL */}
              <div className="flex items-center gap-5">
                <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
                  <input
                    type="checkbox"
                    checked={draft.ssl}
                    onChange={(e) => updateDraft({ ssl: e.target.checked })}
                    className="rounded border-border-light"
                  />
                  Use SSL
                </label>
                <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
                  <input
                    type="checkbox"
                    checked={draft.useSsh}
                    onChange={(e) => handleSshToggle(e.target.checked)}
                    className="rounded border-border-light"
                  />
                  Connect over SSH
                </label>
              </div>

              {draft.useSsh && (
                <div className="rounded-lg border border-border bg-bg-primary p-3 space-y-3">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-text-primary">
                    <Network size={13} className="text-accent" />
                    SSH Tunnel
                  </div>
                  <div className="flex gap-3">
                    <Field label="Server / SSH config host" className="flex-1">
                      <input value={draft.sshHost} onChange={(e) => updateDraft({ sshHost: e.target.value })} placeholder="bastion or ~/.ssh/config Host" className="input-field" />
                    </Field>
                    <Field label="Port" className="w-[100px]">
                      <input type="number" value={draft.sshPort} onChange={(e) => updateDraft({ sshPort: parseInt(e.target.value) || 22 })} className="input-field" />
                    </Field>
                  </div>
                  <Field label="User">
                    <input value={draft.sshUsername} onChange={(e) => updateDraft({ sshUsername: e.target.value })} placeholder="Optional — use SSH config" className="input-field" />
                  </Field>
                  <div className="flex gap-3">
                    <Field label={draft.sshUsePrivateKey ? "Key passphrase" : "Password"} className="flex-1">
                      <input
                        type="password"
                        value={draft.sshPassword}
                        disabled={draft.sshAuthMode === "none"}
                        onChange={(e) => updateDraft({ sshPassword: e.target.value })}
                        placeholder={draft.sshAuthMode === "none" ? "No password" : "••••••••"}
                        className="input-field disabled:opacity-50"
                      />
                    </Field>
                    <Field label="Password handling" className="w-[150px]">
                      <select value={draft.sshAuthMode} onChange={(e) => updateDraft({ sshAuthMode: e.target.value as ConnectionProfile["sshAuthMode"] })} className="input-field">
                        <option value="keychain">Store in keychain</option>
                        <option value="ask">Ask every time</option>
                        <option value="none">No password</option>
                      </select>
                    </Field>
                  </div>
                  <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
                    <input type="checkbox" checked={draft.sshUsePrivateKey} onChange={(e) => handlePrivateKeyToggle(e.target.checked)} className="rounded border-border-light" />
                    Use SSH private key
                  </label>
                  {draft.sshUsePrivateKey && (
                    <Field label="Private key file">
                      <div className="flex items-center gap-2">
                        <input
                          ref={privateKeyRef}
                          type="file"
                          className="hidden"
                          onChange={async (event) => {
                            const file = event.target.files?.[0];
                            if (file) updateDraft({ sshPrivateKey: await file.text() });
                            event.target.value = "";
                          }}
                        />
                        <button type="button" onClick={() => privateKeyRef.current?.click()} className="px-3 py-1.5 rounded-md border border-border-light text-xs text-text-secondary hover:text-text-primary hover:bg-bg-hover cursor-pointer">
                          Import private key…
                        </button>
                        <span className="min-w-0 flex-1 truncate text-xs text-text-muted">
                          {draft.sshPrivateKey ? "Private key imported" : "No key selected"}
                        </span>
                        {draft.sshPrivateKey && (
                          <button type="button" onClick={() => updateDraft({ sshPrivateKey: "" })} className="text-xs text-text-muted hover:text-error cursor-pointer">Clear</button>
                        )}
                      </div>
                    </Field>
                  )}
                </div>
              )}
            </>
          )}

          {/* Group + color */}
          <div className="flex gap-3">
            <Field label="Folder" className="flex-1">
              <select
                value={draft.group || DEFAULT_CONNECTION_FOLDER}
                onChange={(e) => updateDraft({ group: e.target.value })}
                className="input-field"
              >
                {folders.map((folder) => <option key={folder} value={folder}>{folder}</option>)}
              </select>
            </Field>
          </div>

          {/* Color picker */}
          <Field label="Color Tag">
            <div className="flex gap-2">
              {CONNECTION_COLORS.map((c) => {
                const selected = draft.color === c;
                return (
                  <button
                    key={c}
                    onClick={() => updateDraft({ color: c })}
                    className="relative w-6 h-6 rounded-full cursor-pointer transition-transform hover:scale-110"
                    style={{ backgroundColor: c }}
                  >
                    {selected && (
                      <span
                        className="absolute inset-[-4px] rounded-full border-[2px] pointer-events-none"
                        style={{
                          borderColor: isDark ? "#ffffff" : "#18181b",
                          boxShadow: isDark
                            ? "0 0 0 1px rgba(0,0,0,0.3)"
                            : "0 0 0 1px rgba(255,255,255,0.5)",
                        }}
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </Field>
        </div>

        {/* Footer */}
        <div className="border-t border-border shrink-0">
          {/* Status bar */}
          {statusMsg && <StatusBar status={statusMsg} onClose={() => setStatusMsg(null)} />}

          {/* Action row */}
          <div className="flex items-center justify-between px-5 py-3">
            <div>
              {selectedId && !isNew && (
                <button
                  onClick={handleDelete}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md text-error hover:bg-error/10 transition-colors cursor-pointer"
                >
                  <Trash2 size={13} />
                  Delete
                </button>
              )}
            </div>
            <div className="flex gap-2 shrink-0">
              <button
                onClick={handleTest}
                disabled={testing}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border border-border-light text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-50 cursor-pointer"
              >
                {testing ? <Loader2 size={13} className="animate-spin" /> : <FlaskConical size={13} />}
                {testing ? "Testing..." : "Test"}
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border border-border-light text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-50 cursor-pointer"
              >
                {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                {saving ? "Saving..." : "Save"}
              </button>
              <button
                onClick={handleConnect}
                disabled={(!selectedId && !isNew) || connecting}
                className="flex items-center gap-1.5 px-4 py-1.5 text-sm rounded-md bg-accent hover:bg-accent-hover text-white transition-colors disabled:opacity-50 cursor-pointer"
              >
                {connecting ? <Loader2 size={13} className="animate-spin" /> : <Zap size={13} />}
                {connecting ? "Connecting..." : "Connect"}
              </button>
            </div>
          </div>
        </div>
      </div>
        </div>
      )}
    </div>
  );
}

function folderDndId(folder: string): string {
  return `folder:${folder}`;
}

function connectionDndId(id: string): string {
  return `connection:${id}`;
}

function SortableFolder({
  folder,
  index,
  count,
  open,
  focused,
  disabled,
  onToggle,
  children,
}: {
  folder: string;
  index: number;
  count: number;
  open: boolean;
  focused: boolean;
  disabled: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const { ref, handleRef, isDragSource, isDropTarget } = useSortable({
    id: folderDndId(folder),
    index,
    group: "folder-order",
    type: "folder",
    accept: ["folder", "connection"],
    // The folder target wraps its connection rows. Keep it below the default
    // row priority so a row wins when both targets overlap; the folder still
    // accepts drops over its header, whitespace, and empty body.
    collisionPriority: 1, // CollisionPriority.Low
    disabled,
    data: { folder },
  });

  return (
    <div ref={ref} className={`rounded-md transition-opacity ${isDragSource ? "opacity-45" : ""}`}>
      <div
        ref={handleRef}
        data-rowkey={`group:${folder}`}
        role="treeitem"
        aria-expanded={open}
        onClick={onToggle}
        className={`flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide transition-colors ${isDragSource ? "cursor-grabbing" : "cursor-default"} ${
          isDropTarget ? "bg-accent/15 ring-1 ring-accent/60" : focused ? "bg-bg-hover ring-1 ring-accent/50" : "text-text-muted hover:bg-bg-hover/50"
        }`}
      >
        {open ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />}
        {open ? <FolderOpen size={12} className="shrink-0 text-accent" /> : <Folder size={12} className="shrink-0" />}
        <span className="min-w-0 flex-1 truncate text-text-secondary">{folder}</span>
        <span className="shrink-0 text-[10px] font-normal text-text-muted">{count}</span>
      </div>
      {children}
    </div>
  );
}

function SortableConnection({
  profile,
  index,
  folder,
  focused,
  disabled,
  isDark,
  onFocus,
  onConnect,
  onEdit,
  onContextMenu,
}: {
  profile: ConnectionProfile;
  index: number;
  folder: string;
  focused: boolean;
  disabled: boolean;
  isDark: boolean;
  onFocus: () => void;
  onConnect: () => void;
  onEdit: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
}) {
  const { ref, isDragSource, isDropTarget } = useSortable({
    id: connectionDndId(profile.id),
    index,
    group: folderDndId(folder),
    type: "connection",
    accept: "connection",
    disabled,
    data: { profileId: profile.id, folder },
  });
  const env = ENV_LABELS[profile.env] ?? ENV_LABELS[""];
  const envColor = isDark ? env.dark : env.light;

  return (
    <div
      ref={ref}
      data-rowkey={`conn:${profile.id}`}
      role="treeitem"
      onClick={onFocus}
      onDoubleClick={onConnect}
      onContextMenu={onContextMenu}
      className={`group ml-4 flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors ${isDragSource ? "cursor-grabbing" : "cursor-default"} ${
        isDragSource
          ? "opacity-40"
          : isDropTarget
          ? "bg-accent/10 ring-1 ring-accent/50"
          : focused
          ? "bg-bg-hover/70 ring-1 ring-accent/50 text-text-primary"
          : "text-text-secondary hover:bg-bg-hover/50"
      }`}
    >
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: profile.color }} />
      <span className="max-w-[42%] shrink-0 truncate font-medium">{profile.name || "Untitled"}</span>
      {env.label && (
        <span className="shrink-0 rounded px-1 py-0.5 text-[9px] font-medium" style={{ backgroundColor: `${envColor}22`, color: envColor }}>
          {env.label}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-[10px] text-text-muted">
        {profile.type}{profile.type !== "sqlite" ? ` · ${profile.host}` : ""}
      </span>
      <button
        type="button"
        title={`Edit ${profile.name || "connection"}`}
        aria-label={`Edit ${profile.name || "connection"}`}
        onClick={(event) => { event.stopPropagation(); onEdit(); }}
        onDoubleClick={(event) => event.stopPropagation()}
        className="rounded p-1 text-text-muted opacity-0 transition hover:bg-bg-secondary hover:text-text-primary group-hover:opacity-100 focus:opacity-100 cursor-pointer"
      >
        <Pencil size={12} />
      </button>
    </div>
  );
}

/** A row in the navigable connection tree: a group header or a connection. */
type ListRow =
  | { type: "group"; name: string; count: number }
  | { type: "conn"; profile: ConnectionProfile };

function rowKey(row: ListRow): string {
  return row.type === "group" ? `group:${row.name}` : `conn:${row.profile.id}`;
}

/** Escape a string for safe use inside a CSS attribute selector. */
function cssEscape(value: string): string {
  const fn = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS?.escape;
  return fn ? fn(value) : value.replace(/["\\]/g, "\\$&");
}

/** Fuzzy match: every character in the query appears in order in the haystack */
function fuzzyStr(query: string, haystack: string): boolean {
  let hi = 0;
  for (let qi = 0; qi < query.length; qi++) {
    const ch = query[qi];
    while (hi < haystack.length && haystack[hi] !== ch) hi++;
    if (hi >= haystack.length) return false;
    hi++;
  }
  return true;
}

function fuzzyMatch(query: string, p: ConnectionProfile): boolean {
  const targets = [p.name, p.host, p.database, p.type, p.username, p.group].map((s) =>
    (s || "").toLowerCase(),
  );
  return targets.some((t) => fuzzyStr(query, t));
}

function StatusBar({
  status,
  onClose,
}: {
  status: { type: "url" | "ok" | "error"; text: string };
  onClose: () => void;
}) {
  return (
    <div className={`flex items-center gap-2 border-t border-border px-4 py-2 text-xs ${
      status.type === "ok"
        ? "text-success bg-success/5"
        : status.type === "error"
        ? "text-error bg-error/5"
        : "text-text-secondary"
    }`}>
      <span className="shrink-0">{status.type === "url" ? "✓" : "●"}</span>
      <span className="flex-1 truncate">{status.text}</span>
      <button onClick={onClose} className="shrink-0 text-text-muted hover:text-text-primary cursor-pointer">×</button>
    </div>
  );
}

function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <label className="block text-xs text-text-muted mb-1">{label}</label>
      {children}
    </div>
  );
}
