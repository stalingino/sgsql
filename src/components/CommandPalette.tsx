import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Database, Table2, Eye, Loader2, Search } from "lucide-react";
import { getSearchLru, touchSearchLru } from "../lib/searchLru";
import { fuzzySearchResults, matchSegments } from "../lib/fuzzySearch";
import {
  getCachedCatalog,
  getCachedDatabases,
  peekCachedCatalog,
  peekCachedDatabases,
} from "../lib/commandPaletteCache";
import { useSchemaRevision } from "../lib/schemaRevision";
import type { CatalogInfo } from "../lib/schema";

/* ── Types ─────────────────────────────────────────────── */

interface PaletteItem {
  kind: "db" | "table" | "view";
  db: string;
  schema: string;
  name: string;
  score: number;
}

interface CommandPaletteProps {
  connectionId: string;
  connectionType: "postgres" | "mysql" | "sqlite";
  connectionDatabase: string;
  currentDatabase: string | null;
  cacheKey?: string;
  mode?: "all" | "db-only";
  onSelectDb: (db: string) => void;
  onSelectTable: (db: string, schema: string, table: string, type: "table" | "view") => void;
  onClose: () => void;
}

function defaultSchema(type: "postgres" | "mysql" | "sqlite"): string {
  if (type === "postgres") return "public";
  if (type === "sqlite") return "main";
  return "";
}

// MySQL system schemas clutter search results with internal tables (grants,
// variables, etc). Hide them unless the user is currently browsing that db.
const MYSQL_SYSTEM_SCHEMAS = new Set(["information_schema", "mysql", "performance_schema", "sys"]);

function highlightName(name: string, indices: readonly number[]): React.ReactNode {
  if (indices.length === 0) return name;
  return matchSegments(name, indices).map((segment, i) =>
    segment.matched ? (
      <mark key={i} className="bg-accent/25 text-inherit rounded-[2px]">{segment.text}</mark>
    ) : (
      <span key={i}>{segment.text}</span>
    ),
  );
}

