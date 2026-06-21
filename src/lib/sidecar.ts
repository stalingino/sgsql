const SIDECAR_PORT = 45821;
const BASE_URL = `http://localhost:${SIDECAR_PORT}`;

export const CONNECTION_RESTORED_EVENT = "sgsql:connection-restored";

interface ConnectionStatusPayload {
  _connection?: { connectionId: string; reconnected: true };
}

export class SidecarHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "SidecarHttpError";
  }
}

export async function sidecarFetch<T = unknown>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const url = `${BASE_URL}${path}`;
  console.log(`[sidecar] ${options?.method || "GET"} ${url}`);
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  console.log(`[sidecar] response: ${res.status} ${res.statusText}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new SidecarHttpError(body.error || `HTTP ${res.status}`, res.status);
  }
  const data = await res.json() as T & ConnectionStatusPayload;
  if (data && typeof data === "object" && data._connection?.reconnected) {
    window.dispatchEvent(new CustomEvent(CONNECTION_RESTORED_EVENT, { detail: data._connection }));
  }
  return data;
}

export async function waitForSidecar(
  maxAttempts = 20,
  delayMs = 500,
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    try {
      await fetch(`${BASE_URL}/health`);
      return true;
    } catch {
      // not ready yet
    }
  }
  return false;
}
