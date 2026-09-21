import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Bot, Check, Clipboard, Eye, EyeOff, Loader2, Search, Square, SquareCheck, SquareMinus, X } from "lucide-react";
import type { ConnectionProfile } from "../lib/types";
import { fetchCatalog } from "../lib/schema";
import { fuzzySearch } from "../lib/fuzzySearch";
import { createShare, getShare, stopShare, type ShareInfo, type ShareTable } from "../lib/shares";
import { buildMcpConfig, redactSnippet } from "../lib/mcpConfig";
import { Chips } from "./PrivilegeChips";

interface Props {
  open: boolean;
  connectionId: string;
  profile: ConnectionProfile;
  /** Active database (MySQL picks tables from it; Postgres/SQLite ignore it). */
  db: string;
  share: ShareInfo | null;
  onStarted: (share: ShareInfo) => void;
  onStopped: () => void;
  onClose: () => void;
}

const TIMEOUTS = [5_000, 15_000, 30_000, 60_000];

const LIMITATIONS =
  "Enforced by SGSql before each statement reaches the database: one statement per call, only the shared tables, " +
  "DDL and side-effect functions rejected. Shared views may still read tables that are not shared.";

function tableKey(table: ShareTable): string {
  return `${table.schema}.${table.name}`;
}

export function ShareConnectionModal({ open, connectionId, profile, db, share, onStarted, onStopped, onClose }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 p-6" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="w-full max-w-2xl max-h-full flex flex-col rounded-lg border border-border bg-bg-primary shadow-2xl">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
          <Bot size={15} className="text-accent" />
          <div className="text-sm font-semibold">Share with AI agent</div>
          <span className="text-xs text-text-muted truncate">{profile.name || "Untitled"}</span>
          <button onClick={onClose} className="ml-auto p-1 text-text-muted hover:text-text-primary cursor-pointer"><X size={14} /></button>
        </div>
        {share
          ? <ActiveView share={share} profile={profile} onStopped={onStopped} onClose={onClose} />
          : <SetupView connectionId={connectionId} profile={profile} db={db} onStarted={onStarted} onClose={onClose} />}
      </div>
    </div>
  );
}

/* ── Setup: pick tables and options ─────────────────────── */

