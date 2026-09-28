import { useEffect, useState } from "react";
import { Loader2, Pause, Play, RefreshCw, Unplug, OctagonX, X } from "lucide-react";
import { useProcessList, type KillMode } from "../lib/processList";
import type { ServerProcess } from "../lib/schema";

const REFRESH_INTERVAL_MS = 3000;

export function ProcessListActions({ connectionId }: { connectionId: string | null }) {
  const processes = useProcessList((s) => s.processes);
  const loading = useProcessList((s) => s.loading);
  const hideIdle = useProcessList((s) => s.hideIdle);
  const autoRefresh = useProcessList((s) => s.autoRefresh);
  const setHideIdle = useProcessList((s) => s.setHideIdle);
  const setAutoRefresh = useProcessList((s) => s.setAutoRefresh);
  const refresh = useProcessList((s) => s.refresh);
  const listConnection = useProcessList((s) => s.connectionId);

  const current = listConnection === connectionId ? processes : [];
  const active = current.filter((p) => !p.idle).length;

  return (
    <div className="flex items-center gap-1">
      <span className="text-[10px] text-text-secondary tabular-nums mr-1">
        {active} active · {current.length} total
      </span>
      <label className="flex items-center gap-1 px-1.5 py-1 rounded text-[10px] font-medium text-text-secondary hover:bg-bg-hover cursor-pointer select-none">
        <input
          type="checkbox"
          checked={hideIdle}
          onChange={(e) => setHideIdle(e.target.checked)}
          className="accent-accent cursor-pointer"
        />
        Hide idle
      </label>
      <button
        onClick={() => setAutoRefresh(!autoRefresh)}
        disabled={!connectionId}
        title={autoRefresh ? "Pause auto-refresh" : `Auto-refresh every ${REFRESH_INTERVAL_MS / 1000}s`}
        className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer disabled:opacity-40"
      >
        {autoRefresh ? <Pause size={10} /> : <Play size={10} />}
        {autoRefresh ? "Live" : "Paused"}
      </button>
      <button
        onClick={() => connectionId && void refresh(connectionId)}
        disabled={!connectionId}
        title="Refresh now"
        className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer disabled:opacity-40"
      >
        <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
      </button>
    </div>
  );
}

