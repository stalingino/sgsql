import type { ConnectionProfile } from "../lib/types";
import { friendlyError } from "../lib/friendlyError";
import { createSshTunnel } from "../lib/sshTunnel";

export async function handleTestConnection(
  req: Request,
  headers: Record<string, string>,
): Promise<Response> {
  const profile: ConnectionProfile = await req.json();
  const start = performance.now();
  let tunnel = null as Awaited<ReturnType<typeof createSshTunnel>>;

  try {
    if (profile.type === "sqlite") {
      const file = Bun.file(profile.database);
      const exists = await file.exists();
      if (!exists) {
        return jsonResponse({ ok: false, error: `File not found: ${profile.database}` }, headers);
      }
      return jsonResponse({ ok: true, latency: elapsed(start) }, headers);
    }

    tunnel = await createSshTunnel(profile);
    const connectHost = tunnel?.host ?? profile.host;
    const connectPort = tunnel?.port ?? profile.port;

    if (profile.type === "mysql") {
      const mysql = await import("mysql2/promise");
      const conn = await mysql.createConnection({
        host: connectHost,
        port: connectPort,
        user: profile.username,
        password: profile.password,
        database: profile.database,
        ssl: profile.ssl ? {} : undefined,
        connectTimeout: 5000,
      });
      await conn.query("SELECT 1");
      await conn.end();
      await tunnel?.close();
      return jsonResponse({ ok: true, latency: elapsed(start) }, headers);
    }

    // PostgreSQL
    const postgres = (await import("postgres")).default;
    const sql = postgres({
      hostname: connectHost,
      port: connectPort,
      database: profile.database,
      username: profile.username,
      password: profile.password,
      ssl: profile.ssl ? "require" : false,
      connect_timeout: 5,
      max: 1,
    });
    await sql`SELECT 1`;
    await sql.end();
    await tunnel?.close();
    return jsonResponse({ ok: true, latency: elapsed(start) }, headers);
  } catch (e: unknown) {
    await tunnel?.close().catch(() => {});
    const baseMessage = friendlyError(e);
    const message = profile.useSsh && tunnel && !baseMessage.startsWith("SSH ")
      ? `SSH tunnel established, but the database at ${profile.host}:${profile.port} could not be reached. ${baseMessage}`
      : baseMessage;
    console.error(`[sidecar] connection test failed: ${message}`);
    return jsonResponse({ ok: false, error: message, latency: elapsed(start) }, headers);
  }
}

function elapsed(start: number): number {
  return Math.round(performance.now() - start);
}

function jsonResponse(data: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(data), { status: 200, headers });
}
