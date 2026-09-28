import { create } from "zustand";
import { fetchProcesses, killProcess, type ServerProcess } from "./schema";

export type KillMode = "query" | "connection";

interface ProcessListState {
  /** Connection the current list belongs to. */
  connectionId: string | null;
  processes: ServerProcess[];
  supported: boolean;
  loading: boolean;
  error: string | null;
  /** Result of the last kill, shown until dismissed or replaced. */
  notice: { kind: "success" | "error"; text: string } | null;
  hideIdle: boolean;
  autoRefresh: boolean;
  refresh: (connectionId: string) => Promise<void>;
  kill: (connectionId: string, id: number, mode: KillMode) => Promise<void>;
  setHideIdle: (hideIdle: boolean) => void;
  setAutoRefresh: (autoRefresh: boolean) => void;
  dismissNotice: () => void;
}

// One list request at a time; auto-refresh ticks that land mid-flight are dropped.
let inFlight: Promise<void> | null = null;

export const useProcessList = create<ProcessListState>((set, get) => ({
  connectionId: null,
  processes: [],
  supported: true,
  loading: false,
  error: null,
  notice: null,
  hideIdle: true,
  autoRefresh: true,

  refresh(connectionId) {
    if (get().connectionId !== connectionId) {
      set({ connectionId, processes: [], supported: true, error: null, notice: null });
    } else if (inFlight) {
      return inFlight;
    }
    set({ loading: true });
    const request = fetchProcesses(connectionId)
      .then(({ supported, processes }) => {
        if (get().connectionId !== connectionId) return;
        set({ supported, processes, error: null });
      })
      .catch((error: unknown) => {
        if (get().connectionId !== connectionId) return;
        set({ error: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        if (inFlight === request) inFlight = null;
        if (get().connectionId === connectionId) set({ loading: false });
      });
    inFlight = request;
    return request;
  },

  async kill(connectionId, id, mode) {
    try {
      const { detail } = await killProcess(connectionId, id, mode);
      set({ notice: { kind: "success", text: detail || `Killed ${id}` } });
    } catch (error) {
      set({ notice: { kind: "error", text: error instanceof Error ? error.message : String(error) } });
    }
    // A list request started before the kill would still show the victim.
    if (inFlight) await inFlight;
    await get().refresh(connectionId);
  },

  setHideIdle: (hideIdle) => set({ hideIdle }),
  setAutoRefresh: (autoRefresh) => set({ autoRefresh }),
  dismissNotice: () => set({ notice: null }),
}));