export function ProcessList({ connectionId }: { connectionId: string | null }) {
  const processes = useProcessList((s) => s.processes);
  const supported = useProcessList((s) => s.supported);
  const loading = useProcessList((s) => s.loading);
  const error = useProcessList((s) => s.error);
  const notice = useProcessList((s) => s.notice);
  const hideIdle = useProcessList((s) => s.hideIdle);
  const autoRefresh = useProcessList((s) => s.autoRefresh);
  const listConnection = useProcessList((s) => s.connectionId);
  const [confirming, setConfirming] = useState<{ id: number; mode: KillMode } | null>(null);
  const [killing, setKilling] = useState<number | null>(null);

  // Poll only while this tab is mounted, i.e. visible.
  useEffect(() => {
    if (!connectionId) return;
    const { refresh } = useProcessList.getState();
    void refresh(connectionId);
    if (!autoRefresh) return;
    const timer = setInterval(() => void refresh(connectionId), REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [connectionId, autoRefresh]);

  useEffect(() => setConfirming(null), [connectionId]);

  if (!connectionId) return <Empty>Connect to a server to see its processes</Empty>;
  if (listConnection !== connectionId || (loading && processes.length === 0 && !error)) {
    return <Empty><Loader2 size={12} className="animate-spin" /></Empty>;
  }
  if (!supported) return <Empty>SQLite runs in-process and has no server process list</Empty>;

  const visible = hideIdle ? processes.filter((p) => !p.idle) : processes;

  const runKill = async (id: number, mode: KillMode) => {
    setConfirming(null);
    setKilling(id);
    await useProcessList.getState().kill(connectionId, id, mode);
    setKilling(null);
  };

  return (
    <div className="flex flex-col h-full min-h-0 selectable">
      {error && (
        <div className="px-3 py-2 text-[11px] text-error bg-error/5 border-b border-border break-words">
          {error}
        </div>
      )}
      {notice && (
        <div className={`flex items-start gap-2 px-3 py-1.5 text-[11px] border-b border-border ${
          notice.kind === "error" ? "text-error bg-error/5" : "text-success bg-success/5"
        }`}>
          <span className="flex-1 min-w-0 break-words">{notice.text}</span>
          <button
            onClick={() => useProcessList.getState().dismissNotice()}
            title="Dismiss"
            className="p-0.5 rounded opacity-70 hover:opacity-100 transition-opacity cursor-pointer shrink-0"
          >
            <X size={10} />
          </button>
        </div>
      )}

      <div className="flex-1 overflow-auto min-h-0">
        {visible.length === 0 ? (
          error ? null : <Empty>{processes.length === 0 ? "No other sessions" : "No active sessions — everything else is idle"}</Empty>
        ) : (
          <table className="w-full font-mono text-[11px] border-collapse">
            <thead className="sticky top-0 z-10 bg-bg-secondary text-text-muted text-left">
              <tr>
                <Th className="w-0" />
                <Th>ID</Th>
                <Th>User</Th>
                <Th>Host</Th>
                <Th>DB</Th>
                <Th>Command</Th>
                <Th className="text-right">Time</Th>
                <Th>State</Th>
                <Th className="w-full">Query</Th>
              </tr>
            </thead>
            <tbody>
              {visible.map((p) => (
                <ProcessRow
                  key={p.id}
                  process={p}
                  confirming={confirming?.id === p.id ? confirming.mode : null}
                  killing={killing === p.id}
                  onAsk={(mode) => setConfirming({ id: p.id, mode })}
                  onCancel={() => setConfirming(null)}
                  onKill={(mode) => void runKill(p.id, mode)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function ProcessRow({
  process: p,
  confirming,
  killing,
  onAsk,
  onCancel,
  onKill,
}: {
  process: ServerProcess;
  confirming: KillMode | null;
  killing: boolean;
  onAsk: (mode: KillMode) => void;
  onCancel: () => void;
  onKill: (mode: KillMode) => void;
}) {
  const time = p.time ?? 0;
  const timeColor = p.idle ? "text-text-muted" : time >= 300 ? "text-error" : time >= 30 ? "text-warning" : "text-success";

  return (
    <tr className={`border-b border-border/50 hover:bg-bg-hover/50 ${confirming ? "bg-error/5" : ""} ${p.idle ? "text-text-muted" : "text-text-primary"}`}>
      <td className="px-2 py-1 whitespace-nowrap">
        {killing ? (
          <Loader2 size={11} className="animate-spin text-text-muted" />
        ) : confirming ? (
          <span className="flex items-center gap-1 font-sans">
            <span className="text-[10px] text-error">
              {confirming === "query" ? "Kill query?" : "Kill connection?"}
              {p.own && " (SGSql's own)"}
            </span>
            <button
              onClick={() => onKill(confirming)}
              className="px-1.5 py-0.5 rounded text-[10px] font-semibold text-white bg-error hover:bg-error/80 transition-colors cursor-pointer"
            >
              Kill
            </button>
            <button
              onClick={onCancel}
              className="px-1.5 py-0.5 rounded text-[10px] font-medium text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
            >
              Cancel
            </button>
          </span>
        ) : (
          <span className="flex items-center gap-0.5">
            <button
              onClick={() => onAsk("query")}
              disabled={p.idle}
              title={p.idle ? "Nothing running to kill" : "Kill the running query, keep the session"}
              className="p-0.5 rounded text-text-muted hover:text-error hover:bg-error/10 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default"
            >
              <OctagonX size={12} />
            </button>
            <button
              onClick={() => onAsk("connection")}
              title="Kill the whole connection"
              className="p-0.5 rounded text-text-muted hover:text-error hover:bg-error/10 transition-colors cursor-pointer"
            >
              <Unplug size={12} />
            </button>
          </span>
        )}
      </td>
      <Td className="tabular-nums">
        {p.id}
        {p.own && (
          <span className="ml-1.5 font-sans text-[9px] font-semibold text-accent px-1 rounded bg-accent/10" title="One of SGSql's own connections">
            this app
          </span>
        )}
      </Td>
      <Td>{p.user}</Td>
      <Td className="max-w-40 truncate" title={p.host ?? undefined}>{p.host}</Td>
      <Td>{p.db}</Td>
      <Td>{p.command}</Td>
      <Td className={`text-right tabular-nums ${timeColor}`}>{p.time === null ? "" : formatDuration(p.time)}</Td>
      <Td className="max-w-48 truncate" title={p.state ?? undefined}>{p.state}</Td>
      <Td className="max-w-0 w-full truncate" title={p.info ?? undefined}>{p.info && collapseWhitespace(p.info)}</Td>
    </tr>
  );
}

function Th({ className = "", children }: { className?: string; children?: React.ReactNode }) {
  return (
    <th className={`px-2 py-1 font-sans text-[10px] font-semibold uppercase tracking-wider whitespace-nowrap border-b border-border ${className}`}>
      {children}
    </th>
  );
}

function Td({ className = "", title, children }: { className?: string; title?: string; children?: React.ReactNode }) {
  return <td className={`px-2 py-1 whitespace-nowrap ${className}`} title={title}>{children}</td>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-center h-full text-text-muted text-[11px]">
      {children}
    </div>
  );
}

function collapseWhitespace(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}
