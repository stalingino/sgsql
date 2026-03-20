import type { ConnectionProfile, ConnectionEnv } from "./types";
import { DB_TYPE_PORTS } from "./types";

const PROTOCOL_MAP: Record<string, ConnectionProfile["type"]> = {
  postgres: "postgres",
  postgresql: "postgres",
  mysql: "mysql",
  sqlite: "sqlite",
  sqlite3: "sqlite",
};

/**
 * Returns true if the string looks like a connection URL we can parse.
 */
export function isConnectionUrl(value: string): boolean {
  return /^(postgres(?:ql)?|mysql|sqlite3?):\/{2}/i.test(value.trim());
}

/**
 * Parses a connection URL into a partial ConnectionProfile.
 * Example:
 *   mysql://user:pwd@hostname/dbname?statusColor=252525&env=testing&name=My+DB&tLSMode=1
 */
export function parseConnectionUrl(
  url: string,
  existing: ConnectionProfile,
): Partial<ConnectionProfile> {
  const trimmed = url.trim();

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {};
  }

  const protocol = parsed.protocol.replace(":", "").toLowerCase();
  const type = PROTOCOL_MAP[protocol];
  if (!type) return {};

  const params = parsed.searchParams;

  // statusColor → prepend # if missing
  let color = existing.color;
  const rawColor = params.get("statusColor");
  if (rawColor) {
    color = rawColor.startsWith("#") ? rawColor : `#${rawColor}`;
  }

  // tLSMode → ssl
  const tlsMode = params.get("tLSMode");
  const ssl = tlsMode !== null ? tlsMode !== "0" : existing.ssl;

  // name from query param takes priority over URL path
  const name = params.get("name") ?? existing.name;

  // env
  const VALID_ENVS: ConnectionEnv[] = ["production", "staging", "testing", "development", "local", ""];
  const rawEnv = params.get("env") ?? existing.env ?? "";
  const env: ConnectionEnv = VALID_ENVS.includes(rawEnv as ConnectionEnv)
    ? (rawEnv as ConnectionEnv)
    : "";

  const host = parsed.hostname || existing.host;
  const portStr = parsed.port;
  const port = portStr ? parseInt(portStr, 10) : DB_TYPE_PORTS[type];

  const username = parsed.username
    ? decodeURIComponent(parsed.username)
    : existing.username;
  const password = parsed.password
    ? decodeURIComponent(parsed.password)
    : existing.password;

  // Database: strip leading slash
  const database = parsed.pathname.replace(/^\//, "") || existing.database;

  return { type, host, port, username, password, database, ssl, color, name, env };
}
