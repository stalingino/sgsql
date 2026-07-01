import { useEffect, useMemo, useRef, useState } from "react";
import { modKey } from "../lib/platform";
import {
  Database,
  Table2,
  Eye,
  Loader2,
  Plus,
  X,
} from "lucide-react";
import {
  applySchemaChanges,
  fetchSchemas,
  fetchTables,
  type TableInfo,
} from "../lib/schema";
import { quoteIdent } from "../lib/schemaDdl";
import { getConfig, saveConfig } from "../lib/config";
import { useEditStore } from "../lib/editStore";
import { notifySchemaChanged, useSchemaRevision } from "../lib/schemaRevision";
import { CreateTableModal } from "./CreateTableModal";
import { HighlightedSQL } from "../lib/highlightSQL";
import { fuzzySearch } from "../lib/fuzzySearch";

/* ── Props ──────────────────────────────────────────────── */

interface SchemaTreeProps {
  connectionId: string;
  connectionType: "postgres" | "mysql" | "sqlite";
  openDbs: string[];
  activeDb: string | null;
  onActiveDbChange: (db: string) => void;
  onCloseDb: (db: string) => void;
  onDbReorder: (sourceDb: string, targetDb: string) => void;
  onAddDb: () => void;
  onTableSelect?: (db: string, schema: string, table: string, type: "table" | "view") => void;
  onTableDrop?: (db: string, schema: string, table: string) => void;
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
  onDbReorder,
  onAddDb,
  onTableSelect,
  onTableDrop,
  tableListVisible = true,
}: SchemaTreeProps) {
  const cacheRef = useRef<SchemaCache>(new Map());
  const schemaRevision = useSchemaRevision(connectionId);
  const [schemas, setSchemas] = useState<string[]>([defaultSchema(connectionType)]);
  const [selectedSchemas, setSelectedSchemas] = useState<Record<string, string>>({});
  const [createOpen, setCreateOpen] = useState(false);
  const draggedDbRef = useRef<string | null>(null);
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
            onDragStart={(event) => {
              draggedDbRef.current = db;
              event.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(event) => {
              if (draggedDbRef.current && draggedDbRef.current !== db) {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }
            }}
            onDrop={(event) => {
              event.preventDefault();
              const sourceDb = draggedDbRef.current;
              if (sourceDb) onDbReorder(sourceDb, db);
              draggedDbRef.current = null;
            }}
            onDragEnd={() => { draggedDbRef.current = null; }}
          />
        ))}

        {/* Add database button */}
        {!isSqlite && (
          <button
            onClick={onAddDb}
            title={`Add database (${modKey("K")})`}
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
            onTableDrop={onTableDrop}
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
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  db: string;
  active: boolean;
  onClick: () => void;
  onRemove: () => void;
  onDragStart: React.DragEventHandler<HTMLDivElement>;
  onDragOver: React.DragEventHandler<HTMLDivElement>;
  onDrop: React.DragEventHandler<HTMLDivElement>;
  onDragEnd: React.DragEventHandler<HTMLDivElement>;
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
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDragEnd={onDragEnd}
        draggable
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

/* ── Table list for a single database ───────────────────── */

function TableList({
  db,
  schema,
  connectionId,
  connectionType,
  cacheRef,
  onTableSelect,
  onTableDrop,
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
  onTableDrop?: (db: string, schema: string, table: string) => void;
  schemaRevision: number;
  schemas: string[];
  onSchemaChange: (schema: string) => void;
  onCreate: () => void;
}) {
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedTableKey, setSelectedTableKey] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ table: TableInfo; x: number; y: number } | null>(null);
  const [pendingAction, setPendingAction] = useState<{ kind: "truncate" | "drop"; table: TableInfo; statement: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const filterInputRef = useRef<HTMLInputElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const revisionRef = useRef(schemaRevision);

  // Clear search when db changes
  useEffect(() => { setQuery(""); setSelectedTableKey(null); }, [db, schema]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = (event: MouseEvent) => {
      if (!contextMenuRef.current?.contains(event.target as Node)) setContextMenu(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [contextMenu]);

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

  const filtered = useMemo(
    () => fuzzySearch(tables, query, { keys: [{ name: "name", weight: 2 }, "type"] }),
    [tables, query],
  );

  const selectedIdx = filtered.findIndex((table) => `${table.type}:${table.name}` === selectedTableKey);
  const selectTable = (table: TableInfo, open = true) => {
    setSelectedTableKey(`${table.type}:${table.name}`);
    if (open) onTableSelect?.(db, schema, table.name, table.type === "view" ? "view" : "table");
  };

  const tableReference = (table: string) => {
    if (connectionType === "mysql") return `${quoteIdent(connectionType, db)}.${quoteIdent(connectionType, table)}`;
    if (connectionType === "postgres") return `${quoteIdent(connectionType, schema || "public")}.${quoteIdent(connectionType, table)}`;
    return quoteIdent(connectionType, table);
  };

  const beginAction = (kind: "truncate" | "drop") => {
    if (!contextMenu) return;
    const ref = tableReference(contextMenu.table.name);
    const statement = kind === "drop"
      ? `DROP TABLE ${ref}`
      : connectionType === "sqlite"
        ? `DELETE FROM ${ref}`
        : `TRUNCATE TABLE ${ref}`;
    setContextMenu(null);
    setActionError(null);
    setPendingAction({ kind, table: contextMenu.table, statement });
  };

  const runAction = async () => {
    if (!pendingAction) return;
    setWorking(true);
    setActionError(null);
    try {
      await applySchemaChanges(connectionId, db, [pendingAction.statement], connectionType === "sqlite");
      notifySchemaChanged(connectionId);
      if (pendingAction.kind === "truncate") {
        useEditStore.getState().requestDataRefresh([{ connectionId, db, schema, table: pendingAction.table.name }]);
      }
      if (pendingAction.kind === "drop") {
        setSelectedTableKey(null);
        onTableDrop?.(db, schema, pendingAction.table.name);
      }
      setPendingAction(null);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Tab" && filtered.length > 0) {
      e.preventDefault();
      const dir = e.shiftKey ? -1 : 1;
      const next = selectedIdx < 0 ? 0 : (selectedIdx + dir + filtered.length) % filtered.length;
      selectTable(filtered[next], false);
    } else if (e.key === "ArrowDown" && filtered.length > 0) {
      e.preventDefault();
      selectTable(filtered[Math.min(selectedIdx + 1, filtered.length - 1)], false);
    } else if (e.key === "ArrowUp" && filtered.length > 0) {
      e.preventDefault();
      selectTable(filtered[Math.max(selectedIdx - 1, 0)], false);
    } else if (e.key === "Enter" && selectedIdx >= 0 && selectedIdx < filtered.length) {
      e.preventDefault();
      selectTable(filtered[selectedIdx]);
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
            selected={i === selectedIdx}
            onSelect={() => selectTable(t)}
            onContextMenu={(event) => {
              event.preventDefault();
              selectTable(t, false);
              if (t.type === "table") setContextMenu({ table: t, x: event.clientX, y: event.clientY });
            }}
          />
        ))}
      </div>
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-[9999] min-w-[170px] overflow-hidden rounded-md border border-border bg-bg-primary py-1 shadow-xl"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          <div className="mb-1 border-b border-border px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
            {contextMenu.table.name}
          </div>
          <button onClick={() => beginAction("truncate")} className="flex w-full items-center px-3 py-1.5 text-left text-[12px] text-text-primary transition-colors hover:bg-bg-hover">
            Truncate table
          </button>
          <button onClick={() => beginAction("drop")} className="flex w-full items-center px-3 py-1.5 text-left text-[12px] text-error transition-colors hover:bg-error/10">
            Drop table
          </button>
        </div>
      )}
      {pendingAction && (
        <TableActionConfirm
          action={pendingAction}
          error={actionError}
          working={working}
          onCancel={() => { if (!working) { setPendingAction(null); setActionError(null); } }}
          onConfirm={() => void runAction()}
        />
      )}
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
  selected,
  onSelect,
  onContextMenu,
}: {
  table: TableInfo;
  query?: string;
  selected?: boolean;
  onSelect: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
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
      onClick={onSelect}
      onContextMenu={onContextMenu}
    >
      {isView
        ? <Eye size={14} className="shrink-0 text-purple-400" />
        : <Table2 size={14} className="shrink-0 text-accent" />
      }
      <span className="truncate text-[12px] font-mono text-text-primary">{highlightMatch(table.name, query)}</span>
    </div>
  );
}

