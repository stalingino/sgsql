import { fetchCatalog, fetchDatabases, type CatalogInfo } from "./schema";

interface CacheEntry<T> {
  revision: number;
  value: Promise<T>;
  resolved?: T;
}

export class RevisionPromiseCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  get(key: string, revision: number, load: () => Promise<T>): Promise<T> {
    const existing = this.entries.get(key);
    if (existing?.revision === revision) return existing.value;

    const entry: CacheEntry<T> = { revision, value: Promise.resolve(undefined as T) };
    entry.value = load()
      .then((result) => {
        entry.resolved = result;
        return result;
      })
      .catch((error) => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        throw error;
      });
    this.entries.set(key, entry);
    return entry.value;
  }

  peek(key: string, revision: number): T | undefined {
    const existing = this.entries.get(key);
    return existing?.revision === revision ? existing.resolved : undefined;
  }
}

const catalogs = new RevisionPromiseCache<CatalogInfo>();
const databases = new RevisionPromiseCache<string[]>();

export function getCachedCatalog(connectionId: string, db: string, revision: number): Promise<CatalogInfo> {
  const key = `${connectionId}\u0000${db}`;
  return catalogs.get(key, revision, () => fetchCatalog(connectionId, db));
}

export function peekCachedCatalog(connectionId: string, db: string, revision: number): CatalogInfo | undefined {
  return catalogs.peek(`${connectionId}\u0000${db}`, revision);
}

export function getCachedDatabases(connectionId: string, revision: number): Promise<string[]> {
  return databases.get(connectionId, revision, () => fetchDatabases(connectionId));
}

export function peekCachedDatabases(connectionId: string, revision: number): string[] | undefined {
  return databases.peek(connectionId, revision);
}

export function comparePaletteNames(a: string, b: string, query: string): number {
  const search = query.trim().toLocaleLowerCase();
  if (!search) return 0;
  const left = a.toLocaleLowerCase();
  const right = b.toLocaleLowerCase();

  const leftPrefix = left.startsWith(search);
  const rightPrefix = right.startsWith(search);
  if (leftPrefix !== rightPrefix) return leftPrefix ? -1 : 1;

  const leftFirstLetter = left.startsWith(search[0]);
  const rightFirstLetter = right.startsWith(search[0]);
  if (leftFirstLetter !== rightFirstLetter) return leftFirstLetter ? -1 : 1;

  if (left.length !== right.length) return left.length - right.length;
  return left.localeCompare(right);
}
