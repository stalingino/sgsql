import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import { Braces, X } from "lucide-react";
import { registerSqlLanguageSupport } from "../lib/monacoSetup";
import { useThemeStore } from "../lib/theme";
import { modKey } from "../lib/platform";
import { sizeForValue, type ValueEditorSize } from "../lib/fieldEdit";

/* ── Pop-out value editor ──────────────────────────────── */

const SIZE_CLASSES: Record<ValueEditorSize, string> = {
  sm: "w-full max-w-[520px] h-[240px]",
  md: "w-full max-w-[720px] h-[55vh]",
  lg: "w-full max-w-[900px] h-[80vh]",
};

interface ValueEditorModalProps {
  title: string;
  /** Column data type, shown next to the title. */
  dataType?: string;
  value: string;
  language: "json" | "plaintext";
  /** Dialog size; defaults to a fit based on the value. */
  size?: ValueEditorSize;
  readOnly?: boolean;
  onApply: (value: string) => void;
  onClose: () => void;
}

/**
 * Full-size Monaco editor for a single cell value. Edits are local until
 * Apply (or Cmd/Ctrl+Enter); Esc discards them.
 */
export function ValueEditorModal({ title, dataType, value, language, size, readOnly, onApply, onClose }: ValueEditorModalProps) {
  const dialogSize = size ?? sizeForValue(value, language);
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const resolvedTheme = useThemeStore((s) => s.resolved);
  const [dirty, setDirty] = useState(false);
  const [jsonError, setJsonError] = useState<string | null>(null);

  const onApplyRef = useRef(onApply);
  onApplyRef.current = onApply;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const apply = () => {
    const editor = editorRef.current;
    if (!editor || readOnly) return;
    onApplyRef.current(editor.getValue());
    onCloseRef.current();
  };

  useEffect(() => {
    registerSqlLanguageSupport();
    if (!containerRef.current) return;

    const editor = monaco.editor.create(containerRef.current, {
      value,
      language,
      theme: resolvedTheme === "dark" ? "sgsql-dark" : "sgsql-light",
      readOnly,
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      lineNumbersMinChars: 3,
      scrollBeyondLastLine: false,
      renderLineHighlight: "line",
      padding: { top: 10, bottom: 10 },
      wordWrap: "on",
      tabSize: 2,
      folding: true,
      bracketPairColorization: { enabled: false },
    });
    editorRef.current = editor;

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      const current = editorRef.current;
      if (!current || readOnly) return;
      onApplyRef.current(current.getValue());
      onCloseRef.current();
    });
    editor.addCommand(monaco.KeyCode.Escape, () => onCloseRef.current());

    const changeSub = editor.onDidChangeModelContent(() => {
      setDirty(editor.getValue() !== value);
      if (language === "json") setJsonError(validateJson(editor.getValue()));
    });
    if (language === "json") setJsonError(validateJson(value));

    editor.focus();

    return () => {
      changeSub.dispose();
      editor.dispose();
      editorRef.current = null;
    };
    // Mount once; the modal is re-created for each field it opens on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    monaco.editor.setTheme(resolvedTheme === "dark" ? "sgsql-dark" : "sgsql-light");
  }, [resolvedTheme]);

  const formatJson = () => {
    const editor = editorRef.current;
    if (!editor || readOnly) return;
    try {
      const pretty = JSON.stringify(JSON.parse(editor.getValue()), null, 2);
      editor.executeEdits("format", [{ range: editor.getModel()!.getFullModelRange(), text: pretty }]);
      editor.pushUndoStop();
    } catch {
      // leave invalid JSON untouched; the error banner already explains
    }
  };

  // Portal to body: the detail panel / grid create their own stacking contexts, which would paint over a nested modal.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Edit ${title}`}
      className="fixed inset-0 z-[230] flex items-center justify-center bg-black/50 p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`flex flex-col ${SIZE_CLASSES[dialogSize]} bg-bg-primary border border-border rounded-xl shadow-2xl overflow-hidden`}>
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border bg-bg-secondary no-select">
          <span className="text-sm font-semibold text-text-primary truncate">{title}</span>
          {dataType && <span className="text-[11px] font-mono text-text-secondary truncate">{dataType}</span>}
          {dirty && <span className="text-[10px] text-warning">modified</span>}
          <div className="flex-1" />
          {language === "json" && !readOnly && (
            <button
              type="button"
              onClick={formatJson}
              disabled={jsonError !== null}
              title="Format JSON"
              className="flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
            >
              <Braces size={12} />
              Format
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            title="Close (Esc)"
            className="p-1 rounded hover:bg-bg-hover transition-colors cursor-pointer text-text-muted hover:text-text-primary"
          >
            <X size={14} />
          </button>
        </div>

        {/* Editor */}
        <div className="relative flex-1 min-h-0">
          <div ref={containerRef} className="absolute inset-0" />
        </div>

        {/* Footer */}
        <div className="flex items-center gap-3 px-4 py-2.5 border-t border-border bg-bg-secondary no-select">
          {jsonError ? (
            <span className="text-[11px] text-error truncate" title={jsonError}>Invalid JSON: {jsonError}</span>
          ) : (
            <span className="text-[11px] text-text-muted">
              {readOnly ? "Read-only" : `${modKey("↩", "Enter")} to apply · Esc to cancel`}
            </span>
          )}
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-xs rounded-md border border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
          >
            Cancel
          </button>
          {!readOnly && (
            <button
              type="button"
              onClick={apply}
              disabled={!dirty}
              className="px-3 py-1.5 text-xs rounded-md bg-accent text-white hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
            >
              Apply
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function validateJson(text: string): string | null {
  if (text.trim() === "") return "empty value";
  try {
    JSON.parse(text);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message.replace(/^JSON\.parse: /, "") : String(err);
  }
}
