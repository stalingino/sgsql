import { useEffect, useMemo, useRef, useState } from "react";
import { modKey } from "../lib/platform";
import {
  Database,
  Table2,
  Eye,
  Code2,
  ChevronDown,
  ChevronRight,
  Loader2,
  Plus,
  Users,
  X,
  Download,
  Upload,
  CheckSquare,
  Square,
  SquareMinus,
} from "lucide-react";
import {
  applySchemaChanges,
  fetchSchemas,
  fetchSchemaObjects,
  type SchemaObjectInfo,
  type TableInfo,
} from "../lib/schema";
import { quoteIdent } from "../lib/schemaDdl";
import { getConfig, saveConfig } from "../lib/config";
import { useEditStore } from "../lib/editStore";
import { notifySchemaChanged, useSchemaRevision } from "../lib/schemaRevision";
import { CreateTableModal } from "./CreateTableModal";
import { HighlightedSQL } from "../lib/highlightSQL";
import { fuzzySearchResults, matchSegments } from "../lib/fuzzySearch";
import { ConnectionSchemaCache, type SchemaCache } from "../lib/schemaCache";
import { TableExportModal } from "./TableExportModal";

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
  onImport: (db: string, schema: string) => void;
  /** Server-level user management view is showing instead of a db workspace. */
  usersActive?: boolean;
  onOpenUsers?: () => void;
  onTableSelect?: (db: string, schema: string, table: string, type: "table" | "view" | "function", identity?: string, signature?: string) => void;
  onTableDrop?: (db: string, schema: string, table: string) => void;
  tableListVisible?: boolean;
}

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
  onImport,
  usersActive = false,
  onOpenUsers,
  onTableSelect,
  onTableDrop,
  tableListVisible = true,
}: SchemaTreeProps) {
  const cachesRef = useRef(new ConnectionSchemaCache<SchemaObjectInfo>());
  const schemaRevision = useSchemaRevision(connectionId);
  const cache = cachesRef.current.forConnection(connectionId, schemaRevision);
  const [schemas, setSchemas] = useState<string[]>([defaultSchema(connectionType)]);
  const [selectedSchemas, setSelectedSchemas] = useState<Record<string, string>>({});
  const [createOpen, setCreateOpen] = useState(false);
  const draggedDbRef = useRef<string | null>(null);
  const schemaSelectionKey = activeDb ? `${connectionId}\u0000${activeDb}` : "";
  const schema = activeDb ? selectedSchemas[schemaSelectionKey] ?? defaultSchema(connectionType) : defaultSchema(connectionType);

  useEffect(() => {
    if (!activeDb || connectionType !== "postgres") { setSchemas([defaultSchema(connectionType)]); return; }
    let cancelled = false;
    const selectionKey = `${connectionId}\u0000${activeDb}`;
    fetchSchemas(connectionId, activeDb).then((items) => { if (!cancelled) { const next = items.length ? items : ["public"]; setSchemas(next); setSelectedSchemas((current) => next.includes(current[selectionKey]) ? current : { ...current, [selectionKey]: next[0] }); } }).catch(() => { if (!cancelled) setSchemas(["public"]); });
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

        {/* Users: server-scoped pseudo-tab pinned to the bottom of the strip */}
        {!isSqlite && onOpenUsers && (
          <button
            onClick={onOpenUsers}
            title="Manage users and access"
            className={`relative mt-auto flex flex-col items-center gap-0.5 w-full px-1.5 py-4 transition-colors cursor-pointer border-t border-border ${
              usersActive
                ? "bg-bg-secondary text-text-primary"
                : "text-text-muted hover:text-text-secondary hover:bg-bg-hover"
            }`}
          >
            {usersActive && <div className="absolute left-0 top-0 bottom-0 w-[2px] bg-accent" />}
            <Users size={13} className={`shrink-0 ${usersActive ? "text-accent" : ""}`} />
            <span className="text-[11px] font-medium leading-tight">Users</span>
          </button>
        )}
      </div>

      {/* ── Right: table list for active database (toggleable + resizable) ── */}
      {tableListVisible && activeDb && !usersActive && (
        <ResizableTableList>
          <TableList
            db={activeDb}
            schema={schema}
            connectionId={connectionId}
            connectionType={connectionType}
            cache={cache}
            onTableSelect={onTableSelect}
            onTableDrop={onTableDrop}
            schemaRevision={schemaRevision}
            schemas={schemas}
            onSchemaChange={(nextSchema) => activeDb && setSelectedSchemas((current) => ({ ...current, [schemaSelectionKey]: nextSchema }))}
            onCreate={() => setCreateOpen(true)}
            onImport={() => onImport(activeDb, schema)}
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
  cache,
  onTableSelect,
  onTableDrop,
  schemaRevision,
  schemas,
  onSchemaChange,
  onCreate,
  onImport,
}: {
  db: string;
  schema: string;
  connectionId: string;
  connectionType: "postgres" | "mysql" | "sqlite";
  cache: SchemaCache<SchemaObjectInfo>;
  onTableSelect?: (db: string, schema: string, table: string, type: "table" | "view" | "function", identity?: string, signature?: string) => void;
  onTableDrop?: (db: string, schema: string, table: string) => void;
  schemaRevision: number;
  schemas: string[];
  onSchemaChange: (schema: string) => void;
  onCreate: () => void;
  onImport: () => void;
}) {
  const [objects, setObjects] = useState<SchemaObjectInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedTableKey, setSelectedTableKey] = useState<string | null>(null);
  const [selectedTableKeys, setSelectedTableKeys] = useState<Set<string>>(() => new Set());
  const [exportOpen, setExportOpen] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<SchemaObjectInfo["type"]>>(
    () => new Set<SchemaObjectInfo["type"]>(["view", "function"]),
  );
  const [contextMenu, setContextMenu] = useState<{ table: TableInfo; x: number; y: number } | null>(null);
  const [pendingAction, setPendingAction] = useState<{ kind: "truncate" | "drop"; table: TableInfo; statement: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const filterInputRef = useRef<HTMLInputElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // Clear search when db changes
  useEffect(() => {
    setQuery("");
    setSelectedTableKey(null);
    setSelectedTableKeys(new Set());
    setExportOpen(false);
  }, [db, schema]);

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
        const cached = cache.get(db)?.get(schema);
        if (cached) {
          if (!cancelled) { setObjects(cached); setLoading(false); }
          return;
        }

        const result = await fetchSchemaObjects(connectionId, db, schema);

        if (!cache.has(db)) {
          cache.set(db, new Map());
        }
        cache.get(db)!.set(schema, result);

        if (!cancelled) setObjects(result);
      } catch (err: unknown) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [connectionId, connectionType, db, schema, cache, schemaRevision]);

  const filtered = useMemo(
    () =>
      fuzzySearchResults(objects, query, { keys: [{ name: "name", weight: 2 }, "signature", "type"] }).map((result) => ({
        ...result.item,
        indices: result.indices,
      })),
    [objects, query],
  );

  const grouped = useMemo(() => ({
    table: filtered.filter((object) => object.type === "table"),
    view: filtered.filter((object) => object.type === "view"),
    function: filtered.filter((object) => object.type === "function"),
  }), [filtered]);
  const navigable = useMemo(
    () => (["table", "view", "function"] as const).flatMap((type) => collapsedGroups.has(type) && !query ? [] : grouped[type]),
    [collapsedGroups, grouped, query],
  );

  const objectKey = (object: SchemaObjectInfo) => `${object.type}:${object.identity || object.name}`;
  const selectedTables = objects
    .filter((object) => object.type === "table" && selectedTableKeys.has(objectKey(object)))
    .map((object) => object.name);
  const selectedIdx = navigable.findIndex((object) => objectKey(object) === selectedTableKey);
  const selectTable = (object: SchemaObjectInfo, open = true) => {
    setSelectedTableKey(objectKey(object));
    if (open) onTableSelect?.(db, schema, object.name, object.type, object.identity, object.signature);
  };

  const tableReference = (table: string) => {
    if (connectionType === "mysql") return `${quoteIdent(connectionType, db)}.${quoteIdent(connectionType, table)}`;
    if (connectionType === "postgres") return `${quoteIdent(connectionType, schema || "public")}.${quoteIdent(connectionType, table)}`;
    return quoteIdent(connectionType, table);
  };

  const toggleTableSelection = (object: SchemaObjectInfo) => {
    if (object.type !== "table") return;
    const key = objectKey(object);
    setSelectedTableKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const toggleAllVisibleTables = () => {
    const visibleKeys = grouped.table.map(objectKey);
    const allSelected = visibleKeys.length > 0 && visibleKeys.every((key) => selectedTableKeys.has(key));
    setSelectedTableKeys((current) => {
      const next = new Set(current);
      for (const key of visibleKeys) {
        if (allSelected) next.delete(key); else next.add(key);
      }
      return next;
    });
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
        setSelectedTableKeys((current) => {
          const next = new Set(current);
          next.delete(`table:${pendingAction.table.name}`);
          return next;
        });
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
    if (e.key === "Tab" && navigable.length > 0) {
      e.preventDefault();
      const dir = e.shiftKey ? -1 : 1;
      const next = selectedIdx < 0 ? 0 : (selectedIdx + dir + navigable.length) % navigable.length;
      selectTable(navigable[next], false);
    } else if (e.key === "ArrowDown" && navigable.length > 0) {
      e.preventDefault();
      selectTable(navigable[Math.min(selectedIdx + 1, navigable.length - 1)], false);
    } else if (e.key === "ArrowUp" && navigable.length > 0) {
      e.preventDefault();
      selectTable(navigable[Math.max(selectedIdx - 1, 0)], false);
    } else if (e.key === "Enter" && selectedIdx >= 0 && selectedIdx < navigable.length) {
      e.preventDefault();
      selectTable(navigable[selectedIdx]);
    }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Search input */}
      <div className="px-2 py-1.5 border-b border-border shrink-0">
        <div className="flex items-center gap-1 mb-1.5">
          {connectionType === "postgres" && <select value={schema} onChange={(event) => onSchemaChange(event.target.value)} className="min-w-0 flex-1 bg-bg-hover text-text-primary text-[11px] px-1.5 py-1 rounded border border-border outline-none" title="Schema">{schemas.map((item) => <option key={item}>{item}</option>)}</select>}
          <button onClick={onCreate} className="flex items-center gap-1 px-2 py-1 rounded border border-border text-[10px] hover:bg-bg-hover whitespace-nowrap" title="Create table"><Plus size={10} />Table</button>
          <button onClick={onImport} className="flex items-center gap-1 px-2 py-1 rounded border border-border text-[10px] hover:bg-bg-hover whitespace-nowrap" title="Import SQL dump"><Upload size={10} />Import</button>
        </div>
        <input
          ref={filterInputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Filter schema objects..."
          className="w-full bg-bg-hover text-text-primary text-[12px] font-mono placeholder-text-muted px-2 py-1 rounded outline-none focus:ring-1 focus:ring-accent/50"
        />
        {selectedTableKeys.size > 0 && (
          <div className="mt-1.5 flex items-center gap-1 border-t border-border/70 pt-1.5 text-[10px]">
            <CheckSquare size={11} className="shrink-0 text-accent" />
            <span className="min-w-0 flex-1 truncate text-text-secondary">{selectedTableKeys.size} selected</span>
            <button onClick={() => setExportOpen(true)} className="flex items-center gap-1 rounded bg-accent px-2 py-0.5 text-white hover:bg-accent-hover"><Download size={10} />Export</button>
            <button onClick={() => setSelectedTableKeys(new Set())} className="rounded px-1.5 py-0.5 text-text-muted hover:bg-bg-hover hover:text-text-primary">Clear</button>
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {loading && (
          <div className="flex items-center gap-2 px-3 py-4 text-xs text-text-muted">
            <Loader2 size={12} className="animate-spin" />
            Loading schema objects...
          </div>
        )}

        {error && (
          <div className="px-3 py-4 text-xs text-error">{error}</div>
        )}

        {!loading && !error && filtered.length === 0 && (
          <div className="px-3 py-4 text-xs text-text-muted">
            {query ? "No matches." : "No schema objects found."}
          </div>
        )}

        {!loading && !error && (!query || filtered.length > 0) && (["table", "view", "function"] as const).map((type) => (
          <ObjectGroup
            key={type}
            type={type}
            objects={grouped[type]}
            collapsed={!query && collapsedGroups.has(type)}
            selectedKey={selectedTableKey}
            selectedKeys={selectedTableKeys}
            selectionMode={selectedTableKeys.size > 0}
            objectKey={objectKey}
            onToggle={() => setCollapsedGroups((current) => {
              const next = new Set(current);
              if (next.has(type)) next.delete(type); else next.add(type);
              return next;
            })}
            onSelect={selectTable}
            onToggleSelection={toggleTableSelection}
            onToggleAll={toggleAllVisibleTables}
            onContextMenu={(object, event) => {
              event.preventDefault();
              selectTable(object, false);
              if (object.type === "table") setContextMenu({ table: { name: object.name, type: "table" }, x: event.clientX, y: event.clientY });
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
      {exportOpen && selectedTables.length > 0 && (
        <TableExportModal
          connectionId={connectionId}
          db={db}
          schema={schema}
          dialect={connectionType}
          tables={selectedTables}
          onClose={() => setExportOpen(false)}
        />
      )}
    </div>
  );
}

/* ── Grouped schema object nodes ─────────────────────────── */

function highlightMatch(name: string, indices: readonly number[]): React.ReactNode {
  if (indices.length === 0) return name;
  return matchSegments(name, indices).map((segment, i) =>
    segment.matched ? (
      <mark key={i} className="bg-accent/25 text-inherit rounded-[2px]">{segment.text}</mark>
    ) : (
      <span key={i}>{segment.text}</span>
    ),
  );
}

function ObjectGroup({
  type,
  objects,
  collapsed,
  selectedKey,
  selectedKeys,
  selectionMode,
  objectKey,
  onToggle,
  onSelect,
  onToggleSelection,
  onToggleAll,
  onContextMenu,
}: {
  type: SchemaObjectInfo["type"];
  objects: Array<SchemaObjectInfo & { indices: readonly number[] }>;
  collapsed: boolean;
  selectedKey: string | null;
  selectedKeys: Set<string>;
  selectionMode: boolean;
  objectKey: (object: SchemaObjectInfo) => string;
  onToggle: () => void;
  onSelect: (object: SchemaObjectInfo) => void;
  onToggleSelection: (object: SchemaObjectInfo) => void;
  onToggleAll: () => void;
  onContextMenu: (object: SchemaObjectInfo, event: React.MouseEvent) => void;
}) {
  const label = type === "table" ? "Tables" : type === "view" ? "Views" : "Functions";
  const icon = type === "table"
    ? <Table2 size={11} className="text-accent" />
    : type === "view"
      ? <Eye size={11} className="text-purple-400" />
      : <Code2 size={11} className="text-emerald-400" />;

  const expanded = !collapsed && objects.length > 0;
  const selectedCount = type === "table" ? objects.filter((object) => selectedKeys.has(objectKey(object))).length : 0;
  const panelClassName = !expanded
    ? "shrink-0"
    : type === "table"
      ? "flex min-h-0 flex-1 flex-col"
      : "flex max-h-[40%] shrink-0 flex-col";

  return <section className={panelClassName}>
    <div className="flex w-full shrink-0 items-center border-y border-border/70 bg-bg-secondary text-[9px] font-semibold uppercase tracking-wider text-text-muted hover:bg-bg-hover">
      {type === "table" && objects.length > 0 && (
        <button
          type="button"
          role="checkbox"
          aria-checked={selectedCount === 0 ? false : selectedCount === objects.length ? true : "mixed"}
          aria-label={selectedCount === objects.length ? "Deselect all visible tables" : "Select all visible tables"}
          onClick={onToggleAll}
          className={`ml-1.5 rounded p-0.5 transition hover:text-text-primary ${selectedCount > 0 ? "text-accent" : "text-text-muted"}`}
        >
          {selectedCount === objects.length ? <CheckSquare size={11} /> : selectedCount > 0 ? <SquareMinus size={11} /> : <Square size={11} />}
        </button>
      )}
      <button onClick={onToggle} aria-expanded={!collapsed} className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 text-left">
        {collapsed ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
        {icon}
        <span>{label}</span>
        <span className="ml-auto rounded-full bg-bg-hover px-1.5 py-px text-[8px] tabular-nums">{objects.length}</span>
      </button>
    </div>
    {expanded && (
      <div className={`min-h-0 overflow-y-auto py-0.5 ${type === "table" ? "flex-1" : ""}`}>
        {objects.map((object) => (
          <SchemaObjectNode
            key={objectKey(object)}
            object={object}
            indices={object.indices}
            selected={selectedKey === objectKey(object)}
            checked={selectedKeys.has(objectKey(object))}
            selectionMode={selectionMode}
            onSelect={(event) => {
              if (object.type === "table" && (event.metaKey || event.ctrlKey)) onToggleSelection(object);
              else onSelect(object);
            }}
            onToggleSelection={() => onToggleSelection(object)}
            onContextMenu={(event) => onContextMenu(object, event)}
          />
        ))}
      </div>
    )}
  </section>;
}

function SchemaObjectNode({
  object,
  indices = [],
  selected,
  checked,
  selectionMode,
  onSelect,
  onToggleSelection,
  onContextMenu,
}: {
  object: SchemaObjectInfo;
  indices?: readonly number[];
  selected?: boolean;
  checked: boolean;
  selectionMode: boolean;
  onSelect: (event: React.MouseEvent) => void;
  onToggleSelection: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
}) {
  const nodeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selected && nodeRef.current) {
      nodeRef.current.scrollIntoView({ block: "nearest" });
    }
  }, [selected]);

  return (
    <div
      ref={nodeRef}
      role="treeitem"
      aria-selected={selected}
      className={`group flex items-center gap-1.5 py-[3px] pr-2 pl-3 cursor-pointer transition-colors ${
        selected ? "bg-accent/20" : checked ? "bg-accent/10" : "hover:bg-bg-hover"
      }`}
      onClick={onSelect}
      onContextMenu={onContextMenu}
    >
      {object.type === "table" && (
        <button
          type="button"
          role="checkbox"
          aria-checked={checked}
          aria-label={`${checked ? "Deselect" : "Select"} ${object.name}`}
          onClick={(event) => { event.stopPropagation(); onToggleSelection(); }}
          onDoubleClick={(event) => event.stopPropagation()}
          className={`-ml-1 shrink-0 rounded p-0.5 transition hover:text-text-primary ${checked ? "text-accent" : selectionMode ? "text-text-muted" : "text-text-muted opacity-0 group-hover:opacity-100 focus:opacity-100"}`}
        >
          {checked ? <CheckSquare size={12} /> : <Square size={12} />}
        </button>
      )}
      {object.type === "view"
        ? <Eye size={14} className="shrink-0 text-purple-400" />
        : object.type === "function"
          ? <Code2 size={14} className="shrink-0 text-emerald-400" />
          : <Table2 size={14} className="shrink-0 text-accent" />
      }
      <span className="truncate text-[12px] font-mono text-text-primary">
        {highlightMatch(object.name, indices)}
        {object.type === "function" && <span className="text-text-muted">({object.signature || ""})</span>}
      </span>
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
