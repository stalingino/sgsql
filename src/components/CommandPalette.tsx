import { useCallback, useEffect, useRef, useState } from "react";
import { Database, Table2, Eye, Loader2, Search } from "lucide-react";
import { fetchDatabases, fetchTables } from "../lib/schema";

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
  mode?: "all" | "db-only";
  onSelectDb: (db: string) => void;
  onSelectTable: (db: string, schema: string, table: string, type: "table" | "view") => void;
  onClose: () => void;
}

/* ── Fuzzy match ───────────────────────────────────────── */

function fuzzyMatch(query: string, target: string): { match: boolean; score: number } {
  if (!query) return { match: true, score: 0 };
  const q = query.toLowerCase();
  const t = target.toLowerCase();

  if (t.includes(q)) return { match: true, score: 100 + q.length };

  let qi = 0;
  let score = 0;
  let consecutive = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      qi++;
      consecutive++;
      score += consecutive;
    } else {
      consecutive = 0;
    }
  }
  return { match: qi === q.length, score };
}

function defaultSchema(type: "postgres" | "mysql" | "sqlite"): string {
  if (type === "postgres") return "public";
  if (type === "sqlite") return "main";
  return "";
}

/* ── Component ─────────────────────────────────────────── */

export function CommandPalette({
  connectionId,
  connectionType,
  connectionDatabase,
  mode = "all",
  onSelectDb,
  onSelectTable,
  onClose,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<PaletteItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const schema = defaultSchema(connectionType);

  // Load all databases and their tables on mount
  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      try {
        const dbs = await fetchDatabases(connectionId);
        const allItems: PaletteItem[] = [];

        // Add databases
        for (const db of dbs) {
          allItems.push({ kind: "db", db, schema: "", name: db, score: 0 });
        }

        // Fetch tables only in "all" mode
        if (mode !== "db-only") {
          const orderedDbs = [connectionDatabase, ...dbs.filter((d) => d !== connectionDatabase)];
          for (const db of orderedDbs) {
            try {
              const tables = await fetchTables(connectionId, db, schema);
              for (const t of tables) {
                allItems.push({
                  kind: t.type === "view" ? "view" : "table",
                  db,
                  schema,
                  name: t.name,
                  score: 0,
                });
              }
            } catch {
              // skip dbs we can't read tables from
            }
          }
        }

        if (!cancelled) {
          setItems(allItems);
          setLoading(false);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [connectionId, connectionDatabase, schema, mode]);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Filter and sort
  const filtered = query.trim()
    ? items
        .map((item) => {
          const label = item.kind === "db" ? item.name : `${item.db}.${item.name}`;
          const m = fuzzyMatch(query.trim(), label);
          // Also try matching just the name
          const m2 = fuzzyMatch(query.trim(), item.name);
          const bestScore = Math.max(m.score, m2.score);
          return { item, match: m.match || m2.match, score: bestScore };
        })
        .filter((r) => r.match)
        .sort((a, b) => b.score - a.score)
        .map((r) => r.item)
    : items;

  // Sort: tables/views first, databases last
  const sortedFiltered = [...filtered].sort((a, b) => {
    if (a.kind === "db" && b.kind !== "db") return 1;
    if (a.kind !== "db" && b.kind === "db") return -1;
    return 0;
  });

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
      if (item.kind === "db") {
        onSelectDb(item.db);
      } else {
        onSelectTable(item.db, item.schema, item.name, item.kind === "view" ? "view" : "table");
      }
      onClose();
    },
    [onSelectDb, onSelectTable, onClose],
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
                key={`${item.kind}:${item.db}:${item.name}`}
                className={`flex items-center gap-2.5 px-4 py-2 cursor-pointer transition-colors ${
                  i === selectedIdx ? "bg-accent/20" : "hover:bg-bg-hover"
                }`}
                onMouseEnter={() => setSelectedIdx(i)}
                onClick={() => handleSelect(item)}
              >
                {kindIcon(item.kind)}
                <span className="flex-1 min-w-0 truncate text-sm font-mono text-text-primary">
                  {item.kind !== "db" && item.db !== connectionDatabase && (
                    <span className="text-text-muted">{item.db}.</span>
                  )}
                  {item.name}
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
