import type { ConnectionProfile } from "../lib/types";

export async function handleTestConnection(
  req: Request,
  headers: Record<string, string>,
): Promise<Response> {
  const profile: ConnectionProfile = await req.json();
  const start = performance.now();

  try {
    if (profile.type === "sqlite") {
      const file = Bun.file(profile.database);
      const exists = await file.exists();
      if (!exists) {
        return jsonResponse({ ok: false, error: `File not found: ${profile.database}` }, headers);
      }
      return jsonResponse({ ok: true, latency: elapsed(start) }, headers);
    }

    if (profile.type === "mysql") {
      const mysql = await import("mysql2/promise");
      const conn = await mysql.createConnection({
        host: profile.host,
        port: profile.port,
        user: profile.username,
        password: profile.password,
        database: profile.database,
        ssl: profile.ssl ? {} : undefined,
        connectTimeout: 5000,
      });
      await conn.query("SELECT 1");
      await conn.end();
      return jsonResponse({ ok: true, latency: elapsed(start) }, headers);
    }

    // PostgreSQL
    const postgres = (await import("postgres")).default;
    const sql = postgres({
      hostname: profile.host,
      port: profile.port,
      database: profile.database,
      username: profile.username,
      password: profile.password,
      ssl: profile.ssl ? "require" : false,
      connect_timeout: 5,
      max: 1,
    });
    await sql`SELECT 1`;
    await sql.end();
    return jsonResponse({ ok: true, latency: elapsed(start) }, headers);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
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
