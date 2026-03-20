import { useEffect, useState } from "react";
import { useConnectionsStore } from "../stores/connections";
import {
  type ConnectionProfile,
  createDefaultProfile,
  DB_TYPE_PORTS,
  CONNECTION_COLORS,
} from "../lib/types";
import type { ConnectionTestResult } from "../lib/types";

interface ConnectionManagerProps {
  open: boolean;
  onClose: () => void;
  onConnect: (profile: ConnectionProfile) => void;
}

export function ConnectionManager({
  open,
  onClose,
  onConnect,
}: ConnectionManagerProps) {
  const { profiles, loaded, loadProfiles, addProfile, updateProfile, deleteProfile, testConnection } =
    useConnectionsStore();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ConnectionProfile>(createDefaultProfile());
  const [isNew, setIsNew] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open && !loaded) {
      loadProfiles();
    }
  }, [open, loaded, loadProfiles]);

  // Select first profile when loaded
  useEffect(() => {
    if (loaded && profiles.length > 0 && !selectedId && !isNew) {
      selectProfile(profiles[0]);
    }
  }, [loaded, profiles]);

  function selectProfile(p: ConnectionProfile) {
    setSelectedId(p.id);
    setDraft({ ...p });
    setIsNew(false);
    setTestResult(null);
  }

  function handleNewConnection() {
    const def = createDefaultProfile();
    setDraft(def);
    setSelectedId(null);
    setIsNew(true);
    setTestResult(null);
  }

  function updateDraft(updates: Partial<ConnectionProfile>) {
    setDraft((d) => {
      const next = { ...d, ...updates };
      // Auto-update port when type changes
      if (updates.type && updates.type !== d.type) {
        next.port = DB_TYPE_PORTS[updates.type];
      }
      return next;
    });
  }

  async function handleSave() {
    setSaving(true);
    try {
      if (isNew) {
        const created = await addProfile(draft);
        setSelectedId(created.id);
        setDraft(created);
        setIsNew(false);
      } else if (selectedId) {
        await updateProfile(selectedId, draft);
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testConnection(draft);
      setTestResult(result);
    } catch (e: unknown) {
      setTestResult({ ok: false, error: e instanceof Error ? e.message : "Failed" });
    } finally {
      setTesting(false);
    }
  }

  async function handleDelete() {
    if (!selectedId) return;
    await deleteProfile(selectedId);
    setSelectedId(null);
    setDraft(createDefaultProfile());
    setIsNew(false);
  }

  function handleConnect() {
    if (selectedId) {
      onConnect(draft);
    }
  }

  if (!open) return null;

  const isSqlite = draft.type === "sqlite";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="flex w-[720px] h-[480px] rounded-xl overflow-hidden bg-bg-secondary border border-border shadow-2xl">
        {/* Left sidebar — connection list */}
        <div className="w-[220px] flex flex-col border-r border-border bg-bg-primary">
          <div className="p-3 border-b border-border">
            <button
              onClick={handleNewConnection}
              className="w-full px-3 py-1.5 text-sm rounded-md bg-accent hover:bg-accent-hover text-white transition-colors cursor-pointer"
            >
              + New Connection
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {profiles.map((p) => (
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
                  <div className="truncate font-medium">{p.name || "Untitled"}</div>
                  <div className="text-xs text-text-muted truncate">
                    {p.type} {!isSqlite ? `· ${p.host}` : ""}
                  </div>
                </div>
              </button>
            ))}
            {profiles.length === 0 && loaded && (
              <div className="px-3 py-8 text-center text-sm text-text-muted">
                No connections yet
              </div>
            )}
          </div>
        </div>

        {/* Right panel — form */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
            <h2 className="text-sm font-semibold text-text-primary truncate min-w-0 flex-1 mr-2">
              {isNew ? "New Connection" : draft.name || "Connection Details"}
            </h2>
            <button
              onClick={onClose}
              className="w-7 h-7 shrink-0 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
            >
              ×
            </button>
          </div>

          {/* Form body */}
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
            {/* Row: Name + Type */}
            <div className="flex gap-3">
              <Field label="Name" className="flex-1">
                <input
                  type="text"
                  placeholder="My Database"
                  value={draft.name}
                  onChange={(e) => updateDraft({ name: e.target.value })}
                  className="input-field"
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

                {/* Database */}
                <Field label="Database">
                  <input
                    type="text"
                    placeholder="mydb"
                    value={draft.database}
                    onChange={(e) => updateDraft({ database: e.target.value })}
                    className="input-field"
                  />
                </Field>

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

            {/* Test result */}
            {testResult && (
              <div
                className={`flex items-center gap-2 px-3 py-2 rounded-md text-sm ${
                  testResult.ok
                    ? "bg-success/10 text-success"
                    : "bg-error/10 text-error"
                }`}
              >
                <span>{testResult.ok ? "●" : "●"}</span>
                <span>
                  {testResult.ok
                    ? `Connected successfully${testResult.latency ? ` (${testResult.latency}ms)` : ""}`
                    : testResult.error}
                </span>
              </div>
            )}
          </div>

          {/* Footer buttons */}
          <div className="flex items-center justify-between px-5 py-3 border-t border-border">
            <div className="flex gap-2">
              {selectedId && !isNew && (
                <button
                  onClick={handleDelete}
                  className="px-3 py-1.5 text-sm rounded-md text-error hover:bg-error/10 transition-colors cursor-pointer"
                >
                  Delete
                </button>
              )}
            </div>
            <div className="flex gap-2">
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
