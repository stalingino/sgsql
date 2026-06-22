import type { ConnectionProfile, ConnectionEnv } from "./types";
import { DB_TYPE_PORTS } from "./types";

const PROTOCOL_MAP: Record<string, ConnectionProfile["type"]> = {
  postgres: "postgres",
  postgresql: "postgres",
  mysql: "mysql",
  sqlite: "sqlite",
  sqlite3: "sqlite",
};

function decode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

function encode(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Returns true if the string looks like a connection URL we can parse.
 */
export function isConnectionUrl(value: string): boolean {
  return /^(postgres(?:ql)?|mysql|sqlite3?)(?:\+ssh)?:\/{2}/i.test(value.trim());
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

  const rawProtocol = parsed.protocol.replace(":", "").toLowerCase();
  const useSsh = rawProtocol.endsWith("+ssh");
  const protocol = rawProtocol.replace(/\+ssh$/, "");
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

  if (useSsh) {
    const route = parsed.pathname.replace(/^\//, "");
    const match = route.match(/^([^:]*):([^@]*)@([^/]+)\/(.*)$/);
    if (!match) return {};
    const dbAuthority = match[3];
    const lastColon = dbAuthority.lastIndexOf(":");
    const hasPort = lastColon > -1 && /^\d+$/.test(dbAuthority.slice(lastColon + 1));
    const host = decode(hasPort ? dbAuthority.slice(0, lastColon) : dbAuthority) || existing.host;
    const port = hasPort ? parseInt(dbAuthority.slice(lastColon + 1), 10) : DB_TYPE_PORTS[type];
    const sshPassword = parsed.password ? decode(parsed.password) : existing.sshPassword;
    const rawSshAuthMode = params.get("sshAuthMode");
    const sshAuthMode: ConnectionProfile["sshAuthMode"] = sshPassword
      ? "keychain"
      : rawSshAuthMode === "ask" || rawSshAuthMode === "none" ? rawSshAuthMode : "none";
    return {
      type, host, port,
      username: decode(match[1]),
      password: decode(match[2]),
      database: decode(match[4]),
      ssl, color, name, env,
      useSsh: true,
      sshHost: parsed.hostname || existing.sshHost,
      sshPort: parsed.port ? parseInt(parsed.port, 10) : 22,
      sshUsername: parsed.username ? decode(parsed.username) : existing.sshUsername,
      sshPassword,
      sshAuthMode,
      sshUsePrivateKey: params.get("usePrivateKey") === "true",
      sshPrivateKey: params.get("privateKey") ?? existing.sshPrivateKey,
    };
  }

  const host = parsed.hostname || existing.host;
  const port = parsed.port ? parseInt(parsed.port, 10) : DB_TYPE_PORTS[type];
  const username = parsed.username ? decode(parsed.username) : existing.username;
  const password = parsed.password ? decode(parsed.password) : existing.password;
  const database = decode(parsed.pathname.replace(/^\//, "")) || existing.database;

  return { type, host, port, username, password, database, ssl, color, name, env, useSsh: false };
}

export function formatConnectionUrl(profile: ConnectionProfile): string {
  const params = new URLSearchParams();
  params.set("statusColor", profile.color.replace(/^#/, ""));
  if (profile.env) params.set("env", profile.env);
  if (profile.name) params.set("name", profile.name);
  params.set("tLSMode", profile.ssl ? "1" : "0");

  const defaultPort = DB_TYPE_PORTS[profile.type];
  const dbPort = profile.port && profile.port !== defaultPort ? `:${profile.port}` : "";
  const database = encode(profile.database);
  if (profile.useSsh && profile.type !== "sqlite") {
    params.set("usePrivateKey", String(profile.sshUsePrivateKey));
    params.set("sshAuthMode", profile.sshAuthMode);
    const sshPassword = profile.sshAuthMode === "none" ? "" : profile.sshPassword;
    return `${profile.type}+ssh://${encode(profile.sshUsername)}:${encode(sshPassword)}@${profile.sshHost}:${profile.sshPort}/${encode(profile.username)}:${encode(profile.password)}@${profile.host}${dbPort}/${database}?${params}`;
  }

  if (profile.type === "sqlite") {
    return `sqlite:///${database}?${params}`;
  }
  return `${profile.type}://${encode(profile.username)}:${encode(profile.password)}@${profile.host}${dbPort}/${database}?${params}`;
}
