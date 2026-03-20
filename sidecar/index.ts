import { handleHealth } from "./routes/health";
import { handleTestConnection } from "./routes/connections";
import {
  handleOpenConnection,
  handleCloseConnection,
  handleSchemaRequest,
} from "./routes/schema";

const DEFAULT_PORT = 7521;

function getPort(): number {
  const arg = process.argv.find((a) => a.startsWith("--port="));
  if (arg) return parseInt(arg.split("=")[1], 10);
  return DEFAULT_PORT;
}

async function findAvailablePort(start: number): Promise<number> {
  for (let port = start; port < start + 10; port++) {
    try {
      const server = Bun.serve({
        port,
        fetch() {
          return new Response("probe");
        },
      });
      server.stop();
      return port;
    } catch {
      // port in use, try next
    }
  }
  throw new Error(`No available port found in range ${start}-${start + 9}`);
}

async function main() {
  const requestedPort = getPort();
  const port = await findAvailablePort(requestedPort);

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      console.log(`[sidecar] ${req.method} ${path}`);

      // CORS headers for Tauri webview
      const headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Content-Type": "application/json",
      };

      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers });
      }

      try {
        if (path === "/health") {
          console.log("[sidecar] health check");
          return handleHealth(headers);
        }

        if (path === "/connections/test" && req.method === "POST") {
          console.log("[sidecar] testing connection");
          return handleTestConnection(req, headers);
        }

        if (path === "/connections/open" && req.method === "POST") {
          console.log("[sidecar] opening connection");
          return handleOpenConnection(req, headers);
        }

        if (path === "/connections/close" && req.method === "POST") {
          console.log("[sidecar] closing connection");
          return handleCloseConnection(req, headers);
        }

        if (path.startsWith("/schema/") && req.method === "GET") {
          console.log(`[sidecar] schema request: ${path}`);
          return handleSchemaRequest(req, path, headers);
        }

        console.log(`[sidecar] route not found: ${req.method} ${path}`);
        return new Response(
          JSON.stringify({ error: "not found" }),
          { status: 404, headers },
        );
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : "unknown error";
        return new Response(
          JSON.stringify({ error: message }),
          { status: 500, headers },
        );
      }
    },
  });

  console.log(`sgsql-sidecar listening on port ${server.port}`);
}

main();
