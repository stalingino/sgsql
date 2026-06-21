import { useEffect, useRef, useState } from "react";
import {
  Database,
  Table2,
  Eye,
  Loader2,
  Plus,
  X,
} from "lucide-react";
import {
  fetchSchemas,
  fetchTables,
  type TableInfo,
} from "../lib/schema";
import { getConfig, saveConfig } from "../lib/config";
import { useSchemaRevision } from "../lib/schemaRevision";
import { CreateTableModal } from "./CreateTableModal";

/* ── Props ──────────────────────────────────────────────── */

interface SchemaTreeProps {
  connectionId: string;
  connectionType: "postgres" | "mysql" | "sqlite";
  openDbs: string[];
  activeDb: string | null;
  onActiveDbChange: (db: string) => void;
  onCloseDb: (db: string) => void;
  onAddDb: () => void;
  onTableSelect?: (db: string, schema: string, table: string, type: "table" | "view") => void;
  tableListVisible?: boolean;
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
  openDbs,
  activeDb,
  onActiveDbChange,
  onCloseDb,
  onAddDb,
  onTableSelect,
  tableListVisible = true,
}: SchemaTreeProps) {
  const cacheRef = useRef<SchemaCache>(new Map());
  const schemaRevision = useSchemaRevision(connectionId);
  const [schemas, setSchemas] = useState<string[]>([defaultSchema(connectionType)]);
  const [selectedSchemas, setSelectedSchemas] = useState<Record<string, string>>({});
  const [createOpen, setCreateOpen] = useState(false);
  const schema = activeDb ? selectedSchemas[activeDb] ?? defaultSchema(connectionType) : defaultSchema(connectionType);

  // Reset cache when connection changes
  useEffect(() => {
    cacheRef.current = new Map();
  }, [connectionId, schemaRevision]);

  useEffect(() => {
    if (!activeDb || connectionType !== "postgres") { setSchemas([defaultSchema(connectionType)]); return; }
    let cancelled = false;
    fetchSchemas(connectionId, activeDb).then((items) => { if (!cancelled) { const next = items.length ? items : ["public"]; setSchemas(next); setSelectedSchemas((current) => next.includes(current[activeDb]) ? current : { ...current, [activeDb]: next[0] }); } }).catch(() => { if (!cancelled) setSchemas(["public"]); });
    return () => { cancelled = true; };
  }, [connectionId, connectionType, activeDb, schemaRevision]);

  const isSqlite = connectionType === "sqlite";

  return (<>
    <div className="flex h-full min-h-0">
      {/* ── Left: database tab strip ──────────────────────── */}
      <div className="flex flex-col w-[90px] shrink-0 border-r border-border bg-bg-primary overflow-y-auto">
        {openDbs.map((db) => (
          <DbTab
            key={db}
            db={db}
            active={db === activeDb}
            onClick={() => onActiveDbChange(db)}
            onRemove={() => onCloseDb(db)}
          />
        ))}

        {/* Add database button */}
        {!isSqlite && (
          <button
            onClick={onAddDb}
            title="Add database (⌘K)"
            className="flex flex-col items-center gap-0.5 w-full px-1.5 py-4 text-text-muted hover:text-text-secondary hover:bg-bg-hover transition-colors cursor-pointer border-b border-border"
          >
            <Plus size={13} />
            <span className="text-[11px] font-medium leading-tight">Add Database</span>
          </button>
        )}
      </div>

      {/* ── Right: table list for active database (toggleable + resizable) ── */}
      {tableListVisible && activeDb && (
        <ResizableTableList>
          <TableList
            db={activeDb}
            schema={schema}
            connectionId={connectionId}
            connectionType={connectionType}
            cacheRef={cacheRef}
            onTableSelect={onTableSelect}
            schemaRevision={schemaRevision}
            schemas={schemas}
            onSchemaChange={(nextSchema) => activeDb && setSelectedSchemas((current) => ({ ...current, [activeDb]: nextSchema }))}
            onCreate={() => setCreateOpen(true)}
          />
        </ResizableTableList>
      )}
    </div>
    {createOpen && activeDb && <CreateTableModal connectionId={connectionId} dialect={connectionType} db={activeDb} schema={schema} onClose={() => setCreateOpen(false)} onCreated={(table) => { setCreateOpen(false); onTableSelect?.(activeDb, schema, table, "table"); }} />}
  </>);
}

/* ── Database tab ───────────────────────────────────────── */

function DbTab({
  db,
  active,
  onClick,
  onRemove,
}: {
  db: string;
  active: boolean;
  onClick: () => void;
  onRemove: () => void;
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
        title={db}
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
          <button
            onClick={() => { setCtxMenu(null); onRemove(); }}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-error hover:bg-error/10 transition-colors cursor-pointer"
          >
            <X size={11} />
            Remove database
          </button>
        </div>
      )}
    </>
  );
}

/* ── Fuzzy match ─────────────────────────────────────────── */

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

/* ── Table list for a single database ───────────────────── */

