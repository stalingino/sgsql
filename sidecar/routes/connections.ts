import type { ConnectionProfile } from "../lib/types";

export async function handleTestConnection(
  req: Request,
  headers: Record<string, string>,
): Promise<Response> {
  const profile: ConnectionProfile = await req.json();
  const start = performance.now();

  try {
    if (profile.type === "sqlite") {
      // For SQLite, check if the file exists or can be created
      const file = Bun.file(profile.database);
      const exists = await file.exists();
      if (!exists) {
        return new Response(
          JSON.stringify({ ok: false, error: `File not found: ${profile.database}` }),
          { status: 200, headers },
        );
      }
      const latency = Math.round(performance.now() - start);
      return new Response(
        JSON.stringify({ ok: true, latency }),
        { status: 200, headers },
      );
    }

    // PostgreSQL / MySQL — use Bun's SQL
    const { SQL } = await import("bun");
    const sql = new SQL({
      hostname: profile.host,
      port: profile.port,
      database: profile.database,
      username: profile.username,
      password: profile.password,
    });

    await sql`SELECT 1`;
    await sql.close();

    const latency = Math.round(performance.now() - start);
    return new Response(
      JSON.stringify({ ok: true, latency }),
      { status: 200, headers },
    );
  } catch (e: unknown) {
    const latency = Math.round(performance.now() - start);
    const message = e instanceof Error ? e.message : "Unknown error";
    return new Response(
      JSON.stringify({ ok: false, error: message, latency }),
      { status: 200, headers },
    );
  }
}
