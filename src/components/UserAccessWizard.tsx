import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Database, FolderTree, Loader2, Save, Search, Table2, X } from "lucide-react";
import {
  applySchemaChanges,
  fetchDatabases,
  fetchSchemas,
  fetchTables,
  type DbUser,
  type TableInfo,
  type UserGrants,
} from "../lib/schema";
import { fuzzySearch } from "../lib/fuzzySearch";
import {
  attributesOf,
  buildAccountChanges,
  editableGrantsOf,
  emptyGrants,
  type AccountAttributes,
  type AccountDraft,
  type EditableGrants,
  type UserDialect,
} from "../lib/userDdl";
import { PrivilegeChips, SqlReview } from "./PrivilegeChips";

/* ── Props ──────────────────────────────────────────────── */

interface Props {
  connectionId: string;
  dialect: UserDialect;
  mode: "create" | "edit";
  /** Account being edited, or the template when cloning; null for a blank create. */
  user: DbUser | null;
  grants: UserGrants | null;
  allUsers: DbUser[];
  /** Postgres: object-level grants apply to this (connected) database. */
  objectDb: string;
  onClose: () => void;
  onApplied: (name: string, host: string) => void;
}

type StepId = "account" | "roles" | "global" | "databases" | "objects" | "review";

const STEP_LABELS: Record<StepId, string> = {
  account: "Account",
  roles: "Roles",
  global: "Global privileges",
  databases: "Databases",
  objects: "Schemas & tables",
  review: "Review & apply",
};

function draftFrom(dialect: UserDialect, user: DbUser | null, grants: UserGrants | null, clone: boolean): AccountDraft {
  return {
    name: clone ? "" : user?.name ?? "",
    host: user?.host ?? "%",
    password: "",
    attrs: attributesOf(user, dialect),
    roles: [...(user?.roles ?? [])],
    grants: grants ? editableGrantsOf(grants) : emptyGrants(),
  };
}

/* ── Component ──────────────────────────────────────────── */

