export const COLLAPSED_CONNECTION_FOLDERS_KEY = "sgsql.connection-manager.collapsed-folders.v1";

export function decodeCollapsedConnectionFolders(value: string | null): Set<string> {
  if (!value) return new Set();
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((folder): folder is string => typeof folder === "string" && folder.length > 0));
  } catch {
    return new Set();
  }
}

export function encodeCollapsedConnectionFolders(folders: Set<string>): string {
  return JSON.stringify([...folders]);
}
