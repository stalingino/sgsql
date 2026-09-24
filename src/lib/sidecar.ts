import { invoke } from "@tauri-apps/api/core";

interface SidecarCredentials {
  port: number;
  token: string;
}

export interface SidecarConnection extends SidecarCredentials {
  baseUrl: string;
  webSocketUrl: string;
}

let connectionPromise: Promise<SidecarConnection> | null = null;

export function getSidecarConnection(): Promise<SidecarConnection> {
  if (!connectionPromise) {
    connectionPromise = invoke<SidecarCredentials>("sidecar_credentials").then(({ port, token }) => ({
      port,
      token,
      baseUrl: `http://127.0.0.1:${port}`,
      webSocketUrl: `ws://127.0.0.1:${port}`,
    }));
  }
  return connectionPromise;
}

export const CONNECTION_RESTORED_EVENT = "sgsql:connection-restored";

interface ConnectionStatusPayload {
  _connection?: { connectionId: string; reconnected: true };
}

function publishConnectionStatus(data: ConnectionStatusPayload | null | undefined) {
  if (data?._connection?.reconnected) {
    window.dispatchEvent(new CustomEvent(CONNECTION_RESTORED_EVENT, { detail: data._connection }));
  }
}

export class SidecarHttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "SidecarHttpError";
    this.status = status;
  }
}

export async function sidecarFetch<T = unknown>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const connection = await getSidecarConnection();
  const url = `${connection.baseUrl}${path}`;
  const headers = new Headers(options?.headers);
  headers.set("Authorization", `Bearer ${connection.token}`);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  console.log(`[sidecar] ${options?.method || "GET"} ${url}`);
  const res = await fetch(url, {
    ...options,
    headers,
  });
  console.log(`[sidecar] response: ${res.status} ${res.statusText}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new SidecarHttpError(body.error || `HTTP ${res.status}`, res.status);
  }
  const data = await res.json() as T & ConnectionStatusPayload;
  if (data && typeof data === "object") publishConnectionStatus(data);
  return data;
}

export async function sidecarFetchNdjson<T>(
  path: string,
  options: RequestInit,
  onMessage: (message: T) => void,
): Promise<void> {
  const connection = await getSidecarConnection();
  const url = `${connection.baseUrl}${path}`;
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${connection.token}`);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(url, { ...options, headers });
  if (!response.ok) {
    const text = await response.text();
    let message = response.statusText || `HTTP ${response.status}`;
    try { message = (JSON.parse(text) as { error?: string }).error || message; } catch { /* plain-text rejection */ }
    throw new SidecarHttpError(message, response.status);
  }
  if (!response.body) throw new Error("The import response did not include a progress stream");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  const consume = (line: string) => {
    if (!line.trim()) return;
    const message = JSON.parse(line) as T;
    if (message && typeof message === "object") publishConnectionStatus(message as ConnectionStatusPayload);
    onMessage(message);
  };

  while (true) {
    const { done, value } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) consume(line);
    if (done) break;
  }
  consume(pending);
}

export async function waitForSidecar(
  maxAttempts = 20,
  delayMs = 500,
): Promise<boolean> {
  let connection: SidecarConnection;
  try {
    connection = await getSidecarConnection();
  } catch {
    return false;
  }

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    try {
      const response = await fetch(`${connection.baseUrl}/health`, {
        headers: { Authorization: `Bearer ${connection.token}` },
      });
      if (response.ok) return true;
    } catch {
      // not ready yet
    }
  }
  return false;
}
