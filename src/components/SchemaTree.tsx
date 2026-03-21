import { useCallback, useEffect, useRef, useState } from "react";
import {
  Database,
  Table2,
  Eye,
  Loader2,
  Plus,
  X,
} from "lucide-react";
import {
  fetchDatabases,
  fetchTables,
  type TableInfo,
} from "../lib/schema";

/* ── Props ──────────────────────────────────────────────── */

interface SchemaTreeProps {
  connectionId: string;
  connectionType: "postgres" | "mysql" | "sqlite";
  connectionDatabase: string;
  onTableSelect?: (db: string, schema: string, table: string, type: "table" | "view") => void;
}

/* ── Layered cache ──────────────────────────────────────── */
type SchemaCache = Map<string, Map<string, TableInfo[]>>;

function defaultSchema(type: "postgres" | "mysql" | "sqlite"): string {
  if (type === "postgres") return "public";
  if (type === "sqlite") return "main";
  return "";
}

/* ── Component ──────────────────────────────────────────── */

export function SchemaTree({
  connectionId,
  connectionType,
  connectionDatabase,
  onTableSelect,
}: SchemaTreeProps) {
  const [openDbs, setOpenDbs] = useState<string[]>([connectionDatabase]);
  const [activeDb, setActiveDb] = useState(connectionDatabase);
  const [allDatabases, setAllDatabases] = useState<string[] | null>(null);
  const [showDbPicker, setShowDbPicker] = useState(false);
  const [loadingDbs, setLoadingDbs] = useState(false);

  const cacheRef = useRef<SchemaCache>(new Map());
  const schema = defaultSchema(connectionType);
  const popoverRef = useRef<HTMLDivElement>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);

  // Reset when connection changes
  useEffect(() => {
    setOpenDbs([connectionDatabase]);
    setActiveDb(connectionDatabase);
    setAllDatabases(null);
    setShowDbPicker(false);
    cacheRef.current = new Map();
  }, [connectionId, connectionDatabase]);

  // Close popover on outside click
  useEffect(() => {
    if (!showDbPicker) return;
    const handler = (e: MouseEvent) => {
      if (
        popoverRef.current && !popoverRef.current.contains(e.target as Node) &&
        addBtnRef.current && !addBtnRef.current.contains(e.target as Node)
      ) {
        setShowDbPicker(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showDbPicker]);

  const handleAddDb = useCallback(async () => {
    if (allDatabases) {
      setShowDbPicker(true);
      return;
    }
    setLoadingDbs(true);
    try {
      const dbs = await fetchDatabases(connectionId);
      setAllDatabases(dbs);
      setShowDbPicker(true);
    } catch {
      // silently fail
    } finally {
      setLoadingDbs(false);
    }
  }, [connectionId, allDatabases]);

  const selectDb = useCallback((db: string) => {
    setOpenDbs((prev) => prev.includes(db) ? prev : [...prev, db]);
    setActiveDb(db);
    setShowDbPicker(false);
  }, []);

  const removeDb = useCallback((db: string) => {
    setOpenDbs((prev) => {
      const next = prev.filter((d) => d !== db);
      return next;
    });
    setActiveDb((prev) => prev === db ? connectionDatabase : prev);
  }, [connectionDatabase]);

  const isSqlite = connectionType === "sqlite";

  return (
    <div className="flex h-full min-h-0">
      {/* ── Left: database tab strip ──────────────────────── */}
      <div className="flex flex-col w-[90px] shrink-0 border-r border-border bg-bg-primary overflow-y-auto">
        {openDbs.map((db) => (
          <DbTab
            key={db}
            db={db}
            active={db === activeDb}
            isDefault={db === connectionDatabase}
            onClick={() => setActiveDb(db)}
            onRemove={db !== connectionDatabase ? () => removeDb(db) : undefined}
          />
        ))}

        {/* Add database button — right after last db tab */}
        {!isSqlite && (
          <button
            ref={addBtnRef}
            onClick={handleAddDb}
            disabled={loadingDbs}
            title="Add database"
            className="flex flex-col items-center gap-0.5 w-full px-1.5 py-4 text-text-muted hover:text-text-secondary hover:bg-bg-hover transition-colors cursor-pointer border-b border-border"
          >
            {loadingDbs
              ? <Loader2 size={13} className="animate-spin" />
              : <Plus size={13} />
            }
            <span className="text-[11px] font-medium leading-tight">Add Database</span>
          </button>
        )}
      </div>

      {/* ── Popover — portaled to the sidebar root so it's not clipped ── */}
      {showDbPicker && allDatabases && (
        <div
          ref={popoverRef}
          className="fixed z-[9999] w-[220px] rounded-md border border-border bg-bg-primary shadow-xl overflow-hidden"
          style={{
            left: 56 + 240 + 8, // db strip width is inside the 240px aside, but we need absolute screen pos
            ...(addBtnRef.current ? (() => {
              const rect = addBtnRef.current.getBoundingClientRect();
              return { top: Math.max(8, rect.top - 200), left: rect.right + 4 };
            })() : {}),
          }}
        >
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-border">
            <span className="text-[10px] font-semibold text-text-muted uppercase tracking-wider">Select database</span>
            <button
              onClick={() => setShowDbPicker(false)}
              className="text-text-muted hover:text-text-primary cursor-pointer"
            >
              <X size={12} />
            </button>
          </div>
          <div className="max-h-[200px] overflow-y-auto py-1">
            {allDatabases
              .filter((d) => !openDbs.includes(d))
              .map((d) => (
                <div
                  key={d}
                  onClick={() => selectDb(d)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] text-text-secondary hover:bg-bg-hover cursor-pointer transition-colors"
                >
                  <Database size={11} className="text-text-muted shrink-0" />
                  <span className="truncate">{d}</span>
                </div>
              ))}
            {allDatabases.filter((d) => !openDbs.includes(d)).length === 0 && (
              <div className="px-3 py-2 text-[11px] text-text-muted">All databases added.</div>
            )}
          </div>
        </div>
      )}

      {/* ── Right: table list for active database ─────────── */}
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        <TableList
          db={activeDb}
          schema={schema}
          connectionId={connectionId}
          connectionType={connectionType}
          cacheRef={cacheRef}
          onTableSelect={onTableSelect}
        />
      </div>
    </div>
  );
}

/* ── Database tab ───────────────────────────────────────── */

function DbTab({
  db,
  active,
  isDefault,
  onClick,
  onRemove,
}: {
  db: string;
  active: boolean;
  isDefault: boolean;
  onClick: () => void;
  onRemove?: () => void;
}) {
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ctxMenu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setCtxMenu(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [ctxMenu]);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  };

  return (
    <>
      <div
        onClick={onClick}
        onContextMenu={handleContextMenu}
        title={db + (isDefault ? " (default)" : "")}
        className={`relative flex flex-col items-center gap-0.5 px-1.5 py-4 cursor-pointer transition-colors border-b border-border ${
          active
            ? "bg-bg-secondary text-text-primary"
            : "text-text-muted hover:text-text-secondary hover:bg-bg-hover"
        }`}
      >
        {active && (
          <div className="absolute left-0 top-0 bottom-0 w-[2px] bg-accent" />
        )}
        <Database size={13} className={`shrink-0 ${active ? "text-accent" : ""}`} />
        <span className="text-[10px] font-mono leading-tight truncate w-full text-center">
          {db}
        </span>
      </div>

      {ctxMenu && (
        <div
          ref={menuRef}
          className="fixed z-[9999] min-w-[140px] rounded-md border border-border bg-bg-primary shadow-xl overflow-hidden py-1"
          style={{ top: ctxMenu.y, left: ctxMenu.x }}
        >
          <div className="px-3 py-1 text-[10px] text-text-muted font-semibold uppercase tracking-wider border-b border-border mb-1">
            {db}
          </div>
          {onRemove && (
            <button
              onClick={() => { setCtxMenu(null); onRemove(); }}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-error hover:bg-error/10 transition-colors cursor-pointer"
            >
              <X size={11} />
              Remove database
            </button>
          )}
          {!onRemove && (
            <div className="px-3 py-1.5 text-[12px] text-text-muted">Default database</div>
          )}
        </div>
      )}
    </>
  );
}

/* ── Fuzzy match ────────────────────────────────────────── */

function fuzzyMatch(query: string, target: string): { match: boolean; score: number } {
  if (!query) return { match: true, score: 0 };
  const q = query.toLowerCase();
  const t = target.toLowerCase();

  // Exact substring = highest score
  if (t.includes(q)) return { match: true, score: 100 + q.length };

  // Fuzzy: all chars of query appear in order in target
  let qi = 0;
  let score = 0;
  let consecutive = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      qi++;
      consecutive++;
      score += consecutive; // reward consecutive matches
    } else {
      consecutive = 0;
    }
  }
  return { match: qi === q.length, score };
}

