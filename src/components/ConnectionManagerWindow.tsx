import { useEffect, useRef, useState, useMemo } from "react";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { LogicalSize } from "@tauri-apps/api/dpi";
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
} from "lucide-react";
import { useConnectionsStore } from "../stores/connections";
import {
  type ConnectionProfile,
  type ConnectionEnv,
  createDefaultProfile,
  DB_TYPE_PORTS,
  CONNECTION_COLORS,
  ENV_LABELS,
} from "../lib/types";
import { formatConnectionUrl, isConnectionUrl, parseConnectionUrl } from "../lib/parseConnectionUrl";
import { openConnection } from "../lib/schema";
import { useWindowPersist } from "../lib/useWindowPersist";

export function ConnectionManagerWindow() {
  useWindowPersist();
  const { profiles, loaded, loadProfiles, addProfile, updateProfile, deleteProfile, testConnection, getProfileWithPassword } =
    useConnectionsStore();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ConnectionProfile>(createDefaultProfile());
  const [isNew, setIsNew] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ type: "url" | "ok" | "error"; text: string } | null>(null);
  const [filter, setFilter] = useState("");
  const [contextMenu, setContextMenu] = useState<{ profile: ConnectionProfile; x: number; y: number } | null>(null);

  const filterRef = useRef<HTMLInputElement>(null);
  const privateKeyRef = useRef<HTMLInputElement>(null);
  const compactHeightRef = useRef<number | null>(null);
  const resizeAnimationRef = useRef(0);

  useEffect(() => () => {
    resizeAnimationRef.current += 1;
  }, []);

  async function animateWindowHeight(resolveHeight: (currentHeight: number) => number) {
    const animation = ++resizeAnimationRef.current;
    const win = getCurrentWindow();
    const scaleFactor = await win.scaleFactor();
    const physicalSize = await win.outerSize();
    const width = physicalSize.width / scaleFactor;
    const startHeight = physicalSize.height / scaleFactor;

    const desiredHeight = resolveHeight(startHeight);
    const startedAt = performance.now();
    const duration = 240;

    const frame = async (now: number) => {
      if (animation !== resizeAnimationRef.current) return;
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      const height = startHeight + (desiredHeight - startHeight) * eased;
      try {
        await win.setSize(new LogicalSize(width, height));
      } catch {
        return; // Window closed during the animation.
      }
      if (progress < 1 && animation === resizeAnimationRef.current) {
        requestAnimationFrame((time) => void frame(time));
      }
    };
    requestAnimationFrame((time) => void frame(time));
  }

  async function resizeForSsh(enabled: boolean) {
    await animateWindowHeight((startHeight) => {
      if (enabled) compactHeightRef.current = startHeight;
      const compactHeight = compactHeightRef.current ?? Math.max(540, startHeight - 280);
      const sshHeight = 280 + (draft.sshUsePrivateKey ? 72 : 0);
      return enabled
        ? Math.min(startHeight + sshHeight, window.screen.availHeight - 24)
        : compactHeight;
    });
  }

  function handleSshToggle(enabled: boolean) {
    updateDraft({ useSsh: enabled });
    void resizeForSsh(enabled).catch(() => {
      // The window may be closing while an animation frame is pending.
    });
  }

  function handlePrivateKeyToggle(enabled: boolean) {
    updateDraft({ sshUsePrivateKey: enabled });
    void animateWindowHeight((startHeight) => enabled
      ? Math.min(startHeight + 72, window.screen.availHeight - 24)
      : Math.max(compactHeightRef.current ?? 540, startHeight - 72)
    ).catch(() => {
      // The window may be closing while an animation frame is pending.
    });
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

  const filteredProfiles = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return profiles;
    return profiles.filter((p) => fuzzyMatch(q, p));
  }, [profiles, filter]);

  useEffect(() => {
    if (!loaded) loadProfiles();
  }, [loaded, loadProfiles]);

  // Select first profile when loaded, or enter new mode if empty
  useEffect(() => {
    if (loaded && !selectedId && !isNew) {
      if (profiles.length > 0) {
        selectProfile(profiles[0]);
      } else {
        setIsNew(true);
      }
    }
  }, [loaded, profiles]);

  async function selectProfile(p: ConnectionProfile) {
    setSelectedId(p.id);
    setIsNew(false);
    setStatusMsg(null);
    const hydrated = await getProfileWithPassword(p.id);
    setDraft(hydrated ?? p);
    // Keep focus on filter so Enter/Tab keep working
    filterRef.current?.focus();
  }

  function handleNewConnection() {
    const def = createDefaultProfile();
    setDraft(def);
    setSelectedId(null);
    setIsNew(true);
    setStatusMsg(null);
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

  async function handleDelete() {
    if (!selectedId) return;
    await deleteProfile(selectedId);
    const remaining = profiles.filter((p) => p.id !== selectedId);
    if (remaining.length > 0) {
      selectProfile(remaining[0]);
    } else {
      setSelectedId(null);
      setDraft(createDefaultProfile());
      setIsNew(true);
    }
    setStatusMsg(null);
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

  // Keyboard: Tab through connections, Enter to connect
  function handleListKeyDown(e: React.KeyboardEvent) {
    const target = e.target as HTMLElement;
    const isFormField = target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA";
    const isFilterInput = target === filterRef.current;

    if (e.key === "Tab" && filteredProfiles.length > 0 && (!isFormField || isFilterInput)) {
      e.preventDefault();
      const currentIdx = filteredProfiles.findIndex((p) => p.id === selectedId);
      const dir = e.shiftKey ? -1 : 1;
      const nextIdx = currentIdx < 0 ? 0 : (currentIdx + dir + filteredProfiles.length) % filteredProfiles.length;
      selectProfile(filteredProfiles[nextIdx]);
      filterRef.current?.focus();
    } else if (e.key === "Enter" && selectedId && (!isFormField || isFilterInput)) {
      e.preventDefault();
      handleConnect();
    }
  }

  const isSqlite = draft.type === "sqlite";
  const envMeta = ENV_LABELS[draft.env] ?? ENV_LABELS[""];
  const isDark = document.documentElement.getAttribute("data-theme") !== "light";
  const envColor = isDark ? envMeta.dark : envMeta.light;

  // eslint-disable-next-line jsx-a11y/no-static-element-interactions
  return (
    <div className="flex h-screen bg-bg-secondary select-none" onKeyDown={handleListKeyDown}>
      {/* Left sidebar — connection list */}
      <div className="w-[220px] flex flex-col border-r border-border bg-bg-primary shrink-0">
        <div className="p-3 border-b border-border space-y-2" data-tauri-drag-region>
          <button
            onClick={handleNewConnection}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-accent hover:bg-accent-hover text-white transition-colors cursor-pointer"
          >
            <Plus size={14} />
            New Connection
          </button>
          {profiles.length > 0 && (
            <div className="relative">
              <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
              <input
                ref={filterRef}
                type="text"
                placeholder="Filter..."
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="w-full pl-7 pr-2 py-1 text-xs rounded bg-bg-secondary border border-border-light text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent"
                spellCheck={false}
              />
            </div>
          )}
        </div>
        <div className="flex-1 overflow-y-auto">
          {filteredProfiles.map((p) => {
            const pEnv = ENV_LABELS[p.env] ?? ENV_LABELS[""];
            const pColor = isDark ? pEnv.dark : pEnv.light;
            return (
              <button
                key={p.id}
                onClick={() => selectProfile(p)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setContextMenu({
                    profile: p,
                    x: Math.min(event.clientX, window.innerWidth - 160),
                    y: Math.min(event.clientY, window.innerHeight - 44),
                  });
                }}
                className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-left text-sm transition-colors cursor-pointer ${
                  selectedId === p.id
                    ? "bg-bg-hover text-text-primary"
                    : "text-text-secondary hover:bg-bg-hover/50"
                }`}
              >
                <span
                  className="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: p.color }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="truncate font-medium">{p.name || "Untitled"}</span>
                    {pEnv.label && (
                      <span
                        className="shrink-0 text-[10px] px-1 py-0.5 rounded font-medium"
                        style={{ backgroundColor: `${pColor}22`, color: pColor }}
                      >
                        {pEnv.label}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-text-muted truncate">
                    {p.type}{p.type !== "sqlite" ? ` · ${p.host}` : ""}
                  </div>
                </div>
              </button>
            );
          })}
          {filteredProfiles.length === 0 && loaded && (
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
              onClick={() => handleCopyAsUrl(contextMenu.profile)}
              className="w-full flex items-center gap-2 rounded px-2.5 py-1.5 text-xs text-text-primary hover:bg-bg-hover cursor-pointer"
            >
              <Copy size={12} />
              Copy as URL
            </button>
          </div>
        )}
      </div>

      {/* Right panel — form */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header (draggable) */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0" data-tauri-drag-region>
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
        </div>

        {/* Form body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {/* Row: Name + Type */}
          <div className="flex gap-3">
            <Field label="Name" className="flex-1">
              <input
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
          {statusMsg && (
            <div className={`flex items-center gap-2 px-5 py-1.5 border-b border-border text-xs ${
              statusMsg.type === "ok"
                ? "text-success bg-success/5"
                : statusMsg.type === "error"
                ? "text-error bg-error/5"
                : "text-text-secondary"
            }`}>
              <span className="shrink-0">{statusMsg.type === "url" ? "✓" : "●"}</span>
              <span className="flex-1 truncate">{statusMsg.text}</span>
              <button
                onClick={() => setStatusMsg(null)}
                className="shrink-0 text-text-muted hover:text-text-primary cursor-pointer"
              >
                ×
              </button>
            </div>
          )}

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
  );
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
  const targets = [p.name, p.host, p.database, p.type, p.username].map((s) =>
    (s || "").toLowerCase(),
  );
  return targets.some((t) => fuzzyStr(query, t));
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
