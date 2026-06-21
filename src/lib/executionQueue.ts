import { create } from "zustand";
import { executeQuery as rawExecuteQuery, cancelQuery, ensureConnection, type QueryResult } from "./schema";

/* ── Types ─────────────────────────────────────────────── */

interface QueueItem {
  sql: string;
  db: string;
  resolve: (result: QueryResult) => void;
  reject: (error: Error) => void;
}

interface ConnectionQueue {
  running: boolean;
  phase: "idle" | "checking" | "executing" | "cancelling";
  abortController: AbortController | null;
  queue: QueueItem[];
  lastCancelDetail: string | null;
}

interface ExecutionQueueState {
  connections: Map<string, ConnectionQueue>;
  /** Submit a query for serial execution. Returns when the query completes. */
  execute: (connectionId: string, sql: string, db: string) => Promise<QueryResult>;
  /** Cancel the currently running query and clear the queue. */
  cancel: (connectionId: string) => Promise<void>;
  /** Check if a query is currently running for this connection. */
  isRunning: (connectionId: string) => boolean;
}

/* ── Store ─────────────────────────────────────────────── */

export const useExecutionQueue = create<ExecutionQueueState>((set, get) => {
  function getQueue(connectionId: string): ConnectionQueue {
    const q = get().connections.get(connectionId);
    if (q) return q;
    const fresh: ConnectionQueue = { running: false, phase: "idle", abortController: null, queue: [], lastCancelDetail: null };
    get().connections.set(connectionId, fresh);
    return fresh;
  }

  function updateQueue(connectionId: string, updates: Partial<ConnectionQueue>) {
    set((state) => {
      const next = new Map(state.connections);
      const existing = next.get(connectionId) ?? { running: false, phase: "idle", abortController: null, queue: [], lastCancelDetail: null };
      next.set(connectionId, { ...existing, ...updates });
      return { connections: next };
    });
  }

  async function drainNext(connectionId: string) {
    const q = get().connections.get(connectionId);
    if (!q || q.queue.length === 0) {
      updateQueue(connectionId, { running: false, phase: "idle", abortController: null });
      return;
    }

    const [item, ...rest] = q.queue;
    const controller = new AbortController();
    updateQueue(connectionId, { queue: rest, abortController: controller, running: true, phase: "checking" });

    try {
      await ensureConnection(connectionId);
      updateQueue(connectionId, { phase: "executing" });
      const result = await rawExecuteQuery(connectionId, item.sql, item.db, controller.signal);
      item.resolve(result);
    } catch (err) {
      item.reject(err instanceof Error ? err : new Error(String(err)));
    }

    // Process next item in queue
    drainNext(connectionId);
  }

  return {
    connections: new Map(),

    execute(connectionId: string, sql: string, db: string): Promise<QueryResult> {
      return new Promise<QueryResult>((resolve, reject) => {
        const q = getQueue(connectionId);

        if (!q.running) {
          // Execute immediately
          const controller = new AbortController();
          updateQueue(connectionId, { running: true, phase: "checking", abortController: controller, queue: [] });

          ensureConnection(connectionId)
            .then(() => {
              updateQueue(connectionId, { phase: "executing" });
              return rawExecuteQuery(connectionId, sql, db, controller.signal);
            })
            .then((result) => {
              resolve(result);
              drainNext(connectionId);
            })
            .catch((err) => {
              reject(err instanceof Error ? err : new Error(String(err)));
              drainNext(connectionId);
            });
        } else {
          // Queue it
          updateQueue(connectionId, {
            queue: [...(get().connections.get(connectionId)?.queue ?? []), { sql, db, resolve, reject }],
          });
        }
      });
    },

    async cancel(connectionId: string) {
      const q = get().connections.get(connectionId);
      if (!q) return;
      updateQueue(connectionId, { phase: "cancelling" });

      // Kill the query on the server first and capture detail
      let detail: string | null = null;
      if (q.phase === "executing") {
        try {
          const res = await cancelQuery(connectionId);
          detail = res.detail ?? null;
        } catch { /* ignore */ }
      }

      // Store the detail before aborting so it's available in catch blocks
      if (detail) {
        updateQueue(connectionId, { lastCancelDetail: detail });
      }

      // Abort the frontend fetch
      q.abortController?.abort();

      // Reject all queued items
      for (const item of q.queue) {
        item.reject(new Error("Cancelled"));
      }

      updateQueue(connectionId, { running: false, phase: "idle", abortController: null, queue: [] });
    },

    isRunning(connectionId: string): boolean {
      return get().connections.get(connectionId)?.running ?? false;
    },
  };
});