function TableActionConfirm({
  action,
  error,
  working,
  onCancel,
  onConfirm,
}: {
  action: { kind: "truncate" | "drop"; table: TableInfo; statement: string };
  error: string | null;
  working: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const label = action.kind === "drop" ? "Drop table" : "Truncate table";
  return <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 p-6">
    <div className="w-full max-w-xl rounded-lg border border-border bg-bg-primary shadow-2xl">
      <div className="border-b border-border px-4 py-3">
        <div className="text-sm font-semibold">{label}</div>
        <div className="mt-0.5 text-[11px] text-warning">This permanently changes <span className="font-mono">{action.table.name}</span>. Verify the statement before applying it.</div>
      </div>
      {error && <div className="bg-error/10 px-4 py-2 text-xs text-error">{error}</div>}
      <pre className="max-h-48 overflow-auto p-4 text-xs leading-5 font-mono whitespace-pre-wrap"><HighlightedSQL sql={`${action.statement};`} /></pre>
      <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
        <button disabled={working} onClick={onCancel} className="rounded border border-border px-3 py-1.5 text-xs disabled:opacity-50">Cancel</button>
        <button disabled={working} onClick={onConfirm} className="rounded bg-error px-3 py-1.5 text-xs text-white disabled:opacity-50">{working ? "Applying…" : label}</button>
      </div>
    </div>
  </div>;
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
