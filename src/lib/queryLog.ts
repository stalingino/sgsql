import { create } from "zustand";

export interface QueryLogEntry {
  id: number;
  timestamp: Date;
  query: string;
  db: string;
  schema: string;
  table: string;
  duration: number; // ms
  rowCount?: number;
  error?: string;
  cancelled?: boolean;
  cancelDetail?: string;
}

let logIdCounter = 0;

interface QueryLogState {
  entries: QueryLogEntry[];
  enabled: boolean;
  addEntry: (entry: Omit<QueryLogEntry, "id">) => void;
  clear: () => void;
  setEnabled: (enabled: boolean) => void;
}

export const useQueryLog = create<QueryLogState>((set) => ({
  entries: [],
  enabled: false,
  addEntry: (entry) =>
    set((state) => {
      if (!state.enabled) return state;
      return {
        entries: [...state.entries, { ...entry, id: ++logIdCounter }],
      };
    }),
  clear: () => set({ entries: [] }),
  setEnabled: (enabled) => set({ enabled }),
}));
