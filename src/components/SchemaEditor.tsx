import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, Clipboard, Columns3, KeyRound, Link2, Loader2, Pencil, Plus, RefreshCw, Save, Search, Trash2, X } from "lucide-react";
import {
  applySchemaChanges,
  fetchForeignKeys,
  fetchIndexes,
  fetchTableDdl,
  fetchTableArtifacts,
  type ColumnInfo,
  type ForeignKeyInfo,
  type IndexInfo,
} from "../lib/schema";
import {
  buildAddForeignKey,
  buildColumnMigration,
  buildCreateIndex,
  buildDropForeignKey,
  buildDropIndex,
  buildEditIndex,
  buildRenameTable,
  editableColumns,
  type EditableColumn,
} from "../lib/schemaDdl";
import { HighlightedSQL } from "../lib/highlightSQL";
import { notifySchemaChanged } from "../lib/schemaRevision";
import { fuzzySearch } from "../lib/fuzzySearch";
import { modKey } from "../lib/platform";

interface Props {
  connectionId: string;
  connectionType: "postgres" | "mysql" | "sqlite";
  db: string;
  schema: string;
  table: string;
  columns: ColumnInfo[];
  loading: boolean;
  onRefresh: () => Promise<void> | void;
  onTableRenamed?: (newName: string) => void;
  ddlOpen: boolean;
  onDdlClose: () => void;
}

interface IndexDraft {
  name: string;
  columns: string[];
  unique: boolean;
  method: string;
  predicate: string;
  includeColumns: string[];
  expressionSql: string;
}

const emptyIndex = (): IndexDraft => ({ name: "", columns: [], unique: false, method: "", predicate: "", includeColumns: [], expressionSql: "" });