function TableList({
  db,
  schema,
  connectionId,
  connectionType,
  cacheRef,
  onTableSelect,
  schemaRevision,
  schemas,
  onSchemaChange,
  onCreate,
}: {
  db: string;
  schema: string;
  connectionId: string;
  connectionType: "postgres" | "mysql" | "sqlite";
  cacheRef: React.RefObject<SchemaCache>;
  onTableSelect?: (db: string, schema: string, table: string, type: "table" | "view") => void;
  schemaRevision: number;
  schemas: string[];
  onSchemaChange: (schema: string) => void;
  onCreate: () => void;
}) {
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const filterInputRef = useRef<HTMLInputElement>(null);
  const revisionRef = useRef(schemaRevision);

  // Clear search when db changes
  useEffect(() => { setQuery(""); setSelectedIdx(-1); }, [db]);

  // Reset selection when query changes
  useEffect(() => { setSelectedIdx(-1); }, [query]);

  // Auto-focus the filter input on mount
  useEffect(() => {
    filterInputRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        if (revisionRef.current !== schemaRevision) {
          cacheRef.current?.clear();
          revisionRef.current = schemaRevision;
        }
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
  }, [connectionId, connectionType, db, schema, cacheRef, schemaRevision]);

  const filtered = query
    ? tables
        .map((t) => ({ t, ...fuzzyMatch(query, t.name) }))
        .filter((r) => r.match)
        .sort((a, b) => b.score - a.score)
        .map((r) => r.t)
    : tables;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Tab" && filtered.length > 0) {
      e.preventDefault();
      const dir = e.shiftKey ? -1 : 1;
      setSelectedIdx((prev) => {
        if (prev < 0) return 0;
        return (prev + dir + filtered.length) % filtered.length;
      });
    } else if (e.key === "ArrowDown" && filtered.length > 0) {
      e.preventDefault();
      setSelectedIdx((prev) => Math.min(prev + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp" && filtered.length > 0) {
      e.preventDefault();
      setSelectedIdx((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter" && selectedIdx >= 0 && selectedIdx < filtered.length) {
      e.preventDefault();
      const t = filtered[selectedIdx];
      onTableSelect?.(db, schema, t.name, t.type === "view" ? "view" : "table");
    }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Search input */}
      <div className="px-2 py-1.5 border-b border-border shrink-0">
        <div className="flex items-center gap-1 mb-1.5">
          {connectionType === "postgres" && <select value={schema} onChange={(event) => onSchemaChange(event.target.value)} className="min-w-0 flex-1 bg-bg-hover text-text-primary text-[11px] px-1.5 py-1 rounded border border-border outline-none" title="Schema">{schemas.map((item) => <option key={item}>{item}</option>)}</select>}
          <button onClick={onCreate} className="flex items-center gap-1 px-2 py-1 rounded border border-border text-[10px] hover:bg-bg-hover whitespace-nowrap" title="Create table"><Plus size={10} />Table</button>
        </div>
        <input
          ref={filterInputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
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

        {!loading && !error && filtered.map((t, i) => (
          <TableNode
            key={`${t.type}:${t.name}`}
            table={t}
            query={query}
            db={db}
            schema={schema}
            selected={i === selectedIdx}
            onTableSelect={onTableSelect}
          />
        ))}
      </div>
    </div>
  );
}

/* ── Table node ──────────────────────────────────────────── */

function highlightMatch(name: string, query: string): React.ReactNode {
  if (!query) return name;
  const q = query.toLowerCase();
  const n = name.toLowerCase();
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
  // Fuzzy highlight
  const result: React.ReactNode[] = [];
  let qi = 0;
  for (let i = 0; i < name.length; i++) {
    if (qi < q.length && n[i] === q[qi]) {
      result.push(
        <mark key={i} className="bg-accent/25 text-inherit rounded-[2px]">{name[i]}</mark>,
      );
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
  selected,
  onTableSelect,
}: {
  table: TableInfo;
  query?: string;
  db: string;
  schema: string;
  selected?: boolean;
  onTableSelect?: (db: string, schema: string, table: string, type: "table" | "view") => void;
}) {
  const isView = table.type === "view";
  const nodeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selected && nodeRef.current) {
      nodeRef.current.scrollIntoView({ block: "nearest" });
    }
  }, [selected]);

  return (
    <div
      ref={nodeRef}
      className={`flex items-center gap-1.5 py-[3px] pr-2 pl-3 cursor-pointer transition-colors ${
        selected ? "bg-accent/20" : "hover:bg-bg-hover"
      }`}
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

/* ── Resizable table list wrapper ──────────────────────── */

function ResizableTableList({ children }: { children: React.ReactNode }) {
  const [width, setWidth] = useState(() => {
    const saved = getConfig().sidebar?.width;
    return saved ? Math.min(400, Math.max(120, saved)) : 200;
  });
  const dragging = useRef(false);
  const startX = useRef(0);
  const startW = useRef(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const onMouseDown = (e: React.MouseEvent) => {
    dragging.current = true;
    startX.current = e.clientX;
    startW.current = width;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const next = Math.min(400, Math.max(120, startW.current + e.clientX - startX.current));
      setWidth(next);
    };
    const onMouseUp = (e: MouseEvent) => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      const finalWidth = Math.min(400, Math.max(120, startW.current + e.clientX - startX.current));
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        saveConfig({ sidebar: { visible: getConfig().sidebar?.visible ?? true, width: finalWidth } });
      }, 100);
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  return (
    <div className="flex h-full shrink-0 border-r border-border" style={{ width }}>
      <div className="flex-1 flex flex-col min-w-0 min-h-0 bg-bg-secondary">
        {children}
      </div>
      <div
        onMouseDown={onMouseDown}
        className="w-[4px] shrink-0 cursor-col-resize hover:bg-accent/30 active:bg-accent/50 transition-colors"
      />
    </div>
  );
}
