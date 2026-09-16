import { create } from "zustand";
import { getSidecarConnection } from "./sidecar";

export interface QueryLogEntry {
  id: number;
  timestamp: Date;
  query: string;
  db: string;
  schema: string;
  table: string;
  duration: number;
  rowCount?: number;
  error?: string;
  cancelled?: boolean;
  cancelDetail?: string;
}

interface WireQueryLogEntry extends Omit<QueryLogEntry, "timestamp" | "schema" | "table"> {
  connectionId: string;
  timestamp: string;
}

interface QueryLogState {
  entries: QueryLogEntry[];
  replace: (entries: WireQueryLogEntry[]) => void;
  append: (entry: WireQueryLogEntry) => void;
  clearLocal: () => void;
  clear: () => void;
}

function fromWire(entry: WireQueryLogEntry): QueryLogEntry {
  return { ...entry, timestamp: new Date(entry.timestamp), schema: "", table: "" };
}

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;
let clearPending = false;

export const useQueryLog = create<QueryLogState>((set) => ({
  entries: [],
  replace: (entries) => set({ entries: entries.map(fromWire) }),
  append: (entry) => set((state) => ({ entries: [...state.entries, fromWire(entry)].slice(-1_000) })),
  clearLocal: () => set({ entries: [] }),
  clear: () => {
    set({ entries: [] });
    if (socket?.readyState === WebSocket.OPEN) socket.send("clear");
    else clearPending = true;
  },
}));

async function connect(): Promise<void> {
  let connection;
  try {
    connection = await getSidecarConnection();
    socket = new WebSocket(`${connection.webSocketUrl}/query-log`, [
      "sgsql",
      `sgsql-auth.${connection.token}`,
    ]);
  } catch (error) {
    console.warn("[query-log] WebSocket connection failed:", error);
    socket = null;
    reconnectTimer = setTimeout(() => void connect(), 1_000);
    return;
  }
  socket.onopen = () => {
    if (clearPending) {
      clearPending = false;
      socket?.send("clear");
    }
  };
  socket.onmessage = (event) => {
    let message: { type?: string; entry?: WireQueryLogEntry; entries?: WireQueryLogEntry[] };
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (message.type === "snapshot" && message.entries) useQueryLog.getState().replace(message.entries);
    else if (message.type === "entry" && message.entry) useQueryLog.getState().append(message.entry);
    else if (message.type === "cleared") useQueryLog.getState().clearLocal();
  };
  socket.onerror = () => socket?.close();
  socket.onclose = () => {
    socket = null;
    reconnectTimer = setTimeout(() => void connect(), 1_000);
  };
}

export function startQueryLog(): void {
  if (started) return;
  started = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  void connect();
}