/* ── Table list for a single database ───────────────────── */

function TableList({
  db,
  schema,
  connectionId,
  connectionType,
  cacheRef,
  onTableSelect,
}: {
  db: string;
  schema: string;
  connectionId: string;
  connectionType: "postgres" | "mysql" | "sqlite";
  cacheRef: React.RefObject<SchemaCache>;
  onTableSelect?: (db: string, schema: string, table: string, type: "table" | "view") => void;
}) {
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  // Clear search when db changes
  useEffect(() => { setQuery(""); }, [db]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const cached = cacheRef.current?.get(db)?.get(schema);
        if (cached) {
          if (!cancelled) { setTables(cached); setLoading(false); }
          return;
        }

        const result = await fetchTables(connectionId, db, schema);

        if (cacheRef.current) {
          if (!cacheRef.current.has(db)) {
            cacheRef.current.set(db, new Map());
          }
          cacheRef.current.get(db)!.set(schema, result);
        }

        if (!cancelled) setTables(result);
      } catch (err: unknown) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [connectionId, connectionType, db, schema, cacheRef]);

  const filtered = query
    ? tables
        .map((t) => ({ t, ...fuzzyMatch(query, t.name) }))
        .filter((r) => r.match)
        .sort((a, b) => b.score - a.score)
        .map((r) => r.t)
    : tables;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Search input */}
      <div className="px-2 py-1.5 border-b border-border shrink-0">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter tables..."
          className="w-full bg-bg-hover text-text-primary text-[12px] font-mono placeholder-text-muted px-2 py-1 rounded outline-none focus:ring-1 focus:ring-accent/50"
        />
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 py-1">
        {loading && (
          <div className="flex items-center gap-2 px-3 py-4 text-xs text-text-muted">
            <Loader2 size={12} className="animate-spin" />
            Loading tables...
          </div>
        )}

        {error && (
          <div className="px-3 py-4 text-xs text-error">{error}</div>
        )}

        {!loading && !error && filtered.length === 0 && (
          <div className="px-3 py-4 text-xs text-text-muted">
            {query ? "No matches." : "No tables found."}
          </div>
        )}

        {!loading && !error && filtered.map((t) => (
          <TableNode
            key={`${t.type}:${t.name}`}
            table={t}
            query={query}
            db={db}
            schema={schema}
            onTableSelect={onTableSelect}
          />
        ))}
      </div>
    </div>
  );
}