export function SchemaEditor(props: Props) {
  const { connectionId, connectionType, db, schema, table, columns, loading, onRefresh, onTableRenamed, ddlOpen, onDdlClose } = props;
  const [draft, setDraft] = useState<EditableColumn[]>(() => editableColumns(columns));
  const [tableName, setTableName] = useState(table);
  const [indexes, setIndexes] = useState<IndexInfo[]>([]);
  const [foreignKeys, setForeignKeys] = useState<ForeignKeyInfo[]>([]);
  const [savedForeignKeys, setSavedForeignKeys] = useState<ForeignKeyInfo[]>([]);
  const [ddl, setDdl] = useState("");
  const [triggers, setTriggers] = useState<string[]>([]);
  const [metaLoading, setMetaLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);
  const [newIndex, setNewIndex] = useState<IndexDraft>(emptyIndex);
  const [editingIndexName, setEditingIndexName] = useState<string | null>(null);
  const [indexFormOpen, setIndexFormOpen] = useState(false);
  const [newFk, setNewFk] = useState<ForeignKeyInfo>({ name: "", column: "", columns: [], foreignSchema: schema, foreignTable: "", foreignColumn: "", foreignColumns: [], onUpdate: "NO ACTION", onDelete: "NO ACTION" });
  const [editingFkName, setEditingFkName] = useState<string | null>(null);
  const [fkFormOpen, setFkFormOpen] = useState(false);
  const [columnSearch, setColumnSearch] = useState("");
  const columnSearchRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const rightPaneRef = useRef<HTMLDivElement>(null);
  const [rightWidth, setRightWidth] = useState(360);
  const [fkHeight, setFkHeight] = useState(160);

  const original = useMemo(() => editableColumns(columns), [columns]);
  useEffect(() => setDraft(original), [original]);

  const loadMetadata = useCallback(async () => {
    setMetaLoading(true);
    setError(null);
    try {
      const [nextIndexes, nextFks, nextDdl, nextArtifacts] = await Promise.all([
        fetchIndexes(connectionId, db, schema, table),
        fetchForeignKeys(connectionId, db, schema, table),
        fetchTableDdl(connectionId, db, schema, table),
        fetchTableArtifacts(connectionId, db, schema, table),
      ]);
      setIndexes(nextIndexes);
      setForeignKeys(nextFks);
      setSavedForeignKeys(nextFks);
      setDdl(nextDdl);
      setTriggers(nextArtifacts.triggers);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMetaLoading(false);
    }
  }, [connectionId, db, schema, table]);

  useEffect(() => { void loadMetadata(); }, [loadMetadata]);

  // Cmd+F opens column search, but only for the structure editor that is
  // actually visible (offsetParent is null while an inactive tab is display:none).
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!((event.metaKey || event.ctrlKey) && event.key === "f")) return;
      if (!rootRef.current || rootRef.current.offsetParent === null) return;
      event.preventDefault();
      columnSearchRef.current?.focus();
      setTimeout(() => columnSearchRef.current?.select(), 30);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const columnMatchIds = useMemo(() => {
    const query = columnSearch.trim();
    if (!query) return null;
    const matched = new Set(fuzzySearch(draft.map((column) => column.name), query));
    return new Set(draft.filter((column) => matched.has(column.name)).map((column) => column.id));
  }, [columnSearch, draft]);

  const clearColumnSearch = useCallback(() => setColumnSearch(""), []);

  const runStatements = useCallback(async (statements: string[]) => {
    if (statements.length === 0) return;
    setWorking(true);
    setError(null);
    try {
      await applySchemaChanges(connectionId, db, statements, connectionType === "sqlite");
      setPreview(null);
      notifySchemaChanged(connectionId);
      setEditingIndexName(null);
      setIndexFormOpen(false);
      setNewIndex(emptyIndex());
      setEditingFkName(null);
      setFkFormOpen(false);
      setNewFk({ name: "", column: "", columns: [], foreignSchema: schema, foreignTable: "", foreignColumn: "", foreignColumns: [], onUpdate: "NO ACTION", onDelete: "NO ACTION" });
      const renamed = tableName.trim().length > 0 && tableName.trim() !== table;
      if (renamed && onTableRenamed) {
        // The parent repoints the open tab to the new name, which remounts this
        // editor and loads fresh metadata — refetching the old name would fail.
        onTableRenamed(tableName.trim());
        return;
      }
      await onRefresh();
      await loadMetadata();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  }, [connectionId, connectionType, db, table, loadMetadata, onRefresh, tableName, onTableRenamed]);

  const propose = (factory: () => string[]) => {
    try {
      setError(null);
      const statements = factory();
      if (!statements.length) {
        setError("No schema changes to apply.");
        return false;
      }
      setPreview(statements);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
  };

  const tableRenamePending = tableName.trim().length > 0 && tableName.trim() !== table;
  const columnStatements = () => {
    const statements = buildColumnMigration({ dialect: connectionType, db, schema, table, original, columns: draft, foreignKeys, originalForeignKeys: savedForeignKeys, indexes, originalDdl: ddl, triggers });
    // Rename runs last so column migrations still reference the current table name.
    if (tableRenamePending) statements.push(buildRenameTable(connectionType, db, schema, table, tableName));
    return statements;
  };
  const dirty = JSON.stringify(original) !== JSON.stringify(draft) || tableRenamePending;
  const foreignKeysDirty = JSON.stringify(savedForeignKeys) !== JSON.stringify(foreignKeys);
  const reviewIndex = () => propose(() => {
    return editingIndexName
      ? buildEditIndex(connectionType, db, schema, table, editingIndexName, newIndex.name, newIndex.columns, newIndex.unique, newIndex)
      : [buildCreateIndex(connectionType, db, schema, table, newIndex.name, newIndex.columns, newIndex.unique, newIndex)];
  });
  const closeIndexForm = () => { setIndexFormOpen(false); setEditingIndexName(null); setNewIndex(emptyIndex()); };
  const closeFkForm = () => { setFkFormOpen(false); setEditingFkName(null); setNewFk({ name: "", column: "", columns: [], foreignSchema: schema, foreignTable: "", foreignColumn: "", foreignColumns: [], onUpdate: "NO ACTION", onDelete: "NO ACTION" }); };
  const submitForeignKey = () => {
    const localColumns = newFk.columns?.filter(Boolean) ?? [];
    const remoteColumns = newFk.foreignColumns?.filter(Boolean) ?? [];
    if (!newFk.name.trim() || localColumns.length === 0 || !newFk.foreignTable.trim() || remoteColumns.length === 0 || localColumns.length !== remoteColumns.length) {
      setError("Constraint name and matching local/referenced columns are required.");
      return false;
    }
    if (connectionType === "sqlite") {
      setForeignKeys((current) => editingFkName ? current.map((fk) => fk.name === editingFkName ? newFk : fk) : [...current, newFk]);
      closeFkForm();
      return true;
    }
    return propose(() => editingFkName ? [buildDropForeignKey(connectionType, db, schema, table, editingFkName), buildAddForeignKey(connectionType, db, schema, table, newFk)] : [buildAddForeignKey(connectionType, db, schema, table, newFk)]);
  };

  const startVerticalResize = (event: React.MouseEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = rightWidth;
    document.body.classList.add("is-resizing");
    const onMove = (moveEvent: MouseEvent) => {
      const totalWidth = workspaceRef.current?.clientWidth ?? 900;
      const maxWidth = Math.max(280, totalWidth - 420);
      setRightWidth(Math.max(280, Math.min(maxWidth, startWidth + startX - moveEvent.clientX)));
    };
    const onUp = () => {
      document.body.classList.remove("is-resizing");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const startHorizontalResize = (event: React.MouseEvent) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = fkHeight;
    document.body.classList.add("is-resizing");
    const onMove = (moveEvent: MouseEvent) => {
      const totalHeight = rightPaneRef.current?.clientHeight ?? 500;
      const maxHeight = Math.max(100, totalHeight - 160);
      // Handle sits above the (now fixed-height) Foreign Keys pane, so dragging
      // down should shrink it and let Indexes (flex-1) grow — inverse of the
      // vertical/index-height convention this was ported from.
      setFkHeight(Math.max(100, Math.min(maxHeight, startHeight - (moveEvent.clientY - startY))));
    };
    const onUp = () => {
      document.body.classList.remove("is-resizing");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  if (loading) return <Centered><Loader2 size={14} className="animate-spin" /> Loading structure…</Centered>;
  if (!columns.length) return <Centered>No column information available.</Centered>;

  return (
    <div ref={rootRef} className="relative flex flex-col h-full min-h-0">
      {error && <div className="flex items-center justify-between px-3 py-2 text-xs text-error bg-error/10 border-b border-error/20"><span>{error}</span><button onClick={() => setError(null)}><X size={12} /></button></div>}
      <div ref={workspaceRef} className="flex flex-1 min-h-0 overflow-hidden">
        <section className="flex flex-col flex-1 min-w-0 min-h-0">
          <div className="flex items-center gap-1.5 h-9 px-2.5 border-b border-border bg-bg-secondary shrink-0 text-[11px] font-semibold text-text-secondary">
            <Columns3 size={12} className="shrink-0" />
            <input
              value={tableName}
              onChange={(event) => setTableName(event.target.value)}
              spellCheck={false}
              placeholder="table name"
              title="Edit to rename this table, then Review"
              aria-label="Table name"
              className={`min-w-0 w-9/12 max-w-150 px-1.5 py-0.5 rounded border bg-bg-primary font-mono text-[12px] text-text-primary outline-none transition-colors focus:border-accent ${tableRenamePending ? "border-warning" : "border-border"}`}
            />
            {tableRenamePending && <span className="shrink-0 text-[10px] font-semibold text-warning">will rename</span>}
            <div className="flex-1" />
            <div className="relative flex items-center w-44 shrink-0">
              <Search size={11} className="absolute left-1.5 text-text-muted pointer-events-none" />
              <input
                ref={columnSearchRef}
                value={columnSearch}
                onChange={(event) => setColumnSearch(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); clearColumnSearch(); event.currentTarget.blur(); } }}
                placeholder={`Search columns… (${modKey("F")})`}
                aria-label="Search columns"
                className="w-full pl-6 pr-6 py-1 rounded border border-border bg-bg-primary font-normal text-[11px] text-text-primary outline-none focus:border-accent"
              />
              {columnSearch.trim() && (
                <button onClick={clearColumnSearch} title="Clear search (Esc)" className="absolute right-1 p-0.5 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover cursor-pointer"><X size={11} /></button>
              )}
            </div>
            <button onClick={() => { void onRefresh(); void loadMetadata(); }} className="p-1.5 rounded text-text-muted hover:bg-bg-hover cursor-pointer" title="Refresh schema"><RefreshCw size={12} /></button>
            <button disabled={!dirty || working} onClick={() => propose(columnStatements)} className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-accent text-white text-[11px] disabled:opacity-30 cursor-pointer"><Save size={11} />Review</button>
          </div>
          <div className="flex-1 min-h-0 overflow-auto"><ColumnsEditor columns={draft} dialect={connectionType} onChange={setDraft} matchIds={columnMatchIds} /></div>
        </section>

        <div onMouseDown={startVerticalResize} className="group relative w-[5px] shrink-0 cursor-col-resize bg-bg-secondary"><div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border group-hover:bg-accent/60" /></div>

        <aside ref={rightPaneRef} className="flex flex-col min-h-0 shrink-0" style={{ width: rightWidth }}>
          <section className="flex flex-col flex-1 min-h-0">
            <PaneHeader icon={<KeyRound size={12} />} title="Indexes" count={indexes.length}>
              <button onClick={() => { setError(null); setEditingIndexName(null); setNewIndex(emptyIndex()); setIndexFormOpen(true); }} className="flex items-center gap-1 px-2 py-1 rounded bg-accent text-white text-[10px] cursor-pointer"><Plus size={10} />Add</button>
            </PaneHeader>
            <div className="flex-1 min-h-0 overflow-auto"><IndexesEditor indexes={indexes} loading={metaLoading} editingIndexName={editingIndexName} onEdit={(index) => { setError(null); setEditingIndexName(index.name); setNewIndex({ name: index.name, columns: [...index.columns], unique: index.unique, method: index.method ?? "", predicate: index.predicate ?? "", includeColumns: [...(index.includeColumns ?? [])], expressionSql: index.expressionSql ?? "" }); setIndexFormOpen(true); }} onDrop={(name) => propose(() => [buildDropIndex(connectionType, db, schema, table, name)])} /></div>
          </section>

          <div onMouseDown={startHorizontalResize} className="group relative h-[5px] shrink-0 cursor-row-resize bg-bg-secondary"><div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border group-hover:bg-accent/60" /></div>

          <section className="flex flex-col min-h-0" style={{ height: fkHeight }}>
            <PaneHeader icon={<Link2 size={12} />} title="Foreign Keys" count={foreignKeys.length}>
              {connectionType === "sqlite" && <button disabled={!foreignKeysDirty || working} onClick={() => propose(columnStatements)} className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-accent text-white text-[11px] disabled:opacity-30 cursor-pointer"><Save size={11} />Review</button>}
              <button onClick={() => { setError(null); setEditingFkName(null); setNewFk({ name: "", column: "", columns: [], foreignSchema: schema, foreignTable: "", foreignColumn: "", foreignColumns: [], onUpdate: "NO ACTION", onDelete: "NO ACTION" }); setFkFormOpen(true); }} className="flex items-center gap-1 px-2 py-1 rounded bg-accent text-white text-[10px] cursor-pointer"><Plus size={10} />Add</button>
            </PaneHeader>
            <div className="flex-1 min-h-0 overflow-auto"><ForeignKeysEditor foreignKeys={foreignKeys} loading={metaLoading} editingFkName={editingFkName} onEdit={(fk) => { setError(null); setEditingFkName(fk.name); setNewFk({ ...fk, columns: [...(fk.columns ?? [fk.column])], foreignColumns: [...(fk.foreignColumns ?? [fk.foreignColumn])] }); setFkFormOpen(true); }} onDrop={(name) => {
              if (connectionType === "sqlite") setForeignKeys((current) => current.filter((fk) => fk.name !== name));
              else propose(() => [buildDropForeignKey(connectionType, db, schema, table, name)]);
            }} /></div>
          </section>
        </aside>
      </div>

      {ddlOpen && <DdlViewModal ddl={ddl} copied={copied} onCopy={async () => { await navigator.clipboard.writeText(ddl); setCopied(true); setTimeout(() => setCopied(false), 1200); }} onClose={onDdlClose} />}
      {indexFormOpen && <IndexFormModal dialect={connectionType} columns={draft.map((column) => column.name)} value={newIndex} error={error} onChange={setNewIndex} editingIndexName={editingIndexName} onClose={closeIndexForm} onSubmit={() => { if (reviewIndex()) setIndexFormOpen(false); }} />}
      {fkFormOpen && <ForeignKeyFormModal columns={draft.map((column) => column.name)} value={newFk} error={error} onChange={setNewFk} editingFkName={editingFkName} onClose={closeFkForm} onSubmit={() => { if (submitForeignKey() && connectionType !== "sqlite") setFkFormOpen(false); }} />}
      {preview && <DdlConfirm statements={preview} working={working} onCancel={() => setPreview(null)} onConfirm={() => void runStatements(preview)} />}
    </div>
  );
}

function PaneHeader({ icon, title, count, children }: { icon: React.ReactNode; title: string; count?: number; children?: React.ReactNode }) {
  return <div className="flex items-center gap-1.5 h-9 px-2.5 border-b border-border bg-bg-secondary shrink-0 text-[11px] font-semibold text-text-secondary">
    {icon}<span>{title}</span>{count !== undefined && <span className="px-1.5 py-0.5 rounded-full bg-bg-hover text-[9px] text-text-muted">{count}</span>}<div className="flex-1" />{children}
  </div>;
}

function DdlViewModal({ ddl, copied, onCopy, onClose }: { ddl: string; copied: boolean; onCopy: () => void; onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  return <div onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} className="absolute inset-0 z-50 flex items-center justify-center bg-black/55 p-6">
    <div className="w-full max-w-4xl max-h-full flex flex-col rounded-lg border border-border bg-bg-primary shadow-2xl">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border"><span className="text-sm font-semibold">Table DDL</span><div className="flex-1" /><button onClick={onCopy} className="flex items-center gap-1 px-2 py-1 rounded border border-border bg-bg-secondary text-[11px] cursor-pointer">{copied ? <Check size={11} /> : <Clipboard size={11} />}{copied ? "Copied" : "Copy"}</button><button onClick={onClose} className="p-1 rounded hover:bg-bg-hover"><X size={14} /></button></div>
      <pre className="p-4 overflow-auto text-[12px] leading-5 font-mono whitespace-pre-wrap selectable"><HighlightedSQL sql={ddl || "-- DDL unavailable"} /></pre>
    </div>
  </div>;
}

const COLUMN_TYPES = {
  postgres: ["smallint", "integer", "bigint", "numeric", "decimal", "real", "double precision", "boolean", "char", "varchar", "text", "date", "time", "timestamp", "timestamptz", "interval", "uuid", "json", "jsonb", "bytea", "inet", "serial", "bigserial"],
  mysql: ["tinyint", "smallint", "mediumint", "int", "bigint", "decimal", "float", "double", "boolean", "char", "varchar", "text", "mediumtext", "longtext", "date", "time", "datetime", "timestamp", "year", "json", "binary", "varbinary", "blob", "enum"],
  sqlite: ["INTEGER", "REAL", "TEXT", "BLOB", "NUMERIC"],
} as const;

function ColumnsEditor({ columns, dialect, onChange, matchIds }: { columns: EditableColumn[]; dialect: "postgres" | "mysql" | "sqlite"; onChange: (columns: EditableColumn[]) => void; matchIds?: Set<string> | null }) {
  const typeListId = useId();
  const update = (id: string, patch: Partial<EditableColumn>) => onChange(columns.map((column) => column.id === id ? { ...column, ...patch } : column));
  const move = (index: number, direction: -1 | 1) => { const next = [...columns]; const target = index + direction; if (target < 0 || target >= next.length) return; [next[index], next[target]] = [next[target], next[index]]; onChange(next); };
  return <div className="min-w-[1040px]">
    <div className="grid grid-cols-[44px_minmax(140px,1fr)_minmax(150px,1fr)_minmax(140px,1fr)_70px_54px_58px_minmax(170px,1fr)_minmax(140px,1fr)_48px] sticky top-0 z-10 bg-bg-secondary border-b border-border text-[10px] uppercase tracking-wider text-text-muted font-semibold">
      {['#','Column','Type','Default','Nullable','PK','Unique','Extra / identity / generated','Comment',''].map((label) => <div key={label} className="px-2 py-2 border-r border-border">{label}</div>)}
    </div>
    {columns.map((column, index) => <div key={column.id} className={`grid grid-cols-[44px_minmax(140px,1fr)_minmax(150px,1fr)_minmax(140px,1fr)_70px_54px_58px_minmax(170px,1fr)_minmax(140px,1fr)_48px] border-b border-border hover:bg-bg-hover/40 text-[12px] ${matchIds && !matchIds.has(column.id) ? "hidden" : ""}`}>
      <div className="px-2 py-1.5 border-r border-border text-text-muted flex flex-col items-center"><button disabled={dialect === "postgres"} title={dialect === "postgres" ? "PostgreSQL cannot safely reorder physical columns" : "Move up"} onClick={() => move(index, -1)} className="leading-3 disabled:opacity-20">▲</button><button disabled={dialect === "postgres"} title={dialect === "postgres" ? "PostgreSQL cannot safely reorder physical columns" : "Move down"} onClick={() => move(index, 1)} className="leading-3 disabled:opacity-20">▼</button></div>
      <CellInput value={column.name} onChange={(name) => update(column.id, { name })} />
      <TypeInput value={column.type} listId={typeListId} onChange={(type) => update(column.id, { type })} />
      <CellInput value={column.defaultValue} placeholder="No default" onChange={(defaultValue) => update(column.id, { defaultValue })} />
      <CellCheck checked={column.nullable} onChange={(nullable) => update(column.id, { nullable })} />
      <CellCheck checked={column.isPk} onChange={(isPk) => update(column.id, { isPk })} />
      <CellCheck checked={column.unique ?? false} onChange={(unique) => update(column.id, { unique })} />
      <CellInput value={column.extra ?? ""} placeholder="Optional SQL clauses" onChange={(extra) => update(column.id, { extra })} />
      <CellInput value={column.comment ?? ""} placeholder={dialect === "sqlite" ? "Not supported" : "Column comment"} onChange={(comment) => update(column.id, { comment })} />
      <div className="flex items-center justify-center"><button onClick={() => onChange(columns.filter((item) => item.id !== column.id))} className="p-1 text-text-muted hover:text-error cursor-pointer"><Trash2 size={12} /></button></div>
    </div>)}
    <datalist id={typeListId}>{COLUMN_TYPES[dialect].map((type) => <option key={type} value={type} />)}</datalist>
    <button onClick={() => onChange([...columns, { id: `new-${crypto.randomUUID()}`, originalName: null, name: "", type: dialect === "postgres" ? "text" : dialect === "mysql" ? "varchar(255)" : "TEXT", nullable: true, defaultValue: "", isPk: false, unique: false, extra: "", comment: "" }])} className="flex items-center gap-1.5 m-2 px-2.5 py-1.5 rounded border border-border hover:bg-bg-hover text-[11px] cursor-pointer"><Plus size={11} />Add column</button>
  </div>;
}

function IndexesEditor({ indexes, loading, editingIndexName, onEdit, onDrop }: { indexes: IndexInfo[]; loading: boolean; editingIndexName: string | null; onEdit: (index: IndexInfo) => void; onDrop: (name: string) => void }) {
  return <Manager loading={loading} empty="No indexes found.">
    {indexes.length ? indexes.map((index) => <ManagerRow key={index.name} title={index.name} badge={index.unique ? "UNIQUE" : undefined} detail={index.columns.join(", ")} protectedItem={index.primary} active={editingIndexName === index.name} onEdit={() => onEdit(index)} onDrop={() => onDrop(index.name)} />) : null}
  </Manager>;
}

function ForeignKeysEditor({ foreignKeys, loading, editingFkName, onEdit, onDrop }: { foreignKeys: ForeignKeyInfo[]; loading: boolean; editingFkName: string | null; onEdit: (fk: ForeignKeyInfo) => void; onDrop: (name: string) => void }) {
  return <Manager loading={loading} empty="No foreign keys found.">
    {foreignKeys.length ? foreignKeys.map((fk) => <ManagerRow key={fk.name} title={fk.name} detail={`${(fk.columns ?? [fk.column]).join(", ")} → ${fk.foreignSchema ? `${fk.foreignSchema}.` : ""}${fk.foreignTable}(${(fk.foreignColumns ?? [fk.foreignColumn]).join(", ")}) · ${fk.onUpdate ?? "NO ACTION"}/${fk.onDelete ?? "NO ACTION"}`} active={editingFkName === fk.name} onEdit={() => onEdit(fk)} onDrop={() => onDrop(fk.name)} />) : null}
  </Manager>;
}

function EditorFormModal({ title, error, children, onClose }: { title: string; error: string | null; children: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);
  return <div role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} className="fixed inset-0 z-[240] flex items-center justify-center bg-black/55 p-6">
    <div className="w-full max-w-xl max-h-full overflow-auto rounded-lg border border-border bg-bg-primary shadow-2xl">
      <div className="sticky top-0 z-10 flex items-center gap-2 px-4 py-3 border-b border-border bg-bg-primary"><span className="text-sm font-semibold">{title}</span><div className="flex-1" /><button onClick={onClose} className="p-1 rounded hover:bg-bg-hover cursor-pointer" aria-label="Close"><X size={14} /></button></div>
      {error && <div className="px-4 py-2 text-xs text-error bg-error/10 border-b border-error/20">{error}</div>}
      {children}
    </div>
  </div>;
}

/** Type-to-filter column picker rendered as removable pills, backed only by
 *  real column names — free text is never committed, so there's no way to
 *  end up with a half-typed, invalid column in the list. */
function ColumnPillsInput({ columns, selected, onChange, placeholder }: { columns: string[]; selected: string[]; onChange: (next: string[]) => void; placeholder?: string }) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [open, setOpen] = useState(false);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 0 });
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const activeRowRef = useRef<HTMLDivElement>(null);

  const available = columns.filter((column) => !selected.includes(column));
  const suggestions = query ? fuzzySearch(available, query).slice(0, 12) : available.slice(0, 12);

  useEffect(() => {
    if (open) activeRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  const positionDropdown = () => {
    const rect = boxRef.current?.getBoundingClientRect();
    if (rect) setDropdownPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
  };

  const addColumn = (column: string) => {
    onChange([...selected, column]);
    setQuery("");
    setActiveIndex(0);
    inputRef.current?.focus();
  };

  const removeColumn = (column: string) => onChange(selected.filter((c) => c !== column));

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (open && suggestions.length > 0) {
      if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex((i) => Math.min(suggestions.length - 1, i + 1)); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((i) => Math.max(0, i - 1)); return; }
      if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); addColumn(suggestions[activeIndex]); return; }
      if (event.key === "Escape") { event.stopPropagation(); setOpen(false); return; }
    }
    if (event.key === "Backspace" && query === "" && selected.length > 0) {
      onChange(selected.slice(0, -1));
    }
  };

  return (
    <div
      ref={boxRef}
      onClick={() => inputRef.current?.focus()}
      className="input-field flex flex-wrap items-center gap-1 min-h-9 py-1 cursor-text"
    >
      {selected.map((column) => (
        <span key={column} className="flex items-center gap-1 pl-2 pr-1 py-0.5 rounded bg-accent/15 text-accent text-[11px] font-mono">
          {column}
          <button type="button" onClick={(event) => { event.stopPropagation(); removeColumn(column); }} className="p-0.5 rounded hover:bg-accent/25 cursor-pointer">
            <X size={10} />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); setOpen(true); positionDropdown(); }}
        onFocus={() => { setOpen(true); positionDropdown(); }}
        onKeyDown={handleKeyDown}
        onBlur={() => setTimeout(() => setOpen(false), 100)}
        placeholder={selected.length === 0 ? placeholder : ""}
        className="flex-1 min-w-[80px] bg-transparent outline-none text-[11px] font-mono px-1 py-0.5"
      />
      {open && suggestions.length > 0 && (
        <div
          className="fixed z-[9999] max-h-[190px] border border-border rounded bg-bg-primary shadow-xl overflow-y-auto py-0.5"
          style={{ top: dropdownPos.top, left: dropdownPos.left, width: Math.max(160, dropdownPos.width) }}
        >
          {suggestions.map((column, index) => (
            <div
              key={column}
              ref={index === activeIndex ? activeRowRef : undefined}
              onMouseEnter={() => setActiveIndex(index)}
              onMouseDown={(event) => { event.preventDefault(); addColumn(column); }}
              className={`px-2.5 py-1 text-[11px] font-mono cursor-pointer transition-colors truncate ${index === activeIndex ? "bg-accent/15 text-accent" : "text-text-secondary hover:bg-bg-hover"}`}
            >
              {column}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function IndexFormModal({ dialect, columns, value, error, onChange, editingIndexName, onClose, onSubmit }: { dialect: "postgres" | "mysql" | "sqlite"; columns: string[]; value: IndexDraft; error: string | null; onChange: (value: IndexDraft) => void; editingIndexName: string | null; onClose: () => void; onSubmit: () => void }) {
  return <EditorFormModal title={editingIndexName ? "Edit index" : "Add index"} error={error} onClose={onClose}>
    <div className="flex flex-col gap-3 p-4">
      <SmallInput value={value.name} placeholder="Index name" onChange={(name) => onChange({ ...value, name })} />
      <ColumnPillsInput columns={columns} selected={value.columns} onChange={(next) => onChange({ ...value, columns: next })} placeholder="Add column…" />
      <SmallInput value={value.expressionSql} placeholder="Expression SQL (optional, e.g. lower(email))" onChange={(expressionSql) => onChange({ ...value, expressionSql })} />
      {dialect !== "sqlite" && <SmallInput value={value.method} placeholder={dialect === "postgres" ? "Method (btree, hash, gin, gist…)" : "Method (BTREE or HASH)"} onChange={(method) => onChange({ ...value, method })} />}
      {dialect === "postgres" && <ColumnPillsInput columns={columns.filter((column) => !value.columns.includes(column))} selected={value.includeColumns} onChange={(next) => onChange({ ...value, includeColumns: next })} placeholder="INCLUDE columns (optional)…" />}
      {dialect !== "mysql" && <SmallInput value={value.predicate} placeholder="Partial index WHERE predicate" onChange={(predicate) => onChange({ ...value, predicate })} />}
      <div className="flex items-center gap-2">
        <label className={`flex items-center gap-2 px-3 py-1.5 rounded-md border cursor-pointer transition-colors select-none ${value.unique ? "border-accent bg-accent/10 text-accent" : "border-border text-text-secondary hover:bg-bg-hover"}`}>
          <input type="checkbox" checked={value.unique} onChange={(event) => onChange({ ...value, unique: event.target.checked })} className="w-4 h-4 accent-accent cursor-pointer" />
          <span className="text-[12px] font-semibold">Unique</span>
        </label>
        <div className="flex-1" />
        <button onClick={onClose} className="px-3 py-1.5 rounded border border-border text-xs cursor-pointer">Cancel</button>
        <button onClick={onSubmit} className="flex items-center gap-1.5 px-3 py-1.5 bg-accent text-white rounded text-xs cursor-pointer">{editingIndexName ? <Save size={11} /> : <Plus size={11} />}{editingIndexName ? "Review update" : "Add index"}</button>
      </div>
    </div>
  </EditorFormModal>;
}

function ForeignKeyFormModal({ columns, value, error, onChange, editingFkName, onClose, onSubmit }: { columns: string[]; value: ForeignKeyInfo; error: string | null; onChange: (value: ForeignKeyInfo) => void; editingFkName: string | null; onClose: () => void; onSubmit: () => void }) {
  const actions = ["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"];
  return <EditorFormModal title={editingFkName ? "Edit foreign key" : "Add foreign key"} error={error} onClose={onClose}>
    <div className="grid grid-cols-2 gap-3 p-4">
      <div className="col-span-2"><SmallInput value={value.name} placeholder="Constraint name" onChange={(name) => onChange({ ...value, name })} /></div>
      <select multiple value={value.columns ?? []} onChange={(event) => { const selected = Array.from(event.target.selectedOptions, (option) => option.value); onChange({ ...value, columns: selected, column: selected[0] ?? "" }); }} className="input-field h-24">{columns.map((column) => <option key={column}>{column}</option>)}</select>
      <SmallInput value={value.foreignSchema} placeholder="Schema / database" onChange={(foreignSchema) => onChange({ ...value, foreignSchema })} />
      <SmallInput value={value.foreignTable} placeholder="Referenced table" onChange={(foreignTable) => onChange({ ...value, foreignTable })} />
      <input value={(value.foreignColumns ?? []).join(", ")} placeholder="Referenced columns, comma separated" onChange={(event) => { const selected = event.target.value.split(",").map((item) => item.trim()).filter(Boolean); onChange({ ...value, foreignColumns: selected, foreignColumn: selected[0] ?? "" }); }} className="input-field" />
      <select value={value.onUpdate ?? "NO ACTION"} onChange={(event) => onChange({ ...value, onUpdate: event.target.value })} className="input-field" title="ON UPDATE">{actions.map((action) => <option key={action}>{action}</option>)}</select>
      <select value={value.onDelete ?? "NO ACTION"} onChange={(event) => onChange({ ...value, onDelete: event.target.value })} className="input-field" title="ON DELETE">{actions.map((action) => <option key={action}>{action}</option>)}</select>
      <div className="col-span-2 flex justify-end gap-2"><button onClick={onClose} className="px-3 py-1.5 rounded border border-border text-xs cursor-pointer">Cancel</button><button onClick={onSubmit} className="flex items-center gap-1.5 px-3 py-1.5 bg-accent text-white rounded text-xs cursor-pointer">{editingFkName ? <Save size={12} /> : <Plus size={12} />}{editingFkName ? "Review update" : "Add foreign key"}</button></div>
    </div>
  </EditorFormModal>;
}

function Manager({ children, loading, empty }: { children: React.ReactNode; loading: boolean; empty: string }) { return <div>{loading ? <Centered><Loader2 size={13} className="animate-spin" />Loading…</Centered> : children || <Centered>{empty}</Centered>}</div>; }
function ManagerRow({ title, detail, badge, protectedItem, active, onEdit, onDrop }: { title: string; detail: string; badge?: string; protectedItem?: boolean; active?: boolean; onEdit?: () => void; onDrop: () => void }) { return <div className={`flex items-center px-3 py-2 border-b border-border ${active ? "bg-accent/10" : ""}`}><div className="flex-1 min-w-0"><div className="text-xs font-medium truncate">{title}</div><div className="flex items-center gap-1.5 mt-0.5 min-w-0">{badge && <span className="shrink-0 px-1 py-px rounded text-[9px] font-bold tracking-wide bg-accent/15 text-accent">{badge}</span>}<div className="text-[11px] font-mono text-text-muted truncate">{detail}</div></div></div>{!protectedItem && onEdit && <button onClick={onEdit} className="p-1.5 text-text-muted hover:text-text-primary" title="Edit index"><Pencil size={12} /></button>}{!protectedItem && <button onClick={onDrop} className="p-1.5 text-text-muted hover:text-error"><Trash2 size={12} /></button>}</div>; }
function CellInput({ value, placeholder, onChange }: { value: string; placeholder?: string; onChange: (value: string) => void }) { return <div className="border-r border-border p-1"><input value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} className="w-full h-full px-2 py-1 bg-transparent outline-none focus:bg-bg-primary focus:ring-1 focus:ring-accent/50 rounded font-mono" /></div>; }
function TypeInput({ value, listId, onChange }: { value: string; listId: string; onChange: (value: string) => void }) { return <div className="border-r border-border p-1"><input list={listId} value={value} onChange={(event) => onChange(event.target.value)} className="w-full h-full px-2 py-1 bg-transparent outline-none focus:bg-bg-primary focus:ring-1 focus:ring-accent/50 rounded font-mono" /></div>; }
function SmallInput({ value, placeholder, onChange }: { value: string; placeholder: string; onChange: (value: string) => void }) { return <input value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} className="input-field" />; }
function CellCheck({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) { return <label className="border-r border-border flex items-center justify-center"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /></label>; }
function Centered({ children }: { children: React.ReactNode }) { return <div className="flex items-center justify-center gap-2 h-32 text-sm text-text-muted">{children}</div>; }

function DdlConfirm({ statements, working, onCancel, onConfirm }: { statements: string[]; working: boolean; onCancel: () => void; onConfirm: () => void }) {
  const [copied, setCopied] = useState(false);
  const text = statements.map((sql) => `${sql};`).join("\n\n");
  return <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/55 p-6"><div className="w-full max-w-3xl max-h-full flex flex-col rounded-lg border border-border bg-bg-primary shadow-2xl"><div className="flex items-center px-4 py-3 border-b border-border"><div><div className="text-sm font-semibold">Review schema changes</div><div className="text-[11px] text-warning mt-0.5">DDL changes can destroy data. Verify every statement before applying.</div></div><div className="ml-auto flex items-center gap-1"><button onClick={async () => { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1200); }} className="flex items-center gap-1 px-2 py-1 rounded border border-border text-[11px]">{copied ? <Check size={11} /> : <Clipboard size={11} />}{copied ? "Copied" : "Copy"}</button><button onClick={onCancel} className="p-1"><X size={14} /></button></div></div><pre className="p-4 overflow-auto text-[12px] leading-5 font-mono whitespace-pre-wrap"><HighlightedSQL sql={text} /></pre><div className="flex justify-end gap-2 px-4 py-3 border-t border-border"><button onClick={onCancel} className="px-3 py-1.5 rounded border border-border text-xs">Cancel</button><button disabled={working} onClick={onConfirm} className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-error text-white text-xs disabled:opacity-50">{working ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}Apply DDL</button></div></div></div>;
}
