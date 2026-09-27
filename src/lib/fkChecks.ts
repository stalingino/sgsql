import { create } from "zustand";

/**
 * Connections whose foreign-key checks the user switched off. Session-only on
 * purpose: reopening the app always starts with checks enforced.
 */
interface FkChecksState {
  disabled: Set<string>;
  setDisabled: (connectionId: string, disabled: boolean) => void;
}

export const useFkChecks = create<FkChecksState>((set) => ({
  disabled: new Set(),
  setDisabled(connectionId, disabled) {
    set((state) => {
      if (state.disabled.has(connectionId) === disabled) return state;
      const next = new Set(state.disabled);
      if (disabled) next.add(connectionId);
      else next.delete(connectionId);
      return { disabled: next };
    });
  },
}));

export function fkChecksDisabled(connectionId: string): boolean {
  return useFkChecks.getState().disabled.has(connectionId);
}
