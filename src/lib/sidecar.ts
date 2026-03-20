const SIDECAR_PORT = 7521;
const BASE_URL = `http://localhost:${SIDECAR_PORT}`;

export async function sidecarFetch<T = unknown>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
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