/* ── Table node (expandable to show columns) ────────────── */

function highlightMatch(name: string, query: string): React.ReactNode {
  if (!query) return name;
  const q = query.toLowerCase();
  const n = name.toLowerCase();
  // Exact substring highlight
  const idx = n.indexOf(q);
  if (idx !== -1) {
    return (
      <>
        {name.slice(0, idx)}
        <mark className="bg-accent/25 text-inherit rounded-[2px]">{name.slice(idx, idx + q.length)}</mark>
        {name.slice(idx + q.length)}
      </>
    );
  }
  // Fuzzy: highlight individual matched chars
  const result: React.ReactNode[] = [];
  let qi = 0;
  for (let i = 0; i < name.length; i++) {
    if (qi < q.length && name[i].toLowerCase() === q[qi]) {
      result.push(<mark key={i} className="bg-accent/25 text-inherit rounded-[2px]">{name[i]}</mark>);
      qi++;
    } else {
      result.push(name[i]);
    }
  }
  return <>{result}</>;
}

function TableNode({
  table,
  query = "",
  db,
  schema,
  onTableSelect,
}: {
  table: TableInfo;
  query?: string;
  db: string;
  schema: string;
  onTableSelect?: (db: string, schema: string, table: string, type: "table" | "view") => void;
}) {
  const isView = table.type === "view";

  return (
    <div
      className="flex items-center gap-1.5 py-[3px] pr-2 pl-3 cursor-pointer hover:bg-bg-hover transition-colors"
      onClick={() => onTableSelect?.(db, schema, table.name, isView ? "view" : "table")}
    >
      {isView
        ? <Eye size={14} className="shrink-0 text-purple-400" />
        : <Table2 size={14} className="shrink-0 text-accent" />
      }
      <span className="truncate text-[12px] font-mono text-text-primary">{highlightMatch(table.name, query)}</span>
    </div>
  );
}
