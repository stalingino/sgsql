import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, Clipboard, Columns3, KeyRound, Link2, Loader2, Pencil, Plus, RefreshCw, Save, Trash2, X } from "lucide-react";
import {
  executeQuery,
  fetchForeignKeys,
  fetchIndexes,
  fetchTableDdl,
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
  editableColumns,
  type EditableColumn,
} from "../lib/schemaDdl";
import { HighlightedSQL } from "../lib/highlightSQL";

interface Props {
  connectionId: string;
  connectionType: "postgres" | "mysql" | "sqlite";
  db: string;
  schema: string;
  table: string;
  columns: ColumnInfo[];
  loading: boolean;
  onRefresh: () => Promise<void> | void;
  ddlOpen: boolean;
  onDdlClose: () => void;
}

export function SchemaEditor(props: Props) {
  const { connectionId, connectionType, db, schema, table, columns, loading, onRefresh, ddlOpen, onDdlClose } = props;
  const [draft, setDraft] = useState<EditableColumn[]>(() => editableColumns(columns));
  const [indexes, setIndexes] = useState<IndexInfo[]>([]);
  const [foreignKeys, setForeignKeys] = useState<ForeignKeyInfo[]>([]);
  const [savedForeignKeys, setSavedForeignKeys] = useState<ForeignKeyInfo[]>([]);
  const [ddl, setDdl] = useState("");
  const [metaLoading, setMetaLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);
  const [newIndex, setNewIndex] = useState({ name: "", columns: [] as string[], unique: false });
  const [editingIndexName, setEditingIndexName] = useState<string | null>(null);
  const [newFk, setNewFk] = useState<ForeignKeyInfo>({ name: "", column: "", foreignSchema: schema, foreignTable: "", foreignColumn: "" });
  const workspaceRef = useRef<HTMLDivElement>(null);
  const rightPaneRef = useRef<HTMLDivElement>(null);
  const [rightWidth, setRightWidth] = useState(360);
  const [indexHeight, setIndexHeight] = useState(240);

  const original = useMemo(() => editableColumns(columns), [columns]);
  useEffect(() => setDraft(original), [original]);

  const loadMetadata = useCallback(async () => {
    setMetaLoading(true);
    setError(null);
    try {
      const [nextIndexes, nextFks, nextDdl] = await Promise.all([
        fetchIndexes(connectionId, db, schema, table),
        fetchForeignKeys(connectionId, db, schema, table),
        fetchTableDdl(connectionId, db, schema, table),
      ]);
      setIndexes(nextIndexes);
      setForeignKeys(nextFks);
      setSavedForeignKeys(nextFks);
      setDdl(nextDdl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMetaLoading(false);
    }
  }, [connectionId, db, schema, table]);

  useEffect(() => { void loadMetadata(); }, [loadMetadata]);

  const runStatements = useCallback(async (statements: string[]) => {
    if (statements.length === 0) return;
    setWorking(true);
    setError(null);
    try {
      for (const sql of statements) await executeQuery(connectionId, sql, db);
      setPreview(null);
      setEditingIndexName(null);
      setNewIndex({ name: "", columns: [], unique: false });
      await onRefresh();
      await loadMetadata();
    } catch (cause) {
      if (connectionType === "sqlite" && statements.includes("BEGIN IMMEDIATE")) {
        try { await executeQuery(connectionId, "ROLLBACK", db); } catch { /* no active transaction */ }
        try { await executeQuery(connectionId, "PRAGMA foreign_keys = ON", db); } catch { /* connection may be lost */ }
      }
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  }, [connectionId, connectionType, db, loadMetadata, onRefresh]);

  const propose = (factory: () => string[]) => {
    try {
      setError(null);
      const statements = factory();
      if (!statements.length) setError("No schema changes to apply.");
      else setPreview(statements);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const columnStatements = () => buildColumnMigration({ dialect: connectionType, db, schema, table, original, columns: draft, foreignKeys, originalForeignKeys: savedForeignKeys, indexes });
  const dirty = JSON.stringify(original) !== JSON.stringify(draft);
  const foreignKeysDirty = JSON.stringify(savedForeignKeys) !== JSON.stringify(foreignKeys);
  const reviewIndex = () => propose(() => {
    return editingIndexName
      ? buildEditIndex(connectionType, db, schema, table, editingIndexName, newIndex.name, newIndex.columns, newIndex.unique)
      : [buildCreateIndex(connectionType, db, schema, table, newIndex.name, newIndex.columns, newIndex.unique)];
  });

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
    const startHeight = indexHeight;
    document.body.classList.add("is-resizing");
    const onMove = (moveEvent: MouseEvent) => {
      const totalHeight = rightPaneRef.current?.clientHeight ?? 500;
      const maxHeight = Math.max(140, totalHeight - 160);
      setIndexHeight(Math.max(140, Math.min(maxHeight, startHeight + moveEvent.clientY - startY)));
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
    <div className="relative flex flex-col h-full min-h-0">
      {error && <div className="flex items-center justify-between px-3 py-2 text-xs text-error bg-error/10 border-b border-error/20"><span>{error}</span><button onClick={() => setError(null)}><X size={12} /></button></div>}
      <div ref={workspaceRef} className="flex flex-1 min-h-0 overflow-hidden">
        <section className="flex flex-col flex-1 min-w-0 min-h-0">
          <PaneHeader icon={<Columns3 size={12} />} title="Columns">
            <button onClick={() => { void onRefresh(); void loadMetadata(); }} className="p-1.5 rounded text-text-muted hover:bg-bg-hover cursor-pointer" title="Refresh schema"><RefreshCw size={12} /></button>
            <button disabled={!dirty || working} onClick={() => propose(columnStatements)} className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-accent text-white text-[11px] disabled:opacity-30 cursor-pointer"><Save size={11} />Review</button>
          </PaneHeader>
          <div className="flex-1 min-h-0 overflow-auto"><ColumnsEditor columns={draft} dialect={connectionType} onChange={setDraft} /></div>
        </section>

        <div onMouseDown={startVerticalResize} className="group relative w-[5px] shrink-0 cursor-col-resize bg-bg-secondary"><div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border group-hover:bg-accent/60" /></div>

        <aside ref={rightPaneRef} className="flex flex-col min-h-0 shrink-0" style={{ width: rightWidth }}>
          <section className="flex flex-col min-h-0" style={{ height: indexHeight }}>
            <PaneHeader icon={<KeyRound size={12} />} title="Indexes" count={indexes.length} />
            <div className="flex-1 min-h-0 overflow-auto"><IndexesEditor indexes={indexes} columns={draft.map((c) => c.name)} value={newIndex} onChange={setNewIndex} loading={metaLoading} editingIndexName={editingIndexName} onSubmit={reviewIndex} onCancelEdit={() => { setEditingIndexName(null); setNewIndex({ name: "", columns: [], unique: false }); }} onEdit={(index) => { setEditingIndexName(index.name); setNewIndex({ name: index.name, columns: [...index.columns], unique: index.unique }); }} onDrop={(name) => propose(() => [buildDropIndex(connectionType, db, schema, table, name)])} /></div>
          </section>

          <div onMouseDown={startHorizontalResize} className="group relative h-[5px] shrink-0 cursor-row-resize bg-bg-secondary"><div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border group-hover:bg-accent/60" /></div>

          <section className="flex flex-col flex-1 min-h-0">
            <PaneHeader icon={<Link2 size={12} />} title="Foreign Keys" count={foreignKeys.length}>
              {connectionType === "sqlite" && <button disabled={!foreignKeysDirty || working} onClick={() => propose(columnStatements)} className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-accent text-white text-[11px] disabled:opacity-30 cursor-pointer"><Save size={11} />Review</button>}
            </PaneHeader>
            <div className="flex-1 min-h-0 overflow-auto"><ForeignKeysEditor foreignKeys={foreignKeys} columns={draft.map((c) => c.name)} value={newFk} onChange={setNewFk} loading={metaLoading} sqlite={connectionType === "sqlite"} onAdd={() => {
              if (connectionType === "sqlite") {
                if (!newFk.name.trim() || !newFk.column || !newFk.foreignTable.trim() || !newFk.foreignColumn.trim()) { setError("Constraint name, local column, referenced table, and referenced column are required."); return; }
                setForeignKeys((current) => [...current, newFk]);
                setNewFk({ name: "", column: "", foreignSchema: schema, foreignTable: "", foreignColumn: "" });
              } else propose(() => [buildAddForeignKey(connectionType, db, schema, table, newFk)]);
            }} onDrop={(name) => {
              if (connectionType === "sqlite") setForeignKeys((current) => current.filter((fk) => fk.name !== name));
              else propose(() => [buildDropForeignKey(connectionType, db, schema, table, name)]);
            }} /></div>
          </section>
        </aside>
      </div>

      {ddlOpen && <DdlViewModal ddl={ddl} copied={copied} onCopy={async () => { await navigator.clipboard.writeText(ddl); setCopied(true); setTimeout(() => setCopied(false), 1200); }} onClose={onDdlClose} />}
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

function ColumnsEditor({ columns, dialect, onChange }: { columns: EditableColumn[]; dialect: "postgres" | "mysql" | "sqlite"; onChange: (columns: EditableColumn[]) => void }) {
  const typeListId = useId();
  const update = (id: string, patch: Partial<EditableColumn>) => onChange(columns.map((column) => column.id === id ? { ...column, ...patch } : column));
  const move = (index: number, direction: -1 | 1) => { const next = [...columns]; const target = index + direction; if (target < 0 || target >= next.length) return; [next[index], next[target]] = [next[target], next[index]]; onChange(next); };
  return <div className="min-w-[760px]">
    <div className="grid grid-cols-[44px_minmax(140px,1fr)_minmax(150px,1fr)_minmax(140px,1fr)_70px_54px_48px] sticky top-0 z-10 bg-bg-secondary border-b border-border text-[10px] uppercase tracking-wider text-text-muted font-semibold">
      {['#','Column','Type','Default','Nullable','PK',''].map((label) => <div key={label} className="px-2 py-2 border-r border-border">{label}</div>)}
    </div>
    {columns.map((column, index) => <div key={column.id} className="grid grid-cols-[44px_minmax(140px,1fr)_minmax(150px,1fr)_minmax(140px,1fr)_70px_54px_48px] border-b border-border hover:bg-bg-hover/40 text-[12px]">
      <div className="px-2 py-1.5 border-r border-border text-text-muted flex flex-col items-center"><button onClick={() => move(index, -1)} className="leading-3">▲</button><button onClick={() => move(index, 1)} className="leading-3">▼</button></div>
      <CellInput value={column.name} onChange={(name) => update(column.id, { name })} />
      <TypeInput value={column.type} listId={typeListId} onChange={(type) => update(column.id, { type })} />
      <CellInput value={column.defaultValue} placeholder="No default" onChange={(defaultValue) => update(column.id, { defaultValue })} />
      <CellCheck checked={column.nullable} onChange={(nullable) => update(column.id, { nullable })} />
      <CellCheck checked={column.isPk} onChange={(isPk) => update(column.id, { isPk })} />
      <div className="flex items-center justify-center"><button onClick={() => onChange(columns.filter((item) => item.id !== column.id))} className="p-1 text-text-muted hover:text-error cursor-pointer"><Trash2 size={12} /></button></div>
    </div>)}
    <datalist id={typeListId}>{COLUMN_TYPES[dialect].map((type) => <option key={type} value={type} />)}</datalist>
    <button onClick={() => onChange([...columns, { id: `new-${crypto.randomUUID()}`, originalName: null, name: "", type: dialect === "postgres" ? "text" : dialect === "mysql" ? "varchar(255)" : "TEXT", nullable: true, defaultValue: "", isPk: false }])} className="flex items-center gap-1.5 m-2 px-2.5 py-1.5 rounded border border-border hover:bg-bg-hover text-[11px] cursor-pointer"><Plus size={11} />Add column</button>
  </div>;
}

function IndexesEditor({ indexes, columns, value, onChange, loading, editingIndexName, onSubmit, onCancelEdit, onEdit, onDrop }: { indexes: IndexInfo[]; columns: string[]; value: { name: string; columns: string[]; unique: boolean }; onChange: (value: { name: string; columns: string[]; unique: boolean }) => void; loading: boolean; editingIndexName: string | null; onSubmit: () => void; onCancelEdit: () => void; onEdit: (index: IndexInfo) => void; onDrop: (name: string) => void }) {
  return <Manager loading={loading} empty="No indexes found.">
    {indexes.map((index) => <ManagerRow key={index.name} title={index.name} detail={`${index.unique ? "UNIQUE · " : ""}${index.columns.join(", ")}`} protectedItem={index.primary} active={editingIndexName === index.name} onEdit={() => onEdit(index)} onDrop={() => onDrop(index.name)} />)}
    <div className="flex flex-col gap-2 p-3 border-t border-border bg-bg-secondary/40"><SmallInput value={value.name} placeholder="Index name" onChange={(name) => onChange({ ...value, name })} /><select multiple value={value.columns} onChange={(event) => onChange({ ...value, columns: Array.from(event.target.selectedOptions, (option) => option.value) })} className="input-field h-16">{columns.map((column) => <option key={column}>{column}</option>)}</select><div className="flex items-center gap-2"><label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={value.unique} onChange={(event) => onChange({ ...value, unique: event.target.checked })} />Unique</label><div className="flex-1" />{editingIndexName && <button onClick={onCancelEdit} className="px-2.5 py-1.5 rounded border border-border text-xs cursor-pointer">Cancel</button>}<button onClick={onSubmit} className="flex items-center gap-1 px-2.5 py-1.5 bg-accent text-white rounded text-xs cursor-pointer">{editingIndexName ? <Save size={11} /> : <Plus size={11} />}{editingIndexName ? "Review update" : "Add index"}</button></div></div>
  </Manager>;
}

function ForeignKeysEditor({ foreignKeys, columns, value, onChange, loading, sqlite, onAdd, onDrop }: { foreignKeys: ForeignKeyInfo[]; columns: string[]; value: ForeignKeyInfo; onChange: (value: ForeignKeyInfo) => void; loading: boolean; sqlite: boolean; onAdd: () => void; onDrop: (name: string) => void }) {
  return <Manager loading={loading} empty="No foreign keys found.">
    {foreignKeys.map((fk) => <ManagerRow key={fk.name} title={fk.name} detail={`${fk.column} → ${fk.foreignSchema ? `${fk.foreignSchema}.` : ""}${fk.foreignTable}.${fk.foreignColumn}`} onDrop={() => onDrop(fk.name)} />)}
    <div className="grid grid-cols-2 gap-2 p-3 border-t border-border bg-bg-secondary/40"><div className="col-span-2"><SmallInput value={value.name} placeholder="Constraint name" onChange={(name) => onChange({ ...value, name })} /></div><select value={value.column} onChange={(event) => onChange({ ...value, column: event.target.value })} className="input-field"><option value="">Local column</option>{columns.map((column) => <option key={column}>{column}</option>)}</select><SmallInput value={value.foreignSchema} placeholder="Schema / database" onChange={(foreignSchema) => onChange({ ...value, foreignSchema })} /><SmallInput value={value.foreignTable} placeholder="Referenced table" onChange={(foreignTable) => onChange({ ...value, foreignTable })} /><SmallInput value={value.foreignColumn} placeholder="Referenced column" onChange={(foreignColumn) => onChange({ ...value, foreignColumn })} /><div className="col-span-2 flex justify-end"><button onClick={onAdd} className="flex items-center gap-1 px-2.5 py-1.5 bg-accent text-white rounded text-xs"><Plus size={12} />Add foreign key</button></div>{sqlite && <p className="col-span-2 text-[11px] text-warning">SQLite foreign-key changes are staged and applied through transactional table recreation.</p>}
    </div>
  </Manager>;
}

function Manager({ children, loading, empty }: { children: React.ReactNode; loading: boolean; empty: string }) { return <div>{loading ? <Centered><Loader2 size={13} className="animate-spin" />Loading…</Centered> : children || <Centered>{empty}</Centered>}</div>; }
function ManagerRow({ title, detail, protectedItem, active, onEdit, onDrop }: { title: string; detail: string; protectedItem?: boolean; active?: boolean; onEdit?: () => void; onDrop: () => void }) { return <div className={`flex items-center px-3 py-2 border-b border-border ${active ? "bg-accent/10" : ""}`}><div className="flex-1 min-w-0"><div className="text-xs font-medium truncate">{title}</div><div className="text-[11px] font-mono text-text-muted mt-0.5 truncate">{detail}</div></div>{!protectedItem && onEdit && <button onClick={onEdit} className="p-1.5 text-text-muted hover:text-text-primary" title="Edit index"><Pencil size={12} /></button>}{!protectedItem && <button onClick={onDrop} className="p-1.5 text-text-muted hover:text-error"><Trash2 size={12} /></button>}</div>; }
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
