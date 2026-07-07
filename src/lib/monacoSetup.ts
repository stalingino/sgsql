import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import "monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import type { ColumnInfo } from "./schema";
import {
  buildSqlCompletions,
  getCompletionTarget,
  type CatalogTable,
  type SqlCompletion,
  type TableReference,
} from "./sqlAutocomplete";
import { dialectToFormatterLanguage, formatSql, type SqlDialect } from "./sqlFormat";

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker() {
    return new EditorWorker();
  },
};

export interface EditorCompletionContext {
  catalog: CatalogTable[];
  tableReferences: TableReference[];
  columnsByTable: Map<string, ColumnInfo[]>;
  defaultSchema: string;
  dialect: SqlDialect;
}

const contextRegistry = new Map<monaco.editor.ITextModel, () => EditorCompletionContext | null>();

export function setEditorContext(model: monaco.editor.ITextModel, getContext: () => EditorCompletionContext | null) {
  contextRegistry.set(model, getContext);
}

export function clearEditorContext(model: monaco.editor.ITextModel) {
  contextRegistry.delete(model);
}

const COMPLETION_KIND_MAP: Record<SqlCompletion["kind"], monaco.languages.CompletionItemKind> = {
  schema: monaco.languages.CompletionItemKind.Module,
  table: monaco.languages.CompletionItemKind.Class,
  view: monaco.languages.CompletionItemKind.Interface,
  column: monaco.languages.CompletionItemKind.Field,
};

// Hex values kept in sync with the theme palettes in src/index.css.
const DARK_COLORS = {
  bgPrimary: "#1b1f27",
  bgSecondary: "#232935",
  bgHover: "#313a4b",
  bgActive: "#2d4a7a",
  border: "#394355",
  borderLight: "#4d5a70",
  textPrimary: "#f8fafc",
  textSecondary: "#d3dae5",
  textMuted: "#9faaba",
  accent: "#3b82f6",
  keyword: "#60a5fa",
  string: "#4ade80",
  identifier: "#38bdf8",
  number: "#93c5fd",
};

const LIGHT_COLORS = {
  bgPrimary: "#f8f8f7",
  bgSecondary: "#f0f0ef",
  bgHover: "#dfe1e3",
  bgActive: "#cdd1d5",
  border: "#d0d2d4",
  borderLight: "#adb3ba",
  textPrimary: "#17191c",
  textSecondary: "#3f454d",
  textMuted: "#707780",
  accent: "#2563eb",
  keyword: "#2563eb",
  string: "#047857",
  identifier: "#0284c7",
  number: "#0284c7",
};

function buildTheme(base: "vs-dark" | "vs", c: typeof DARK_COLORS): monaco.editor.IStandaloneThemeData {
  return {
    base,
    inherit: true,
    rules: [
      { token: "keyword.sql", foreground: c.keyword.slice(1), fontStyle: "bold" },
      { token: "keyword.block.sql", foreground: c.keyword.slice(1), fontStyle: "bold" },
      { token: "keyword.choice.sql", foreground: c.keyword.slice(1), fontStyle: "bold" },
      { token: "keyword.try.sql", foreground: c.keyword.slice(1), fontStyle: "bold" },
      { token: "keyword.catch.sql", foreground: c.keyword.slice(1), fontStyle: "bold" },
      { token: "operator.sql", foreground: c.textSecondary.slice(1) },
      { token: "string.sql", foreground: c.string.slice(1) },
      { token: "identifier.sql", foreground: c.identifier.slice(1) },
      { token: "identifier.quote.sql", foreground: c.identifier.slice(1) },
      { token: "predefined.sql", foreground: c.identifier.slice(1) },
      { token: "number.sql", foreground: c.number.slice(1) },
      { token: "comment.sql", foreground: c.textMuted.slice(1), fontStyle: "italic" },
      { token: "comment.quote.sql", foreground: c.textMuted.slice(1), fontStyle: "italic" },
      { token: "delimiter.sql", foreground: c.textSecondary.slice(1) },
    ],
    colors: {
      "editor.background": c.bgPrimary,
      "editor.foreground": c.textPrimary,
      "editorCursor.foreground": c.textPrimary,
      "editor.lineHighlightBackground": c.bgSecondary,
      "editor.selectionBackground": c.bgActive,
      "editorLineNumber.foreground": c.textMuted,
      "editorLineNumber.activeForeground": c.textSecondary,
      "editorSuggestWidget.background": c.bgPrimary,
      "editorSuggestWidget.border": c.borderLight,
      "editorSuggestWidget.foreground": c.textPrimary,
      "editorSuggestWidget.selectedBackground": c.bgHover,
      "editorSuggestWidget.highlightForeground": c.accent,
      "editorSuggestWidget.focusHighlightForeground": c.accent,
      "editorWidget.background": c.bgSecondary,
      "editorWidget.border": c.border,
      "editorHoverWidget.background": c.bgSecondary,
      "editorHoverWidget.border": c.border,
      "editorGutter.background": c.bgPrimary,
      "scrollbarSlider.background": c.bgHover + "80",
      "scrollbarSlider.hoverBackground": c.bgHover,
      "editor.findMatchBackground": c.bgActive,
      "editor.findMatchHighlightBackground": c.bgHover,
    },
  };
}

let registered = false;

export function registerSqlLanguageSupport() {
  if (registered) return;
  registered = true;

  monaco.editor.defineTheme("sgsql-dark", buildTheme("vs-dark", DARK_COLORS));
  monaco.editor.defineTheme("sgsql-light", buildTheme("vs", LIGHT_COLORS));

  monaco.languages.registerCompletionItemProvider("sql", {
    triggerCharacters: [".", " ", ","],
    provideCompletionItems(model, position, context) {
      const getContext = contextRegistry.get(model);
      const ctx = getContext?.();
      if (!ctx) return { suggestions: [] };

      const sql = model.getValue();
      const offset = model.getOffsetAt(position);
      const forced = context.triggerKind === monaco.languages.CompletionTriggerKind.Invoke;
      const target = getCompletionTarget(sql, offset, forced);
      const completions = buildSqlCompletions({
        target,
        catalog: ctx.catalog,
        references: ctx.tableReferences,
        columnsByTable: ctx.columnsByTable,
        defaultSchema: ctx.defaultSchema,
        dialect: ctx.dialect,
      });

      const start = model.getPositionAt(target.replaceStart);
      const end = model.getPositionAt(target.replaceEnd);
      const range = new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column);

      return {
        suggestions: completions.map((completion, index): monaco.languages.CompletionItem => ({
          label: completion.label,
          kind: COMPLETION_KIND_MAP[completion.kind],
          insertText: completion.insertText,
          detail: completion.detail,
          range,
          sortText: String(index).padStart(5, "0"),
          filterText: target.prefix || undefined,
        })),
      };
    },
  });

  monaco.languages.registerDocumentFormattingEditProvider("sql", {
    provideDocumentFormattingEdits(model) {
      const getContext = contextRegistry.get(model);
      const dialect = getContext?.()?.dialect ?? "postgres";
      const formatted = formatSql(model.getValue(), {
        language: dialectToFormatterLanguage(dialect),
        keywordCase: "upper",
      });
      return [{ range: model.getFullModelRange(), text: formatted }];
    },
  });
}