function paletteItems(
  catalog: CatalogInfo,
  connectionType: "postgres" | "mysql" | "sqlite",
  preferredDb: string,
): PaletteItem[] {
  const isHiddenMysqlSystemSchema = (db: string) =>
    connectionType === "mysql" && MYSQL_SYSTEM_SCHEMAS.has(db) && db !== preferredDb;

  const items: PaletteItem[] = catalog.databases
    .filter((db) => !isHiddenMysqlSystemSchema(db))
    .map((db) => ({ kind: "db", db, schema: "", name: db, score: 0 }));
  const orderedTables = [...catalog.tables]
    .filter((table) => !isHiddenMysqlSystemSchema(table.db))
    .sort((a, b) => {
      if ((a.db === preferredDb) !== (b.db === preferredDb)) return a.db === preferredDb ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  for (const table of orderedTables) {
    items.push({
      kind: table.type === "view" ? "view" : "table",
      db: table.db,
      schema: table.schema || defaultSchema(connectionType),
      name: table.name,
      score: 0,
    });
  }
  return items;
}

/* ── Component ─────────────────────────────────────────── */

export function CommandPalette({
  connectionId,
  connectionType,
  connectionDatabase,
  currentDatabase,
  cacheKey,
  mode = "all",
  onSelectDb,
  onSelectTable,
  onClose,
}: CommandPaletteProps) {
  const schemaRevision = useSchemaRevision(connectionId);
  const preferredDb = currentDatabase || connectionDatabase;
  const initialCatalog = mode === "db-only"
    ? (() => {
        const databases = peekCachedDatabases(connectionId, schemaRevision);
        return databases ? { databases, tables: [] } satisfies CatalogInfo : undefined;
      })()
    : peekCachedCatalog(connectionId, connectionDatabase, schemaRevision);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<PaletteItem[]>(() => initialCatalog ? paletteItems(initialCatalog, connectionType, preferredDb) : []);
  const [loading, setLoading] = useState(!initialCatalog);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const lruScope = cacheKey || connectionId;
  const [recentItems, setRecentItems] = useState(() => getSearchLru(lruScope));
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // The sidecar returns the whole searchable catalog in one request. Keep the
  // promise cached across palette mounts and invalidate it with schema changes.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!initialCatalog) setLoading(true);
      try {
        const catalog = mode === "db-only"
          ? { databases: await getCachedDatabases(connectionId, schemaRevision), tables: [] }
          : await getCachedCatalog(connectionId, connectionDatabase, schemaRevision);
        const allItems = paletteItems(catalog, connectionType, preferredDb);

        if (!cancelled) {
          setItems(allItems);
          setLoading(false);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [connectionId, connectionType, connectionDatabase, currentDatabase, mode, schemaRevision]);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const itemKey = useCallback(
    (item: PaletteItem) => `${item.kind}\u0000${item.db}\u0000${item.schema}\u0000${item.name}`,
    [],
  );

  // While searching, prefer name prefixes and shorter names before fuzzy
  // relevance. With an empty query, recently opened objects stay first.
  const sortedFiltered = useMemo(() => {
    const search = query.trim();
    const recency = new Map(recentItems.map((key, index) => [key, index]));
    const searchable = items.map((item) => ({
      item,
      name: item.name,
      qualifiedName: item.kind === "db" ? item.name : `${item.db}.${item.schema}.${item.name}`,
      db: item.db,
      schema: item.schema,
    }));

    return fuzzySearchResults(searchable, search, {
      keys: [{ name: "name", weight: 2 }, "qualifiedName", "db", "schema"],
    })
      .sort((a, b) => {
        if (search && a.score !== b.score) return a.score - b.score;

        const aIsCurrentTable = a.item.item.kind !== "db" && a.item.item.db === currentDatabase;
        const bIsCurrentTable = b.item.item.kind !== "db" && b.item.item.db === currentDatabase;
        if (aIsCurrentTable !== bIsCurrentTable) return aIsCurrentTable ? -1 : 1;

        const aRecent = recency.get(itemKey(a.item.item)) ?? Number.MAX_SAFE_INTEGER;
        const bRecent = recency.get(itemKey(b.item.item)) ?? Number.MAX_SAFE_INTEGER;
        if (aRecent !== bRecent) return aRecent - bRecent;

        if (a.item.item.kind === "db" && b.item.item.kind !== "db") return 1;
        if (a.item.item.kind !== "db" && b.item.item.kind === "db") return -1;
        return a.refIndex - b.refIndex;
      })
      .map((result) => ({ ...result.item.item, indices: result.indices }));
  }, [currentDatabase, items, itemKey, query, recentItems]);

  // Reset selection when query changes
  useEffect(() => {
    setSelectedIdx(0);
  }, [query]);

  // Scroll selected into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const el = list.children[selectedIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  const handleSelect = useCallback(
    (item: PaletteItem) => {
      setRecentItems(touchSearchLru(lruScope, itemKey(item)));
      if (item.kind === "db") {
        onSelectDb(item.db);
      } else {
        onSelectTable(item.db, item.schema, item.name, item.kind === "view" ? "view" : "table");
      }
      onClose();
    },
    [itemKey, lruScope, onSelectDb, onSelectTable, onClose],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIdx((prev) => Math.min(prev + 1, sortedFiltered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIdx((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Tab") {
      e.preventDefault();
      if (e.shiftKey) {
        setSelectedIdx((prev) => Math.max(prev - 1, 0));
      } else {
        setSelectedIdx((prev) => Math.min(prev + 1, sortedFiltered.length - 1));
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (sortedFiltered[selectedIdx]) {
        handleSelect(sortedFiltered[selectedIdx]);
      }
    }
  };

  const kindIcon = (kind: PaletteItem["kind"]) => {
    switch (kind) {
      case "db":
        return <Database size={14} className="shrink-0 text-yellow-500" />;
      case "view":
        return <Eye size={14} className="shrink-0 text-purple-400" />;
      default:
        return <Table2 size={14} className="shrink-0 text-accent" />;
    }
  };

  const kindLabel = (kind: PaletteItem["kind"]) => {
    switch (kind) {
      case "db": return "Database";
      case "view": return "View";
      default: return "Table";
    }
  };

  return (
    // Backdrop
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Palette */}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <div
        className="w-[520px] max-h-[420px] flex flex-col bg-bg-primary border border-border rounded-xl shadow-2xl overflow-hidden"
        onKeyDown={handleKeyDown}
      >
        {/* Search input */}
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border">
          <Search size={16} className="text-text-muted shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={mode === "db-only" ? "Search databases..." : "Stupidly Good Search..."}
            className="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-muted outline-none"
            spellCheck={false}
          />
          <kbd className="text-[10px] text-text-muted px-1.5 py-0.5 rounded border border-border-light bg-bg-secondary font-mono">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="flex-1 overflow-y-auto py-1">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-text-muted">
              <Loader2 size={14} className="animate-spin" />
              Loading...
            </div>
          )}

          {!loading && sortedFiltered.length === 0 && (
            <div className="flex items-center justify-center py-8 text-sm text-text-muted">
              No results found
            </div>
          )}

          {!loading &&
            sortedFiltered.map((item, i) => (
              <div
                key={`${item.kind}:${item.db}:${item.schema}:${item.name}`}
                className={`flex items-center gap-2.5 px-4 py-2 cursor-pointer transition-colors ${
                  i === selectedIdx ? "bg-accent/20" : "hover:bg-bg-hover"
                }`}
                onMouseEnter={() => setSelectedIdx(i)}
                onClick={() => handleSelect(item)}
              >
                {kindIcon(item.kind)}
                <span className="flex-1 min-w-0 truncate text-sm font-mono text-text-primary">
                  {item.kind !== "db" && item.db !== currentDatabase && (
                    <span className="text-text-muted">{item.db}.</span>
                  )}
                  {highlightName(item.name, item.indices)}
                </span>
                <span className="text-[10px] text-text-muted shrink-0">
                  {kindLabel(item.kind)}
                </span>
              </div>
            ))}
        </div>

        {/* Footer hint */}
        <div className="flex items-center gap-3 px-4 py-2 border-t border-border text-[10px] text-text-muted">
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 rounded border border-border-light bg-bg-secondary font-mono">↑↓</kbd>
            navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 rounded border border-border-light bg-bg-secondary font-mono">↵</kbd>
            open
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 rounded border border-border-light bg-bg-secondary font-mono">Tab</kbd>
            next
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 rounded border border-border-light bg-bg-secondary font-mono">Esc</kbd>
            close
          </span>
        </div>
      </div>
    </div>
  );
}
