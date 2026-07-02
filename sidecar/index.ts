import { handleHealth } from "./routes/health";
import { handleTestConnection } from "./routes/connections";
import {
  handleOpenConnection,
  handleCloseConnection,
  handleEnsureConnection,
  handleReloadConnection,
  handleSchemaRequest,
  handleSchemaApply,
  handleQuery,
  handleCancel,
} from "./routes/schema";
import { clearQueryLog, subscribeQueryLog, unsubscribeQueryLog, type QueryLogSocketData } from "./lib/queryLogHub";

const DEFAULT_PORT = 45821; // distinctive high port — avoids collisions

function getPort(): number {
  const arg = process.argv.find((a) => a.startsWith("--port="));
  if (arg) return parseInt(arg.split("=")[1], 10);
  return DEFAULT_PORT;
}

async function main() {
  const port = getPort();

  const server = Bun.serve({
    port,
    reusePort: true, // allow quick restart without TIME_WAIT issues
    async fetch(req, server) {
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

      if (path === "/query-log") {
        if (server.upgrade(req, { data: { channel: "query-log" } satisfies QueryLogSocketData })) return;
        return new Response(JSON.stringify({ error: "WebSocket upgrade required" }), { status: 426, headers });
      }

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

        if (path === "/connections/ensure" && req.method === "POST") {
          console.log("[sidecar] checking connection");
          return handleEnsureConnection(req, headers);
        }

        if (path === "/connections/reload" && req.method === "POST") {
          console.log("[sidecar] reloading connection");
          return handleReloadConnection(req, headers);
        }

        if (path === "/query" && req.method === "POST") {
          console.log("[sidecar] executing query");
          return handleQuery(req, headers);
        }

        if (path === "/cancel" && req.method === "POST") {
          console.log("[sidecar] cancelling query");
          return handleCancel(req, headers);
        }

        if (path.startsWith("/schema/") && req.method === "GET") {
          console.log(`[sidecar] schema request: ${path}`);
          return handleSchemaRequest(req, path, headers);
        }

        if (path.startsWith("/schema/") && path.endsWith("/apply") && req.method === "POST") {
          console.log(`[sidecar] schema apply: ${path}`);
          return handleSchemaApply(req, path, headers);
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
    websocket: {
      open: subscribeQueryLog,
      message(_socket, message) {
        if (String(message) === "clear") clearQueryLog();
      },
      close: unsubscribeQueryLog,
    },
  });

  console.log(`sgsql-sidecar listening on port ${server.port}`);
}

main();