export function UserAccessWizard({ connectionId, dialect, mode, user, grants, allUsers, objectDb, onClose, onApplied }: Props) {
  const isClone = mode === "create" && user !== null;
  const [before] = useState<AccountDraft | null>(() => mode === "edit" ? draftFrom(dialect, user, grants, false) : null);
  const [draft, setDraft] = useState<AccountDraft>(() => draftFrom(dialect, user, grants, isClone));
  const [confirmPassword, setConfirmPassword] = useState("");
  const [stepIndex, setStepIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [databases, setDatabases] = useState<string[]>([]);

  const steps = useMemo<StepId[]>(() => (
    dialect === "mysql"
      ? ["account", "roles", "global", "databases", "objects", "review"]
      : ["account", "roles", "databases", "objects", "review"]
  ), [dialect]);
  const step = steps[stepIndex];

  useEffect(() => {
    fetchDatabases(connectionId).then(setDatabases).catch(() => setDatabases([]));
  }, [connectionId]);

  const patch = (partial: Partial<AccountDraft>) => setDraft((current) => ({ ...current, ...partial }));
  const patchAttrs = (partial: Partial<AccountAttributes>) => setDraft((current) => ({ ...current, attrs: { ...current.attrs, ...partial } }));
  const patchGrants = (updater: (grants: EditableGrants) => EditableGrants) => setDraft((current) => ({ ...current, grants: updater(current.grants) }));

  const { statements, buildError } = useMemo(() => {
    try {
      return { statements: buildAccountChanges(dialect, before, draft), buildError: null as string | null };
    } catch (cause) {
      return { statements: [] as string[], buildError: cause instanceof Error ? cause.message : String(cause) };
    }
  }, [dialect, before, draft]);
  const shownError = error ?? (step === "review" ? buildError : null);

  const validateAccount = (): string | null => {
    const name = draft.name.trim();
    if (!name) return "User name is required.";
    if (mode === "create") {
      const clash = allUsers.some((existing) => existing.name === name && (dialect === "postgres" || (existing.host ?? "%") === (draft.host || "%")));
      if (clash) return dialect === "mysql" ? `'${name}'@'${draft.host || "%"}' already exists.` : `Role "${name}" already exists.`;
    }
    if (draft.password && draft.password !== confirmPassword) return "Passwords do not match.";
    return null;
  };

  const goNext = () => {
    if (step === "account") {
      const problem = validateAccount();
      if (problem) { setError(problem); return; }
    }
    setError(null);
    setStepIndex((index) => Math.min(index + 1, steps.length - 1));
  };
  const goBack = () => { setError(null); setStepIndex((index) => Math.max(index - 1, 0)); };

  const apply = async () => {
    const problem = validateAccount();
    if (problem) { setError(problem); return; }
    setWorking(true);
    setError(null);
    try {
      await applySchemaChanges(connectionId, "", statements);
      onApplied(draft.name.trim(), draft.host || "%");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  };

  const title = mode === "edit"
    ? `Edit access · ${dialect === "mysql" ? `${user?.name}@${user?.host}` : user?.name}`
    : isClone ? `New user · cloned from ${user?.name}` : "New user";

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 p-6" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="w-full max-w-5xl h-[min(720px,100%)] flex flex-col rounded-lg border border-border bg-bg-primary shadow-2xl">
        <div className="flex items-center px-4 py-3 border-b border-border">
          <div className="text-sm font-semibold">{title}</div>
          <button onClick={onClose} className="ml-auto p-1 text-text-muted hover:text-text-primary cursor-pointer"><X size={14} /></button>
        </div>
        {shownError && <div className="px-4 py-2 text-xs text-error bg-error/10 border-b border-border">{shownError}</div>}

        <div className="flex-1 flex min-h-0">
          {/* Step rail */}
          <ol className="w-44 shrink-0 border-r border-border py-3 flex flex-col gap-0.5">
            {steps.map((id, index) => {
              const state = index === stepIndex ? "current" : index < stepIndex ? "done" : "todo";
              return (
                <li key={id}>
                  <button
                    onClick={() => {
                      if (index > stepIndex && step === "account") {
                        const problem = validateAccount();
                        if (problem) { setError(problem); return; }
                      }
                      setError(null);
                      setStepIndex(index);
                    }}
                    className={`w-full flex items-center gap-2.5 px-4 py-2 text-left text-xs transition-colors cursor-pointer ${
                      state === "current" ? "text-text-primary bg-bg-secondary" : "text-text-muted hover:text-text-secondary hover:bg-bg-hover"
                    }`}
                  >
                    <span className={`flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-semibold shrink-0 ${
                      state === "done" ? "bg-accent text-white" : state === "current" ? "border border-accent text-accent" : "border border-border text-text-muted"
                    }`}>
                      {state === "done" ? <Check size={10} /> : index + 1}
                    </span>
                    {STEP_LABELS[id]}
                  </button>
                </li>
              );
            })}
          </ol>

          {/* Step body */}
          <div className="flex-1 min-w-0 overflow-auto p-5">
            {step === "account" && (
              <AccountStep
                dialect={dialect}
                mode={mode}
                draft={draft}
                confirmPassword={confirmPassword}
                hosts={[...new Set(allUsers.map((u) => u.host ?? "%"))]}
                onChange={patch}
                onAttrsChange={patchAttrs}
                onConfirmPasswordChange={setConfirmPassword}
              />
            )}
            {step === "roles" && (
              <RolesStep dialect={dialect} draft={draft} allUsers={allUsers} onChange={(roles) => patch({ roles })} />
            )}
            {step === "global" && (
              <section className="flex flex-col gap-3">
                <StepIntro title="Global privileges" hint="Apply to every database on the server (GRANT … ON *.*). Administrative privileges like SUPER, PROCESS and FILE live here." />
                <PrivilegeChips
                  dialect={dialect}
                  scope="global"
                  value={draft.grants.global.privileges}
                  onChange={(privileges) => patchGrants((g) => ({ ...g, global: { ...g.global, privileges } }))}
                  withGrant={draft.grants.global.withGrant}
                  onWithGrantChange={(withGrant) => patchGrants((g) => ({ ...g, global: { ...g.global, withGrant } }))}
                />
              </section>
            )}
            {step === "databases" && (
              <DatabasesStep dialect={dialect} databases={databases} grants={draft.grants} onChange={patchGrants} />
            )}
            {step === "objects" && (
              <ObjectsStep connectionId={connectionId} dialect={dialect} databases={databases} objectDb={objectDb} grants={draft.grants} onChange={patchGrants} />
            )}
            {step === "review" && (
              <section className="flex flex-col gap-3">
                <StepIntro
                  title="Review"
                  hint={mode === "edit" ? "Only the differences from the current account are applied." : "These statements create the account and its access."}
                />
                <SqlReview statements={statements} emptyMessage="Nothing changed — go back and adjust access, or close." />
                {dialect === "mysql" && statements.length > 1 && (
                  <p className="text-[11px] text-text-muted">MySQL commits each statement immediately; if one fails, the earlier ones stay applied.</p>
                )}
              </section>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 px-4 py-3 border-t border-border">
          <button onClick={onClose} className="px-3 py-1.5 rounded border border-border text-xs cursor-pointer hover:bg-bg-hover">Cancel</button>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={goBack} disabled={stepIndex === 0} className="flex items-center gap-1 px-3 py-1.5 rounded border border-border text-xs cursor-pointer hover:bg-bg-hover disabled:opacity-40 disabled:cursor-default">
              <ChevronLeft size={12} /> Back
            </button>
            {step === "review" ? (
              <button
                disabled={working || statements.length === 0}
                onClick={() => void apply()}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-accent hover:bg-accent-hover text-white text-xs cursor-pointer disabled:opacity-50 disabled:cursor-default"
              >
                {working ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                {mode === "edit" ? "Apply changes" : "Create user"}
              </button>
            ) : (
              <button onClick={goNext} className="flex items-center gap-1 px-3 py-1.5 rounded bg-accent hover:bg-accent-hover text-white text-xs cursor-pointer">
                Next <ChevronRight size={12} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Shared step pieces ─────────────────────────────────── */

function StepIntro({ title, hint }: { title: string; hint: string }) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
      <p className="text-[11px] text-text-muted mt-0.5">{hint}</p>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-text-secondary">{label}</span>
      {children}
      {hint && <span className="text-[10px] text-text-muted">{hint}</span>}
    </label>
  );
}

function Toggle({ label, hint, checked, onChange, warn }: { label: string; hint?: string; checked: boolean; onChange: (next: boolean) => void; warn?: string }) {
  return (
    <label className="flex items-start gap-2.5 py-1.5 cursor-pointer select-none">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="mt-0.5" />
      <span className="flex flex-col">
        <span className="text-xs text-text-primary">{label}</span>
        {hint && <span className="text-[10px] text-text-muted">{hint}</span>}
        {warn && checked && <span className="flex items-center gap-1 text-[10px] text-warning mt-0.5"><AlertTriangle size={10} />{warn}</span>}
      </span>
    </label>
  );
}

/* ── Step 1: Account ────────────────────────────────────── */

function AccountStep({
  dialect, mode, draft, confirmPassword, hosts, onChange, onAttrsChange, onConfirmPasswordChange,
}: {
  dialect: UserDialect;
  mode: "create" | "edit";
  draft: AccountDraft;
  confirmPassword: string;
  hosts: string[];
  onChange: (partial: Partial<AccountDraft>) => void;
  onAttrsChange: (partial: Partial<AccountAttributes>) => void;
  onConfirmPasswordChange: (value: string) => void;
}) {
  const attrs = draft.attrs;
  return (
    <section className="flex flex-col gap-4 max-w-xl">
      <StepIntro title="Account" hint={dialect === "mysql" ? "MySQL accounts are a user name plus the host pattern they may connect from." : "Postgres roles double as users when they can log in."} />
      <div className={`grid gap-3 ${dialect === "mysql" ? "grid-cols-[1fr_180px]" : "grid-cols-1"}`}>
        <Field label={dialect === "mysql" ? "User name" : "Role name"}>
          <input value={draft.name} disabled={mode === "edit"} onChange={(event) => onChange({ name: event.target.value })} placeholder={dialect === "mysql" ? "app_user" : "app_role"} className="input-field font-mono disabled:opacity-60" autoFocus={mode === "create"} />
        </Field>
        {dialect === "mysql" && (
          <Field label="Host" hint={draft.host === "%" || draft.host === "" ? "% allows connections from any host." : undefined}>
            <input value={draft.host} disabled={mode === "edit"} list="sgsql-user-hosts" onChange={(event) => onChange({ host: event.target.value })} placeholder="%" className="input-field font-mono disabled:opacity-60" />
            <datalist id="sgsql-user-hosts">{hosts.map((host) => <option key={host} value={host} />)}</datalist>
          </Field>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label={mode === "edit" ? "New password" : "Password"} hint={mode === "edit" ? "Leave blank to keep the current password." : draft.password ? undefined : "No password: the account cannot authenticate with one."}>
          <input type="password" value={draft.password} onChange={(event) => onChange({ password: event.target.value })} className="input-field" autoComplete="new-password" />
        </Field>
        <Field label="Confirm password">
          <input type="password" value={confirmPassword} onChange={(event) => onConfirmPasswordChange(event.target.value)} className="input-field" autoComplete="new-password" />
        </Field>
      </div>

      <div className="border-t border-border pt-3">
        <div className="text-[11px] font-medium text-text-secondary mb-1">Attributes</div>
        {dialect === "postgres" ? (
          <div className="grid grid-cols-2 gap-x-6">
            <Toggle label="Can log in" hint="Roles without LOGIN act as groups." checked={attrs.canLogin} onChange={(canLogin) => onAttrsChange({ canLogin })} />
            <Toggle label="Locked" hint="Temporarily removes LOGIN without touching other attributes." checked={attrs.locked} onChange={(locked) => onAttrsChange({ locked })} />
            <Toggle label="Superuser" checked={attrs.superuser} onChange={(superuser) => onAttrsChange({ superuser })} warn="Bypasses every permission check." />
            <Toggle label="Create databases" checked={attrs.createDb} onChange={(createDb) => onAttrsChange({ createDb })} />
            <Toggle label="Create roles" checked={attrs.createRole} onChange={(createRole) => onAttrsChange({ createRole })} />
            <Toggle label="Replication" checked={attrs.replication} onChange={(replication) => onAttrsChange({ replication })} />
            <Toggle label="Bypass row-level security" checked={attrs.bypassRls} onChange={(bypassRls) => onAttrsChange({ bypassRls })} />
            <Toggle label="Inherit role privileges" checked={attrs.inherit} onChange={(inherit) => onAttrsChange({ inherit })} />
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-x-6">
            <Toggle label="Account locked" hint="Rejects new connections; existing sessions continue." checked={attrs.locked} onChange={(locked) => onAttrsChange({ locked })} />
          </div>
        )}
        <div className="grid grid-cols-2 gap-3 mt-2">
          <Field label="Connection limit" hint="Blank = unlimited.">
            <input
              type="number"
              min={0}
              value={attrs.connLimit ?? ""}
              onChange={(event) => onAttrsChange({ connLimit: event.target.value === "" ? null : Math.max(0, Number(event.target.value)) })}
              className="input-field"
            />
          </Field>
          {dialect === "postgres" && (
            <Field label="Valid until" hint="Timestamp the password stops working, e.g. 2030-01-01. Blank = never.">
              <input value={attrs.validUntil ?? ""} onChange={(event) => onAttrsChange({ validUntil: event.target.value || null })} placeholder="never" className="input-field font-mono" />
            </Field>
          )}
        </div>
      </div>
    </section>
  );
}

/* ── Step 2: Roles ──────────────────────────────────────── */

function RolesStep({ dialect, draft, allUsers, onChange }: { dialect: UserDialect; draft: AccountDraft; allUsers: DbUser[]; onChange: (roles: string[]) => void }) {
  const [filter, setFilter] = useState("");
  const candidates = useMemo(() => {
    const self = dialect === "mysql" ? `${draft.name}@${draft.host || "%"}` : draft.name;
    const list = allUsers
      .map((u) => ({
        key: dialect === "mysql" ? ((u.host ?? "%") === "%" ? u.name : `${u.name}@${u.host}`) : u.name,
        label: dialect === "mysql" ? `${u.name}@${u.host ?? "%"}` : u.name,
        group: dialect === "postgres" ? !u.canLogin : false,
      }))
      .filter((c) => c.label !== self && c.key !== draft.name);
    // Group roles (NOLOGIN) are the usual targets — list them first.
    list.sort((a, b) => Number(b.group) - Number(a.group) || a.label.localeCompare(b.label));
    return list;
  }, [allUsers, dialect, draft.name, draft.host]);
  const visible = fuzzySearch(candidates, filter, { keys: ["label"] });
  const toggle = (key: string) => onChange(draft.roles.includes(key) ? draft.roles.filter((r) => r !== key) : [...draft.roles, key]);

  return (
    <section className="flex flex-col gap-3 max-w-xl">
      <StepIntro title="Role membership" hint={dialect === "mysql" ? "Roles are named collections of privileges (MySQL 8+). Any account can be granted as a role." : "Membership grants every privilege the role holds (when INHERIT is on)."} />
      <div className="relative">
        <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
        <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter roles…" className="input-field !pl-7" />
      </div>
      <div className="rounded border border-border divide-y divide-border max-h-[420px] overflow-auto">
        {visible.length === 0 && <div className="px-3 py-4 text-xs text-text-muted text-center">No other accounts on this server.</div>}
        {visible.map((candidate) => (
          <label key={candidate.key} className="flex items-center gap-2.5 px-3 py-2 text-xs cursor-pointer hover:bg-bg-hover select-none">
            <input type="checkbox" checked={draft.roles.includes(candidate.key)} onChange={() => toggle(candidate.key)} />
            <span className="font-mono text-text-primary">{candidate.label}</span>
            {candidate.group && <span className="ml-auto text-[10px] text-text-muted">group role</span>}
          </label>
        ))}
      </div>
      {draft.roles.length > 0 && (
        <p className="text-[11px] text-text-muted">Member of: <span className="font-mono text-text-secondary">{draft.roles.join(", ")}</span></p>
      )}
    </section>
  );
}

/* ── Step: Databases ────────────────────────────────────── */

function DatabasesStep({ dialect, databases, grants, onChange }: { dialect: UserDialect; databases: string[]; grants: EditableGrants; onChange: (updater: (g: EditableGrants) => EditableGrants) => void }) {
  const [extra, setExtra] = useState<string[]>([]);
  const system = dialect === "mysql" ? ["information_schema", "performance_schema", "mysql", "sys"] : ["postgres"];
  const granted = grants.databases.filter((g) => g.privileges.length > 0 || g.withGrant).map((g) => g.db);
  const shown = [...new Set([...granted, ...extra])].sort();
  const available = databases.filter((db) => !shown.includes(db)).sort((a, b) => Number(system.includes(a)) - Number(system.includes(b)) || a.localeCompare(b));
  const grantFor = (db: string) => grants.databases.find((g) => g.db === db) ?? { db, privileges: [], withGrant: false };
  const update = (db: string, next: { privileges?: string[]; withGrant?: boolean }) => onChange((g) => {
    const current = grantFor(db);
    const merged = { ...current, ...next };
    const others = g.databases.filter((item) => item.db !== db);
    return { ...g, databases: [...others, merged] };
  });
  const remove = (db: string) => {
    onChange((g) => ({ ...g, databases: g.databases.filter((item) => item.db !== db) }));
    setExtra((list) => list.filter((item) => item !== db));
  };

  return (
    <section className="flex flex-col gap-3">
      <StepIntro title="Database access" hint={dialect === "mysql" ? "Privileges on every table in a database (GRANT … ON db.*)." : "CONNECT is required before any object inside the database is reachable. Schema and table privileges come next."} />
      <div className="flex flex-col gap-2">
        {shown.length === 0 && <div className="rounded border border-dashed border-border px-4 py-6 text-center text-xs text-text-muted">No database-level access yet. Add a database below.</div>}
        {shown.map((db) => {
          const grant = grantFor(db);
          return (
            <div key={db} className="rounded border border-border p-3 flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <Database size={12} className="text-accent" />
                <span className="text-xs font-mono font-medium text-text-primary">{db}</span>
                <button onClick={() => remove(db)} title="Remove all access to this database" className="ml-auto p-0.5 rounded text-text-muted hover:text-error hover:bg-error/10 cursor-pointer"><X size={12} /></button>
              </div>
              <PrivilegeChips
                dialect={dialect}
                scope="database"
                value={grant.privileges}
                onChange={(privileges) => update(db, { privileges })}
                withGrant={grant.withGrant}
                onWithGrantChange={(withGrant) => update(db, { withGrant })}
              />
            </div>
          );
        })}
      </div>
      {available.length > 0 && (
        <select
          value=""
          onChange={(event) => { if (event.target.value) setExtra((list) => [...list, event.target.value]); }}
          className="input-field max-w-xs"
        >
          <option value="">Add database…</option>
          {available.map((db) => <option key={db} value={db}>{db}{system.includes(db) ? "  (system)" : ""}</option>)}
        </select>
      )}
    </section>
  );
}

/* ── Step: Schemas & tables ─────────────────────────────── */

type ObjectTarget = { kind: "schema"; db: string; schema: string } | { kind: "table"; db: string; schema: string; table: string };

function targetKey(target: ObjectTarget): string {
  return target.kind === "schema" ? `s ${target.db} ${target.schema}` : `t ${target.db} ${target.schema} ${target.table}`;
}

function ObjectsStep({ connectionId, dialect, databases, objectDb, grants, onChange }: { connectionId: string; dialect: UserDialect; databases: string[]; objectDb: string; grants: EditableGrants; onChange: (updater: (g: EditableGrants) => EditableGrants) => void }) {
  const isPg = dialect === "postgres";
  const [db, setDb] = useState(isPg ? objectDb : (databases[0] ?? ""));
  const [schemas, setSchemas] = useState<string[]>(isPg ? ["public"] : [""]);
  const [schema, setSchema] = useState(isPg ? "public" : "");
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<ObjectTarget | null>(null);

  useEffect(() => {
    if (!isPg && !db && databases.length) setDb(databases[0]);
  }, [databases, db, isPg]);

  useEffect(() => {
    if (!isPg || !db) return;
    fetchSchemas(connectionId, db).then((items) => {
      const next = items.length ? items : ["public"];
      setSchemas(next);
      setSchema((current) => next.includes(current) ? current : next[0]);
    }).catch(() => setSchemas(["public"]));
  }, [connectionId, db, isPg]);

  useEffect(() => {
    if (!db) return;
    let cancelled = false;
    setLoading(true);
    fetchTables(connectionId, db, schema).then((items) => { if (!cancelled) setTables(items); }).catch(() => { if (!cancelled) setTables([]); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [connectionId, db, schema]);

  const existing: ObjectTarget[] = [
    ...grants.schemas.filter((g) => g.privileges.length > 0 || g.withGrant).map((g): ObjectTarget => ({ kind: "schema", db: g.db, schema: g.schema })),
    ...grants.tables.filter((g) => g.privileges.length > 0 || g.withGrant).map((g): ObjectTarget => ({ kind: "table", db: g.db, schema: g.schema, table: g.table })),
  ];
  const grantFor = (target: ObjectTarget) => target.kind === "schema"
    ? grants.schemas.find((g) => g.db === target.db && g.schema === target.schema) ?? { db: target.db, schema: target.schema, privileges: [], withGrant: false }
    : grants.tables.find((g) => g.db === target.db && g.schema === target.schema && g.table === target.table) ?? { db: target.db, schema: target.schema, table: target.table, privileges: [], withGrant: false };
  const update = (target: ObjectTarget, next: { privileges?: string[]; withGrant?: boolean }) => onChange((g) => {
    if (target.kind === "schema") {
      const merged = { ...grantFor(target) as EditableGrants["schemas"][number], ...next };
      return { ...g, schemas: [...g.schemas.filter((item) => !(item.db === target.db && item.schema === target.schema)), merged] };
    }
    const merged = { ...grantFor(target) as EditableGrants["tables"][number], ...next };
    return { ...g, tables: [...g.tables.filter((item) => !(item.db === target.db && item.schema === target.schema && item.table === target.table)), merged] };
  });
  const remove = (target: ObjectTarget) => {
    update(target, { privileges: [], withGrant: false });
    if (selected && targetKey(selected) === targetKey(target)) setSelected(null);
  };
  const label = (target: ObjectTarget) => {
    if (target.kind === "schema") return `${target.schema}.*`;
    return isPg ? `${target.schema}.${target.table}` : `${target.db}.${target.table}`;
  };
  const visibleTables = fuzzySearch(tables, filter, { keys: ["name"] });
  const selectedGrant = selected ? grantFor(selected) : null;
  const selectedKey = selected ? targetKey(selected) : null;

  return (
    <section className="flex flex-col gap-3 h-full">
      <StepIntro title="Schemas & tables" hint={isPg ? `Object grants live inside one database; showing ${objectDb}. Grant USAGE on a schema before its tables are reachable.` : "Table-level privileges (GRANT … ON db.table)."} />

      {existing.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {existing.map((target) => {
            const key = targetKey(target);
            const grant = grantFor(target);
            return (
              <button
                key={key}
                onClick={() => { setSelected(target); if (target.db !== db && !isPg) setDb(target.db); if (target.schema !== schema && isPg) setSchema(target.schema); }}
                className={`group flex items-center gap-1.5 pl-2 pr-1 py-1 rounded border text-[11px] cursor-pointer transition-colors ${
                  selectedKey === key ? "border-accent bg-accent/10 text-text-primary" : "border-border text-text-secondary hover:bg-bg-hover"
                }`}
              >
                {target.kind === "schema" ? <FolderTree size={11} className="text-purple-400" /> : <Table2 size={11} className="text-accent" />}
                <span className="font-mono">{label(target)}</span>
                <span className="text-[10px] text-text-muted">{grant.privileges.length}</span>
                <span onClick={(event) => { event.stopPropagation(); remove(target); }} title="Remove" className="p-0.5 rounded text-text-muted hover:text-error"><X size={10} /></span>
              </button>
            );
          })}
        </div>
      )}

      <div className="flex-1 min-h-0 grid grid-cols-[260px_1fr] gap-3">
        {/* Picker */}
        <div className="flex flex-col gap-2 min-h-0">
          {!isPg && (
            <select value={db} onChange={(event) => { setDb(event.target.value); setSelected(null); }} className="input-field">
              {databases.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          )}
          {isPg && (
            <select value={schema} onChange={(event) => setSchema(event.target.value)} className="input-field">
              {schemas.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          )}
          <div className="relative">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
            <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter tables…" className="input-field !pl-7" />
          </div>
          <div className="flex-1 min-h-[200px] max-h-[360px] overflow-auto rounded border border-border">
            {isPg && (
              <button
                onClick={() => setSelected({ kind: "schema", db, schema })}
                className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-xs border-b border-border cursor-pointer ${selectedKey === targetKey({ kind: "schema", db, schema }) ? "bg-bg-active text-text-primary" : "text-text-secondary hover:bg-bg-hover"}`}
              >
                <FolderTree size={11} className="text-purple-400" />
                <span className="font-mono">{schema}</span>
                <span className="ml-auto text-[10px] text-text-muted">schema</span>
              </button>
            )}
            {loading && <div className="flex items-center gap-2 px-3 py-3 text-xs text-text-muted"><Loader2 size={12} className="animate-spin" />Loading…</div>}
            {!loading && visibleTables.map((table) => {
              const target: ObjectTarget = { kind: "table", db, schema, table: table.name };
              const key = targetKey(target);
              const count = grantFor(target).privileges.length;
              return (
                <button
                  key={key}
                  onClick={() => setSelected(target)}
                  className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-xs cursor-pointer ${selectedKey === key ? "bg-bg-active text-text-primary" : "text-text-secondary hover:bg-bg-hover"}`}
                >
                  <Table2 size={11} className={table.type === "view" ? "text-purple-400" : "text-accent"} />
                  <span className="font-mono truncate">{table.name}</span>
                  {count > 0 && <span className="ml-auto text-[10px] text-accent">{count}</span>}
                </button>
              );
            })}
            {!loading && visibleTables.length === 0 && <div className="px-3 py-3 text-xs text-text-muted text-center">No tables</div>}
          </div>
        </div>

        {/* Editor */}
        <div className="rounded border border-border p-3 min-h-0 overflow-auto">
          {!selected || !selectedGrant ? (
            <div className="h-full flex items-center justify-center text-xs text-text-muted">Select a {isPg ? "schema or table" : "table"} to set its privileges.</div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                {selected.kind === "schema" ? <FolderTree size={13} className="text-purple-400" /> : <Table2 size={13} className="text-accent" />}
                <span className="text-xs font-mono font-medium text-text-primary">{label(selected)}</span>
              </div>
              <PrivilegeChips
                dialect={dialect}
                scope={selected.kind === "schema" ? "schema" : "table"}
                value={selectedGrant.privileges}
                onChange={(privileges) => update(selected, { privileges })}
                withGrant={selectedGrant.withGrant}
                onWithGrantChange={(withGrant) => update(selected, { withGrant })}
              />
            </div>
          )}
        </div>
      </div>
      <p className="text-[10px] text-text-muted">Column and routine grants are shown on the account page but are edited via SQL.</p>
    </section>
  );
}
