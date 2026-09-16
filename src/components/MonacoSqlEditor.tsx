import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import {
  clearEditorContext,
  registerSqlLanguageSupport,
  setEditorContext,
  type EditorCompletionContext,
} from "../lib/monacoSetup";
import { useThemeStore } from "../lib/theme";
import type { SqlErrorMarker } from "../lib/sqlStatements";

export interface MonacoSqlEditorHandle {
  getValue: () => string;
  setValue: (value: string) => void;
  getSelectionText: () => string;
  getSelection: () => { text: string; start: number; end: number } | null;
  setErrorMarkers: (markers: SqlErrorMarker[]) => void;
  focus: () => void;
}

interface MonacoSqlEditorProps {
  defaultValue: string;
  activeRange: [number, number] | null;
  onChange: (value: string) => void;
  onCursorChange: (offset: number) => void;
  onRunQuery: () => void;
  onRunAll: () => void;
  getCompletionContext: () => EditorCompletionContext | null;
}

function themeName(resolved: "dark" | "light") {
  return resolved === "dark" ? "sgsql-dark" : "sgsql-light";
}

export const MonacoSqlEditor = forwardRef<MonacoSqlEditorHandle, MonacoSqlEditorProps>(function MonacoSqlEditor(
  { defaultValue, activeRange, onChange, onCursorChange, onRunQuery, onRunAll, getCompletionContext },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const decorationsRef = useRef<string[]>([]);
  const resolvedTheme = useThemeStore((s) => s.resolved);

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onCursorChangeRef = useRef(onCursorChange);
  onCursorChangeRef.current = onCursorChange;
  const onRunQueryRef = useRef(onRunQuery);
  onRunQueryRef.current = onRunQuery;
  const onRunAllRef = useRef(onRunAll);
  onRunAllRef.current = onRunAll;
  const getCompletionContextRef = useRef(getCompletionContext);
  getCompletionContextRef.current = getCompletionContext;

  useImperativeHandle(ref, () => ({
    getValue: () => editorRef.current?.getValue() ?? "",
    setValue: (value: string) => {
      editorRef.current?.setValue(value);
    },
    getSelectionText: () => {
      const editor = editorRef.current;
      const model = editor?.getModel();
      const selection = editor?.getSelection();
      if (!editor || !model || !selection || selection.isEmpty()) return "";
      return model.getValueInRange(selection);
    },
    getSelection: () => {
      const editor = editorRef.current;
      const model = editor?.getModel();
      const selection = editor?.getSelection();
      if (!model || !selection || selection.isEmpty()) return null;
      return {
        text: model.getValueInRange(selection),
        start: model.getOffsetAt(selection.getStartPosition()),
        end: model.getOffsetAt(selection.getEndPosition()),
      };
    },
    setErrorMarkers: (markers) => {
      const model = editorRef.current?.getModel();
      if (!model) return;
      monaco.editor.setModelMarkers(model, "sgsql", markers.map((marker) => {
        const start = model.getPositionAt(marker.start);
        const end = model.getPositionAt(Math.max(marker.start + 1, marker.end));
        return {
          severity: monaco.MarkerSeverity.Error,
          message: marker.message,
          startLineNumber: start.lineNumber,
          startColumn: start.column,
          endLineNumber: end.lineNumber,
          endColumn: end.column,
        };
      }));
    },
    focus: () => editorRef.current?.focus(),
  }), []);

  // Mount once; imperative refs above keep callback props current without
  // needing to recreate the editor (and its model/providers) on every render.
  useEffect(() => {
    registerSqlLanguageSupport();
    if (!containerRef.current) return;

    const editor = monaco.editor.create(containerRef.current, {
      value: defaultValue,
      language: "sql",
      theme: themeName(useThemeStore.getState().resolved),
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
      suggestOnTriggerCharacters: true,
    });
    editorRef.current = editor;

    const model = editor.getModel();
    if (model) setEditorContext(model, () => getCompletionContextRef.current());

    // addAction, not addCommand: addCommand keybindings are global to the page
    // and outlive the editor, so any other Monaco instance (another query tab,
    // the pop-out value editor) would shadow this binding after it is created.
    const runAction = editor.addAction({
      id: "sgsql.runQuery",
      label: "Run Query",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: () => onRunQueryRef.current(),
    });
    const runAllAction = editor.addAction({
      id: "sgsql.runAllQueries",
      label: "Run All Queries",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter],
      run: () => onRunAllRef.current(),
    });

    const changeSub = editor.onDidChangeModelContent(() => onChangeRef.current(editor.getValue()));
    const cursorSub = editor.onDidChangeCursorPosition((e) => {
      const m = editor.getModel();
      if (m) onCursorChangeRef.current(m.getOffsetAt(e.position));
    });

    // automaticLayout's internal poll can miss the display:none -> block
    // flip when switching between query tabs (App.tsx keeps every tab
    // mounted and toggles CSS display), so also observe the container.
    const resizeObserver = new ResizeObserver(() => editor.layout());
    resizeObserver.observe(containerRef.current);

    editor.focus();

    return () => {
      resizeObserver.disconnect();
      runAction.dispose();
      runAllAction.dispose();
      changeSub.dispose();
      cursorSub.dispose();
      if (model) clearEditorContext(model);
      if (model) monaco.editor.setModelMarkers(model, "sgsql", []);
      editor.dispose();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    monaco.editor.setTheme(themeName(resolvedTheme));
  }, [resolvedTheme]);

  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    if (!activeRange) {
      decorationsRef.current = editor.deltaDecorations(decorationsRef.current, []);
      return;
    }
    const start = model.getPositionAt(activeRange[0]);
    const end = model.getPositionAt(activeRange[1]);
    decorationsRef.current = editor.deltaDecorations(decorationsRef.current, [
      {
        range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
        options: { inlineClassName: "sgsql-active-statement" },
      },
    ]);
  }, [activeRange]);

  return <div ref={containerRef} className="absolute inset-0" />;
});

export default MonacoSqlEditor;
