import Fuse, { type IFuseOptions } from "fuse.js";

export interface FuzzySearchResult<T> {
  item: T;
  refIndex: number;
  score: number;
}

const DEFAULT_OPTIONS = {
  includeScore: true,
  ignoreLocation: true,
  shouldSort: true,
  threshold: 0.4,
} as const;

/** Search and rank a collection using the application's shared Fuse defaults. */
export function fuzzySearchResults<T>(
  items: readonly T[],
  query: string,
  options: IFuseOptions<T> = {},
): FuzzySearchResult<T>[] {
  const search = query.trim();
  if (!search) return items.map((item, refIndex) => ({ item, refIndex, score: 0 }));

  const fuse = new Fuse(items, { ...DEFAULT_OPTIONS, ...options, includeScore: true });
  return fuse.search(search).map(({ item, refIndex, score }) => ({
    item,
    refIndex,
    score: score ?? 1,
  }));
}

export function fuzzySearch<T>(
  items: readonly T[],
  query: string,
  options: IFuseOptions<T> = {},
): T[] {
  return fuzzySearchResults(items, query, options).map(({ item }) => item);
}
