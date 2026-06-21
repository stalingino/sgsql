import { create } from "zustand";

interface SchemaRevisionState {
  revisions: Record<string, number>;
  bump: (connectionId: string) => void;
}

const useSchemaRevisionStore = create<SchemaRevisionState>((set) => ({
  revisions: {},
  bump: (connectionId) => set((state) => ({
    revisions: { ...state.revisions, [connectionId]: (state.revisions[connectionId] ?? 0) + 1 },
  })),
}));

export function notifySchemaChanged(connectionId: string) {
  useSchemaRevisionStore.getState().bump(connectionId);
}

export function useSchemaRevision(connectionId: string): number {
  return useSchemaRevisionStore((state) => state.revisions[connectionId] ?? 0);
}
