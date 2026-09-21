import { sidecarFetch } from "./sidecar";

/* ── Agent shares (MCP) ──────────────────────────────────── */

export interface ShareTable {
  schema: string;
  name: string;
  type: "table" | "view";
}

export interface ShareStats {
  calls: number;
  rejected: number;
  errors: number;
  lastUsedAt: string | null;
}

export interface ShareInfo {
  id: string;
  connectionId: string;
  connectionName: string;
  db: string;
  url: string;
  /** Only present in the create response; never persisted. */
  token?: string;
  fullDatabase: boolean;
  allDatabases: boolean;
  readOnly: boolean;
  maxRows: number;
  timeoutMs: number;
  tables: ShareTable[];
  createdAt: string;
  stats: ShareStats;
}

export interface CreateShareRequest {
  connectionId: string;
  db?: string;
  fullDatabase: boolean;
  allDatabases: boolean;
  tables: ShareTable[];
  readOnly: boolean;
  maxRows: number;
  timeoutMs: number;
}

export async function createShare(request: CreateShareRequest): Promise<ShareInfo> {
  const result = await sidecarFetch<{ share: ShareInfo }>("/shares", {
    method: "POST",
    body: JSON.stringify(request),
  });
  return result.share;
}

export async function getShare(id: string): Promise<ShareInfo> {
  const result = await sidecarFetch<{ share: ShareInfo }>(`/shares/${encodeURIComponent(id)}`);
  return result.share;
}

export async function listShares(connectionId?: string): Promise<ShareInfo[]> {
  const query = connectionId ? `?connectionId=${encodeURIComponent(connectionId)}` : "";
  const result = await sidecarFetch<{ shares: ShareInfo[] }>(`/shares${query}`);
  return result.shares;
}

export async function stopShare(id: string): Promise<void> {
  await sidecarFetch<{ ok: boolean }>(`/shares/${encodeURIComponent(id)}`, { method: "DELETE" });
}
