import type { ServerWebSocket } from "bun";

export interface SidecarQueryLogEntry {
  id: number;
  connectionId: string;
  db: string;
  query: string;
  timestamp: string;
  duration: number;
  rowCount?: number;
  error?: string;
  cancelled?: boolean;
  cancelDetail?: string;
}

export interface QueryLogSocketData {
  channel: "query-log";
}

const MAX_ENTRIES = 1_000;
const entries: SidecarQueryLogEntry[] = [];
const subscribers = new Set<ServerWebSocket<QueryLogSocketData>>();
let nextId = 0;

export function appendQueryLog(entry: Omit<SidecarQueryLogEntry, "id">): void {
  const stored = { ...entry, id: ++nextId };
  entries.push(stored);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  const message = JSON.stringify({ type: "entry", entry: stored });
  for (const socket of subscribers) socket.send(message);
}

export function subscribeQueryLog(socket: ServerWebSocket<QueryLogSocketData>): void {
  subscribers.add(socket);
  socket.send(JSON.stringify({ type: "snapshot", entries }));
}

export function unsubscribeQueryLog(socket: ServerWebSocket<QueryLogSocketData>): void {
  subscribers.delete(socket);
}

export function clearQueryLog(): void {
  entries.length = 0;
  const message = JSON.stringify({ type: "cleared" });
  for (const socket of subscribers) socket.send(message);
}