function SetupView({ connectionId, profile, db, onStarted, onClose }: Pick<Props, "connectionId" | "profile" | "db" | "onStarted" | "onClose">) {
  const [tables, setTables] = useState<ShareTable[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [readOnly, setReadOnly] = useState(true);
  const [maxRows, setMaxRows] = useState(500);
  const [timeoutMs, setTimeoutMs] = useState(15_000);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setTables(null);
    fetchCatalog(connectionId, db)
      .then((catalog) => {
        if (cancelled) return;
        const list = catalog.tables
          .filter((table) => profile.type !== "mysql" || !db || table.db === db)
          .map((table) => ({ schema: table.schema, name: table.name, type: table.type }));
        setTables(list);
      })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [connectionId, db, profile.type]);

  const visible = useMemo(() => {
    if (!tables) return [];
    const trimmed = query.trim();
    return trimmed ? fuzzySearch(tables, trimmed, { keys: ["name"] }) : tables;
  }, [tables, query]);

  const groups = useMemo(() => {
    const map = new Map<string, ShareTable[]>();
    for (const table of visible) {
      const list = map.get(table.schema) ?? [];
      list.push(table);
      map.set(table.schema, list);
    }
    return [...map.entries()];
  }, [visible]);

  const toggle = (table: ShareTable) => {
    setSelected((current) => {
      const next = new Set(current);
      const key = tableKey(table);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };
  const toggleGroup = (list: ShareTable[]) => {
    setSelected((current) => {
      const next = new Set(current);
      const all = list.every((table) => next.has(tableKey(table)));
      for (const table of list) {
        if (all) next.delete(tableKey(table)); else next.add(tableKey(table));
      }
      return next;
    });
  };

  const start = async () => {
    if (!tables || selected.size === 0) return;
    setWorking(true); setError(null);
    try {
      const share = await createShare({
        connectionId,
        db: profile.type === "mysql" ? db : undefined,
        tables: tables.filter((table) => selected.has(tableKey(table))),
        readOnly,
        maxRows,
        timeoutMs,
      });
      onStarted(share);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  };

  const showSchema = groups.length > 1 || (groups.length === 1 && profile.type === "postgres" && groups[0][0] !== "public");

  return <>
    {error && <div className="px-4 py-2 text-xs text-error bg-error/10">{error}</div>}
    <div className="flex flex-col min-h-0 p-4 gap-3">
      <p className="text-[11px] text-text-muted">
        Starts a local MCP server bound to this connection. The agent only sees the tables you pick, through SGSql — your database credentials are never shared.
      </p>

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter tables" className="input-field !pl-7" autoFocus />
        </div>
        <span className="text-[11px] text-text-muted whitespace-nowrap">{selected.size} of {tables?.length ?? 0} selected</span>
      </div>

      <div className="min-h-[160px] max-h-[40vh] overflow-auto rounded border border-border bg-bg-secondary">
        {!tables && !error && <div className="flex items-center justify-center gap-2 py-10 text-xs text-text-muted"><Loader2 size={12} className="animate-spin" />Loading tables…</div>}
        {tables && tables.length === 0 && <div className="py-10 text-center text-xs text-text-muted">No tables in this database.</div>}
        {tables && tables.length > 0 && visible.length === 0 && <div className="py-10 text-center text-xs text-text-muted">No tables match.</div>}
        {groups.map(([schema, list]) => {
          const count = list.filter((table) => selected.has(tableKey(table))).length;
          const GroupIcon = count === 0 ? Square : count === list.length ? SquareCheck : SquareMinus;
          return (
            <div key={schema}>
              {showSchema && (
                <button onClick={() => toggleGroup(list)} className="sticky top-0 w-full flex items-center gap-2 px-2.5 py-1.5 bg-bg-secondary border-b border-border text-[10px] uppercase tracking-wide text-text-muted hover:text-text-primary cursor-pointer">
                  <GroupIcon size={12} className={count > 0 ? "text-accent" : ""} />
                  {schema}
                  <span className="ml-auto normal-case tracking-normal">{count}/{list.length}</span>
                </button>
              )}
              {!showSchema && list.length > 1 && (
                <button onClick={() => toggleGroup(list)} className="sticky top-0 w-full flex items-center gap-2 px-2.5 py-1.5 bg-bg-secondary border-b border-border text-[10px] text-text-muted hover:text-text-primary cursor-pointer">
                  <GroupIcon size={12} className={count > 0 ? "text-accent" : ""} />
                  {count === list.length ? "Deselect all" : "Select all"}
                </button>
              )}
              {list.map((table) => {
                const checked = selected.has(tableKey(table));
                return (
                  <label key={tableKey(table)} className={`flex items-center gap-2 px-2.5 py-1 text-xs cursor-pointer hover:bg-bg-hover ${checked ? "text-text-primary" : "text-text-secondary"}`}>
                    <input type="checkbox" checked={checked} onChange={() => toggle(table)} />
                    <span className="font-mono truncate">{table.name}</span>
                    {table.type === "view" && <span className="text-[9px] uppercase px-1 rounded border border-border text-text-muted">view</span>}
                  </label>
                );
              })}
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-[1fr_auto_auto] gap-4 items-start">
        <label className="flex items-start gap-2.5 py-1 cursor-pointer select-none">
          <input type="checkbox" checked={readOnly} onChange={(event) => setReadOnly(event.target.checked)} className="mt-0.5" />
          <span className="flex flex-col">
            <span className="text-xs text-text-primary">Read-only</span>
            <span className="text-[10px] text-text-muted">Only SELECT / WITH / EXPLAIN queries are executed.</span>
            {!readOnly && <span className="flex items-center gap-1 text-[10px] text-warning mt-0.5"><AlertTriangle size={10} />The agent can INSERT, UPDATE and DELETE rows in the selected tables.</span>}
          </span>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-text-secondary">Max rows</span>
          <input type="number" min={1} max={10000} value={maxRows} onChange={(event) => setMaxRows(Math.max(1, Math.min(10000, Number(event.target.value) || 1)))} className="input-field !w-24" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-text-secondary">Timeout</span>
          <select value={timeoutMs} onChange={(event) => setTimeoutMs(Number(event.target.value))} className="input-field !w-24">
            {TIMEOUTS.map((value) => <option key={value} value={value}>{value / 1000} s</option>)}
          </select>
        </label>
      </div>
      <p className="text-[10px] text-text-muted">{LIMITATIONS}</p>
    </div>
    <div className="flex justify-end gap-2 p-4 border-t border-border">
      <button onClick={onClose} className="px-3 py-1.5 border border-border rounded text-xs cursor-pointer">Cancel</button>
      <button disabled={working || selected.size === 0} onClick={() => void start()} className="flex items-center gap-1 px-3 py-1.5 rounded bg-accent text-white text-xs cursor-pointer disabled:opacity-50 disabled:cursor-default">
        {working ? <Loader2 size={12} className="animate-spin" /> : <Bot size={12} />}
        Start sharing
      </button>
    </div>
  </>;
}

/* ── Active: config snippets and stats ───────────────────── */

type SnippetTab = "claude" | "claudeJson" | "cursor";

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
      className="flex items-center gap-1 px-2 py-1 rounded border border-border bg-bg-primary text-[11px] cursor-pointer hover:bg-bg-hover"
    >
      {copied ? <Check size={11} /> : <Clipboard size={11} />}
      {copied ? "Copied" : label}
    </button>
  );
}

function ActiveView({ share, profile, onStopped, onClose }: { share: ShareInfo; profile: ConnectionProfile; onStopped: () => void; onClose: () => void }) {
  const [tab, setTab] = useState<SnippetTab>("claude");
  const [reveal, setReveal] = useState(false);
  const [stats, setStats] = useState(share.stats);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      getShare(share.id).then((latest) => { if (!cancelled) setStats(latest.stats); }).catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 5_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [share.id]);

  const token = share.token ?? "";
  const snippets = useMemo(() => buildMcpConfig({ url: share.url, token }, profile.name), [share.url, token, profile.name]);
  const snippet = tab === "claude" ? snippets.claudeCommand : tab === "claudeJson" ? snippets.claudeJson : snippets.cursorJson;
  const shown = reveal ? snippet : redactSnippet(snippet, token);

  const stop = async () => {
    setStopping(true); setError(null);
    try {
      await stopShare(share.id);
      onStopped();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStopping(false);
    }
  };

  const tabButton = (id: SnippetTab, label: string) => (
    <button key={id} onClick={() => setTab(id)} className={`px-2 py-1 rounded text-[11px] cursor-pointer ${tab === id ? "bg-accent/10 text-accent" : "text-text-muted hover:text-text-primary hover:bg-bg-hover"}`}>
      {label}
    </button>
  );

  return <>
    {error && <div className="px-4 py-2 text-xs text-error bg-error/10">{error}</div>}
    <div className="flex flex-col min-h-0 p-4 gap-3 overflow-auto">
      <div className="flex items-center gap-2 text-xs">
        <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full rounded-full bg-success opacity-60 animate-ping" /><span className="relative inline-flex h-2 w-2 rounded-full bg-success" /></span>
        <span className="text-text-primary">Sharing {share.tables.length} {share.tables.length === 1 ? "table" : "tables"} ({share.readOnly ? "read-only" : "read-write"})</span>
        <span className="ml-auto text-[11px] text-text-muted">{stats.calls} calls · {stats.rejected} rejected · {stats.errors} errors</span>
      </div>

      <Chips items={share.tables.map((table) => (profile.type === "postgres" && table.schema !== "public" ? `${table.schema}.${table.name}` : table.name))} />

      <div className="flex items-center gap-1">
        {tabButton("claude", "Claude Code")}
        {tabButton("claudeJson", ".mcp.json")}
        {tabButton("cursor", "Cursor")}
        <button onClick={() => setReveal((value) => !value)} title={reveal ? "Hide token" : "Reveal token"} className="ml-auto p-1 rounded text-text-muted hover:text-text-primary cursor-pointer">
          {reveal ? <EyeOff size={12} /> : <Eye size={12} />}
        </button>
        <CopyButton text={snippet} />
      </div>
      <pre className="p-3 rounded border border-border bg-bg-secondary text-[11px] font-mono whitespace-pre-wrap break-all select-all">{shown}</pre>

      <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[11px] text-text-muted">
        <span>Endpoint</span><span className="font-mono text-text-secondary truncate">{share.url}</span>
        <span>Row cap</span><span className="text-text-secondary">{share.maxRows} rows per query</span>
        <span>Timeout</span><span className="text-text-secondary">{share.timeoutMs / 1000} s per statement</span>
      </div>
      <p className="text-[10px] text-text-muted">
        Session only — sharing stops when this tab is closed or SGSql quits, and the token changes each time. Agent queries appear in the query console. {LIMITATIONS}
      </p>
    </div>
    <div className="flex justify-end gap-2 p-4 border-t border-border">
      <button disabled={stopping} onClick={() => void stop()} className="flex items-center gap-1 px-3 py-1.5 rounded border border-error/40 text-error text-xs cursor-pointer hover:bg-error/10 disabled:opacity-50">
        {stopping && <Loader2 size={12} className="animate-spin" />}
        Stop sharing
      </button>
      <button onClick={onClose} className="px-3 py-1.5 rounded bg-accent text-white text-xs cursor-pointer">Close</button>
    </div>
  </>;
}
