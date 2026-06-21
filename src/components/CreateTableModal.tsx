import { useState } from "react";
import { Check, Clipboard, Loader2, Plus, Save, Trash2, X } from "lucide-react";
import { applySchemaChanges } from "../lib/schema";
import { buildCreateTableStatements, type EditableColumn } from "../lib/schemaDdl";
import { notifySchemaChanged } from "../lib/schemaRevision";
import { HighlightedSQL } from "../lib/highlightSQL";

interface Props {
  connectionId: string;
  dialect: "postgres" | "mysql" | "sqlite";
  db: string;
  schema: string;
  onClose: () => void;
  onCreated: (table: string) => void;
}

function newColumn(dialect: Props["dialect"]): EditableColumn {
  return {
    id: crypto.randomUUID(), originalName: null, name: "",
    type: dialect === "postgres" ? "text" : dialect === "mysql" ? "varchar(255)" : "TEXT",
    nullable: true, defaultValue: "", isPk: false, unique: false, extra: "", comment: "",
  };
}

export function CreateTableModal({ connectionId, dialect, db, schema, onClose, onCreated }: Props) {
  const [table, setTable] = useState("");
  const [columns, setColumns] = useState<EditableColumn[]>([newColumn(dialect)]);
  const [preview, setPreview] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [copied, setCopied] = useState(false);
  const previewText = preview?.map((statement) => `${statement};`).join("\n\n") ?? "";

  const update = (id: string, patch: Partial<EditableColumn>) => {
    setPreview(null);
    setColumns((current) => current.map((column) => column.id === id ? { ...column, ...patch } : column));
  };
  const review = () => {
    try { setError(null); setPreview(buildCreateTableStatements(dialect, db, schema, table, columns)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const create = async () => {
    if (!preview) return;
    setWorking(true); setError(null);
    try {
      await applySchemaChanges(connectionId, db, preview);
      notifySchemaChanged(connectionId);
      onCreated(table.trim());
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setWorking(false); }
  };

  return <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 p-6" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="w-full max-w-6xl max-h-full flex flex-col rounded-lg border border-border bg-bg-primary shadow-2xl">
      <div className="flex items-center px-4 py-3 border-b border-border"><div className="text-sm font-semibold">Create table</div><button onClick={onClose} className="ml-auto p-1"><X size={14} /></button></div>
      {error && <div className="px-4 py-2 text-xs text-error bg-error/10">{error}</div>}
      <div className="p-4 overflow-auto">
        <input value={table} onChange={(event) => { setTable(event.target.value); setPreview(null); }} placeholder="Table name" className="input-field mb-3" />
        <div className="grid grid-cols-[1fr_1fr_1fr_52px_52px_58px_1fr_1fr_36px] text-[10px] uppercase text-text-muted border border-border">
          {["Column", "Type", "Default", "Null", "PK", "Unique", "Extra", "Comment", ""].map((heading) => <div key={heading} className="p-2 border-r border-border">{heading}</div>)}
          {columns.map((column) => <div key={column.id} className="contents">
            <input value={column.name} onChange={(event) => update(column.id, { name: event.target.value })} className="p-2 bg-transparent border-r border-t border-border outline-none" />
            <input value={column.type} onChange={(event) => update(column.id, { type: event.target.value })} className="p-2 bg-transparent border-r border-t border-border outline-none font-mono" />
            <input value={column.defaultValue} onChange={(event) => update(column.id, { defaultValue: event.target.value })} className="p-2 bg-transparent border-r border-t border-border outline-none font-mono" />
            <label className="border-r border-t border-border flex justify-center items-center"><input type="checkbox" checked={column.nullable} onChange={(event) => update(column.id, { nullable: event.target.checked })} /></label>
            <label className="border-r border-t border-border flex justify-center items-center"><input type="checkbox" checked={column.isPk} onChange={(event) => update(column.id, { isPk: event.target.checked })} /></label>
            <label className="border-r border-t border-border flex justify-center items-center"><input type="checkbox" checked={column.unique ?? false} onChange={(event) => update(column.id, { unique: event.target.checked })} /></label>
            <input value={column.extra} placeholder="Identity, generated, collation…" onChange={(event) => update(column.id, { extra: event.target.value })} className="p-2 bg-transparent border-r border-t border-border outline-none font-mono" />
            <input value={column.comment} disabled={dialect === "sqlite"} placeholder={dialect === "sqlite" ? "Unsupported" : "Comment"} onChange={(event) => update(column.id, { comment: event.target.value })} className="p-2 bg-transparent border-r border-t border-border outline-none" />
            <button onClick={() => { setPreview(null); setColumns((current) => current.filter((item) => item.id !== column.id)); }} className="border-t border-border flex justify-center items-center"><Trash2 size={12} /></button>
          </div>)}
        </div>
        <button onClick={() => { setPreview(null); setColumns((current) => [...current, newColumn(dialect)]); }} className="mt-2 flex items-center gap-1 px-2 py-1.5 border border-border rounded text-xs"><Plus size={11} />Add column</button>
        {preview && <div className="relative mt-4 border border-border rounded bg-bg-secondary"><pre className="p-4 overflow-auto text-xs font-mono whitespace-pre-wrap"><HighlightedSQL sql={previewText} /></pre><button onClick={async () => { await navigator.clipboard.writeText(previewText); setCopied(true); setTimeout(() => setCopied(false), 1200); }} className="absolute top-2 right-2 flex items-center gap-1 px-2 py-1 rounded border border-border bg-bg-primary text-[11px]">{copied ? <Check size={11} /> : <Clipboard size={11} />}{copied ? "Copied" : "Copy"}</button></div>}
      </div>
      <div className="flex justify-end gap-2 p-4 border-t border-border"><button onClick={onClose} className="px-3 py-1.5 border border-border rounded text-xs">Cancel</button>{preview ? <button disabled={working} onClick={() => void create()} className="flex items-center gap-1 px-3 py-1.5 rounded bg-accent text-white text-xs">{working ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}Create table</button> : <button onClick={review} className="px-3 py-1.5 rounded bg-accent text-white text-xs">Review DDL</button>}</div>
    </div>
  </div>;
}
