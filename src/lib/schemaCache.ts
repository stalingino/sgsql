export type SchemaCache<T> = Map<string, Map<string, T[]>>;

interface CacheEntry<T> {
  revision: number;
  cache: SchemaCache<T>;
}

/** Keeps schema results isolated and reusable when connection tabs are switched. */
export class ConnectionSchemaCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  forConnection(connectionId: string, revision: number): SchemaCache<T> {
    const current = this.entries.get(connectionId);
    if (current?.revision === revision) return current.cache;

    const cache: SchemaCache<T> = new Map();
    this.entries.set(connectionId, { revision, cache });
    return cache;
  }
}
