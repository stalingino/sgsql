import { useEffect, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useConnectionsStore } from "../stores/connections";
import {
  type ConnectionProfile,
  type ConnectionEnv,
  createDefaultProfile,
  DB_TYPE_PORTS,
  CONNECTION_COLORS,
  ENV_LABELS,
} from "../lib/types";
import { isConnectionUrl, parseConnectionUrl } from "../lib/parseConnectionUrl";

export function ConnectionManagerWindow() {
  const { profiles, loaded, loadProfiles, addProfile, updateProfile, deleteProfile, testConnection } =
    useConnectionsStore();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ConnectionProfile>(createDefaultProfile());
  const [isNew, setIsNew] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ type: "url" | "ok" | "error"; text: string } | null>(null);

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

  function selectProfile(p: ConnectionProfile) {
    setSelectedId(p.id);
    setDraft({ ...p });
    setIsNew(false);
    setStatusMsg(null);
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
        setDraft(created);
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
        profile = created;
      } finally {
        setSaving(false);
      }
    }
    // Emit to main window and close
    await emit("connection-selected", profile);
    getCurrentWindow().close();
  }

  const isSqlite = draft.type === "sqlite";
  const envMeta = ENV_LABELS[draft.env] ?? ENV_LABELS[""];

  return (
    <div className="flex h-screen bg-bg-secondary select-none">
      {/* Left sidebar — connection list */}
      <div className="w-[220px] flex flex-col border-r border-border bg-bg-primary shrink-0">
        <div className="p-3 border-b border-border" data-tauri-drag-region>
          <button
            onClick={handleNewConnection}
            className="w-full px-3 py-1.5 text-sm rounded-md bg-accent hover:bg-accent-hover text-white transition-colors cursor-pointer"
          >
            + New Connection
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {profiles.map((p) => {
            const pEnv = ENV_LABELS[p.env] ?? ENV_LABELS[""];
            return (
              <button
                key={p.id}
                onClick={() => selectProfile(p)}
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
                        style={{ backgroundColor: `${pEnv.color}22`, color: pEnv.color }}
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
          {profiles.length === 0 && loaded && (
            <div className="px-3 py-8 text-center text-sm text-text-muted">
              No connections yet
            </div>
          )}
        </div>
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
                style={{ backgroundColor: `${envMeta.color}22`, color: envMeta.color }}
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
                    style={envMeta.color ? { color: envMeta.color } : undefined}
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
              <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
                <input
                  type="checkbox"
                  checked={draft.ssl}
                  onChange={(e) => updateDraft({ ssl: e.target.checked })}
                  className="rounded border-border-light"
                />
                Use SSL
              </label>
            </>
          )}

          {/* Color picker */}
          <Field label="Color Tag">
            <div className="flex gap-1.5">
              {CONNECTION_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => updateDraft({ color: c })}
                  className={`w-6 h-6 rounded-full transition-all cursor-pointer ${
                    draft.color === c
                      ? "ring-2 ring-white ring-offset-2 ring-offset-bg-secondary scale-110"
                      : "hover:scale-110"
                  }`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </Field>
        </div>

        {/* Footer */}
        <div className="border-t border-border shrink-0">
          <div className="flex items-center justify-between px-5 py-3">
            <div className="flex items-center gap-2 flex-1 min-w-0 mr-3">
              {selectedId && !isNew && (
                <button
                  onClick={handleDelete}
                  className="shrink-0 px-3 py-1.5 text-sm rounded-md text-error hover:bg-error/10 transition-colors cursor-pointer"
                >
                  Delete
                </button>
              )}
              {statusMsg && (
                <div
                  className={`flex items-center gap-1.5 text-xs min-w-0 ${
                    statusMsg.type === "ok"
                      ? "text-success"
                      : statusMsg.type === "error"
                      ? "text-error"
                      : "text-text-secondary"
                  }`}
                >
                  <span className="shrink-0">{statusMsg.type === "ok" ? "●" : statusMsg.type === "error" ? "●" : "✓"}</span>
                  <span className="truncate">{statusMsg.text}</span>
                  <button
                    onClick={() => setStatusMsg(null)}
                    className="shrink-0 ml-1 text-text-muted hover:text-text-primary cursor-pointer"
                  >
                    ×
                  </button>
                </div>
              )}
            </div>
            <div className="flex gap-2 shrink-0">
              <button
                onClick={handleTest}
                disabled={testing}
                className="px-3 py-1.5 text-sm rounded-md border border-border-light text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-50 cursor-pointer"
              >
                {testing ? "Testing..." : "Test"}
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-3 py-1.5 text-sm rounded-md border border-border-light text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-50 cursor-pointer"
              >
                {saving ? "Saving..." : "Save"}
              </button>
              <button
                onClick={handleConnect}
                disabled={!selectedId && !isNew}
                className="px-4 py-1.5 text-sm rounded-md bg-accent hover:bg-accent-hover text-white transition-colors disabled:opacity-50 cursor-pointer"
              >
                Connect
              </button>
            </div>
          </div>
        </div>
      </div>
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
