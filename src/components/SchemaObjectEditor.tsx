import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Code2, Eye, Loader2, RefreshCw, Save, Sparkles } from "lucide-react";
import type { MonacoSqlEditorHandle } from "./MonacoSqlEditor";
import {
  applySchemaChanges,
  fetchSchemaObjectDdl,
} from "../lib/schema";
import type { EditorCompletionContext } from "../lib/monacoSetup";
import { buildSchemaObjectReplacement, type DefinitionObjectType } from "../lib/schemaObjectDdl";
import { notifySchemaChanged } from "../lib/schemaRevision";
import { dialectToFormatterLanguage, formatSql } from "../lib/sqlFormat";

const MonacoSqlEditor = lazy(() => import("./MonacoSqlEditor"));

interface SchemaObjectEditorProps {
  connectionId: string;
  connectionType: "postgres" | "mysql" | "sqlite";
  db: string;
  schema: string;
  name: string;
  type: DefinitionObjectType;
  identity?: string;
  signature?: string;
  active: boolean;
  onSaved?: () => void;
}

export function SchemaObjectEditor({
  connectionId,
  connectionType,
  db,
  schema,
  name,
  type,
  identity = "",
  signature = "",
  active,
  onSaved,
}: SchemaObjectEditorProps) {
  const editorRef = useRef<MonacoSqlEditorHandle>(null);
  const [sql, setSql] = useState("");
  const [savedSql, setSavedSql] = useState("");
  const [editorVersion, setEditorVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const displayName = type === "function" && signature ? `${name}(${signature})` : name;
  const dirty = sql !== savedSql;

  const completionContext = useMemo<EditorCompletionContext>(() => ({
    catalog: [],
    tableReferences: [],
    columnsByTable: new Map(),
    defaultSchema: schema,
    dialect: connectionType,
  }), [connectionType, schema]);

  const loadDefinition = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const definition = await fetchSchemaObjectDdl(connectionId, db, schema, name, type, identity);
      setSql(definition);
      setSavedSql(definition);
      setEditorVersion((version) => version + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [connectionId, db, schema, name, type, identity]);

  useEffect(() => { void loadDefinition(); }, [loadDefinition]);

  const saveDefinition = useCallback(async () => {
    if (saving || loading || !sql.trim() || !dirty) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const statements = buildSchemaObjectReplacement({
        ddl: sql,
        type,
        dialect: connectionType,
        db,
        schema,
        name,
      });
      await applySchemaChanges(connectionId, db, statements, connectionType === "sqlite");
      setSavedSql(sql);
      setNotice(`${type === "view" ? "View" : "Function"} definition saved.`);
      notifySchemaChanged(connectionId);
      onSaved?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }, [connectionId, connectionType, db, dirty, loading, name, onSaved, saving, schema, sql, type]);

  useEffect(() => {
    if (!active) return;
    const save = () => { void saveDefinition(); };
    window.addEventListener("sgsql-save-definition", save);
    return () => window.removeEventListener("sgsql-save-definition", save);
  }, [active, saveDefinition]);

  const formatDefinition = useCallback(() => {
    const value = editorRef.current?.getValue() ?? sql;
    if (!value.trim()) return;
    try {
      const formatted = formatSql(value, {
        language: dialectToFormatterLanguage(connectionType),
        keywordCase: "upper",
      });
      editorRef.current?.setValue(formatted);
      setSql(formatted);
      setError(null);
      setNotice(null);
      editorRef.current?.focus();
    } catch (cause) {
      setError(`Could not format definition: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }, [connectionType, sql]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-primary">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-bg-secondary px-3">
        {type === "view"
          ? <Eye size={13} className="text-purple-400" />
          : <Code2 size={13} className="text-emerald-400" />}
        <span className="min-w-0 truncate font-mono text-[11px] text-text-primary">
          {[schema, displayName].filter(Boolean).join(".")}
        </span>
        <span className="rounded bg-bg-hover px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-text-muted">
          {type} definition
        </span>
        {dirty && <span className="text-[10px] text-warning">Modified</span>}
        <div className="flex-1" />
        {type === "view" && (
          <button
            onClick={formatDefinition}
            disabled={loading || saving || !sql.trim()}
            className="flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[10px] text-text-secondary hover:bg-bg-hover disabled:opacity-40"
            title="Format view SQL"
          >
            <Sparkles size={10} /> Format
          </button>
        )}
        <button
          onClick={() => void loadDefinition()}
          disabled={loading || saving}
          className="flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[10px] text-text-secondary hover:bg-bg-hover disabled:opacity-40"
          title="Reload definition"
        >
          <RefreshCw size={10} className={loading ? "animate-spin" : ""} /> Reload
        </button>
        <button
          onClick={() => void saveDefinition()}
          disabled={!dirty || loading || saving}
          className="flex items-center gap-1 rounded bg-accent px-2 py-0.5 text-[10px] text-white hover:bg-accent-hover disabled:opacity-40"
          title="Save definition (Cmd/Ctrl+S)"
        >
          {saving ? <Loader2 size={10} className="animate-spin" /> : <Save size={10} />}
          Save
        </button>
      </div>

      {error && <div className="shrink-0 border-b border-error/20 bg-error/10 px-3 py-2 text-[11px] text-error">{error}</div>}
      {notice && <div className="shrink-0 border-b border-success/20 bg-success/10 px-3 py-2 text-[11px] text-success">{notice}</div>}

      <div className="relative flex-1 min-h-0">
        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-xs text-text-muted">
            <Loader2 size={13} className="animate-spin" /> Loading definition…
          </div>
        ) : sql || !error ? (
          <Suspense fallback={<div className="absolute inset-0 flex items-center justify-center"><Loader2 size={13} className="animate-spin text-text-muted" /></div>}>
            <MonacoSqlEditor
              key={editorVersion}
              ref={editorRef}
              defaultValue={sql}
              activeRange={null}
              onChange={(value) => {
                setSql(value);
                setNotice(null);
              }}
              onCursorChange={() => {}}
              onRunQuery={() => void saveDefinition()}
              onRunAll={() => void saveDefinition()}
              getCompletionContext={() => completionContext}
            />
          </Suspense>
        ) : null}
      </div>
    </div>
  );
}
