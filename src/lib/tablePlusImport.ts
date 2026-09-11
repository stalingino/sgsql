/**
 * Converts TablePlus `.tableplusconnection` exports into SGSql connection profiles.
 *
 * An export is an RNCryptor-encrypted (when password protected) JSON document:
 * an array of groups `{ Name, connections: [...], groups: [...] }` whose
 * connection dictionaries carry TablePlus keys (`ConnectionName`, `Driver`,
 * `DatabaseHost`, …). Membership is by nesting, not by ID. The reader also
 * accepts plists and the `GroupID` → group `ID` shape TablePlus uses on disk.
 */

import {
  createDefaultProfile,
  DB_TYPE_PORTS,
  DEFAULT_CONNECTION_FOLDER,
  type ConnectionEnv,
  type ConnectionProfile,
} from "./types";
import { isBinaryPlist, isXmlPlist, parsePlist } from "./plist";

export const TABLEPLUS_EXTENSION = ".tableplusconnection";

export interface TablePlusImportResult {
  profiles: ConnectionProfile[];
  folders: string[];
  /** Connection names whose TablePlus driver SGSql cannot open (Redis, Mongo, …). */
  skipped: string[];
}

type Dict = Record<string, unknown>;

const DRIVER_MAP: Record<string, ConnectionProfile["type"]> = {
  mysql: "mysql",
  mysql8: "mysql",
  mariadb: "mysql",
  postgresql: "postgres",
  postgres: "postgres",
  cockroachdb: "postgres",
  redshift: "postgres",
  sqlite: "sqlite",
};

const VALID_ENVS: ConnectionEnv[] = ["production", "staging", "testing", "development", "local"];

function isDict(value: unknown): value is Dict {
  return !!value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Uint8Array) && !(value instanceof Date);
}

function str(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return "";
}

function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^\s*\d+\s*$/.test(value)) return parseInt(value, 10);
  return null;
}

function bool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value === "1" || value.toLowerCase() === "true";
  return false;
}

/** Decodes the plaintext bytes of an export: plist (XML or binary) or JSON. */
export function decodeTablePlusDocument(bytes: Uint8Array): unknown {
  if (isBinaryPlist(bytes)) return parsePlist(bytes);
  const text = new TextDecoder().decode(bytes);
  if (isXmlPlist(text)) return parsePlist(bytes);
  return JSON.parse(text) as unknown;
}

export function isTablePlusConnection(value: unknown): value is Dict {
  return isDict(value) && ("Driver" in value || "DatabaseHost" in value || "ConnectionName" in value);
}

function isTablePlusGroup(value: unknown): value is Dict {
  if (!isDict(value) || isTablePlusConnection(value)) return false;
  const group: Dict = value;
  if (typeof group.Name !== "string") return false;
  return typeof group.ID === "string"
    || Array.isArray(group.connections)
    || Array.isArray(group.groups)
    || Array.isArray(group.items);
}

/** True when a decoded document contains at least one TablePlus connection entry. */
export function isTablePlusDocument(parsed: unknown): boolean {
  return collect(parsed).connections.length > 0;
}

interface CollectedConnection {
  entry: Dict;
  /** Name of the innermost group the entry was nested under, if any. */
  folder: string;
}

function collect(root: unknown): { connections: CollectedConnection[]; groups: Map<string, string> } {
  const connections: CollectedConnection[] = [];
  const groups = new Map<string, string>();
  const walk = (value: unknown, depth: number, folder: string) => {
    if (depth > 8) return;
    if (Array.isArray(value)) {
      value.forEach((item) => walk(item, depth + 1, folder));
    } else if (isTablePlusConnection(value)) {
      connections.push({ entry: value, folder });
    } else if (isTablePlusGroup(value)) {
      const name = str(value.Name).trim() || folder;
      if (typeof value.ID === "string") groups.set(value.ID, name);
      walk(value.connections, depth + 1, name);
      walk(value.groups, depth + 1, name);
      walk(value.items, depth + 1, name);
    } else if (isDict(value)) {
      Object.values(value).forEach((item) => walk(item, depth + 1, folder));
    }
  };
  walk(root, 0, "");
  return { connections, groups };
}

export function convertTablePlusConnection(entry: Dict, groups: Map<string, string>, folder = ""): ConnectionProfile | null {
  const type = DRIVER_MAP[str(entry.Driver).trim().toLowerCase()];
  if (!type) return null;

  const profile = createDefaultProfile();
  profile.type = type;
  profile.name = str(entry.ConnectionName).trim();
  profile.host = str(entry.DatabaseHost).trim() || (type === "sqlite" ? "" : profile.host);
  profile.port = num(entry.DatabasePort) ?? DB_TYPE_PORTS[type];
  profile.database = type === "sqlite"
    ? str(entry.DatabasePath).trim() || str(entry.DatabaseName).trim()
    : str(entry.DatabaseName).trim();
  profile.username = str(entry.DatabaseUser);
  profile.password = str(entry.DatabasePassword);
  profile.ssl = num(entry.tLSMode) !== null ? num(entry.tLSMode) !== 0 : bool(entry.tLSMode);

  const env = str(entry.Enviroment ?? entry.Environment).trim().toLowerCase();
  profile.env = VALID_ENVS.includes(env as ConnectionEnv) ? (env as ConnectionEnv) : "";
  profile.group = groups.get(str(entry.GroupID)) || folder || DEFAULT_CONNECTION_FOLDER;

  profile.useSsh = type !== "sqlite" && bool(entry.isOverSSH);
  if (profile.useSsh) {
    profile.sshHost = str(entry.ServerAddress).trim() || profile.sshHost;
    profile.sshPort = num(entry.ServerPort) ?? 22;
    profile.sshUsername = str(entry.ServerUser);
    profile.sshPassword = str(entry.ServerPassword);
    profile.sshUsePrivateKey = bool(entry.isUsePrivateKey);
    profile.sshPrivateKey = profile.sshUsePrivateKey ? str(entry.ServerPrivateKeyData) : "";
    profile.sshAuthMode = profile.sshPassword ? "keychain" : profile.sshUsePrivateKey ? "none" : "ask";
  }

  if (!profile.name) profile.name = profile.database || profile.host || "TablePlus connection";
  return profile;
}

export function parseTablePlusDocument(parsed: unknown): TablePlusImportResult {
  const { connections, groups } = collect(parsed);
  if (connections.length === 0) throw new Error("This file does not contain any TablePlus connections");

  const profiles: ConnectionProfile[] = [];
  const skipped: string[] = [];
  const folders = new Set<string>();
  for (const { entry, folder } of connections) {
    const profile = convertTablePlusConnection(entry, groups, folder);
    if (!profile) {
      skipped.push(str(entry.ConnectionName).trim() || str(entry.Driver).trim() || "unnamed");
      continue;
    }
    profiles.push(profile);
    if (profile.group !== DEFAULT_CONNECTION_FOLDER) folders.add(profile.group);
  }
  return { profiles, folders: [...folders], skipped };
}

export function parseTablePlusExport(plaintext: Uint8Array): TablePlusImportResult {
  return parseTablePlusDocument(decodeTablePlusDocument(plaintext));
}
