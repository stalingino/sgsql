import { useCallback, useMemo, useRef, type CSSProperties } from "react";

/* ── JSON editor with syntax coloring ─────────────────── */

type TokenKind = "key" | "string" | "number" | "keyword" | "punct" | "text";

interface Token {
  kind: TokenKind;
  text: string;
}

const TOKEN_RE = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],:])/g;

/** Split raw JSON text into colorable tokens. Tolerates invalid JSON — unknown text passes through uncolored. */
export function tokenizeJson(text: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) tokens.push({ kind: "text", text: text.slice(last, idx) });
    if (m[1] !== undefined) {
      tokens.push({ kind: m[2] !== undefined ? "key" : "string", text: m[1] });
      if (m[2] !== undefined) tokens.push({ kind: "punct", text: m[2] });
    } else if (m[3] !== undefined) {
      tokens.push({ kind: "number", text: m[3] });
    } else if (m[4] !== undefined) {
      tokens.push({ kind: "keyword", text: m[4] });
    } else if (m[5] !== undefined) {
      tokens.push({ kind: "punct", text: m[5] });
    }
    last = idx + m[0].length;
  }
  if (last < text.length) tokens.push({ kind: "text", text: text.slice(last) });
  return tokens;
}

const TOKEN_CLASS: Record<TokenKind, string> = {
  key: "text-syntax-identifier",
  string: "text-syntax-string",
  number: "text-syntax-number",
  keyword: "text-syntax-keyword font-semibold",
  punct: "text-text-muted",
  text: "text-text-primary",
};

interface JsonEditorProps {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  /** Border classes (dirty state etc.) applied to the outer box. */
  borderClassName?: string;
  style?: CSSProperties;
}

/**
 * Editable textarea with a colorized <pre> rendered underneath it.
 * The textarea text is transparent so the highlighted layer shows through; caret and selection stay native.
 */
export function JsonEditor({ value, onChange, readOnly, borderClassName = "border-border-light", style }: JsonEditorProps) {
  const preRef = useRef<HTMLPreElement>(null);
  const tokens = useMemo(() => tokenizeJson(value), [value]);

  const syncScroll = useCallback((e: React.UIEvent<HTMLTextAreaElement>) => {
    const pre = preRef.current;
    if (!pre) return;
    pre.scrollTop = e.currentTarget.scrollTop;
    pre.scrollLeft = e.currentTarget.scrollLeft;
  }, []);

  const shared = "px-2.5 py-1.5 text-[12px] font-mono leading-[1.5] whitespace-pre-wrap break-all";

  return (
    <div className={`relative w-full bg-bg-primary border rounded-md focus-within:border-accent focus-within:ring-1 focus-within:ring-accent/30 transition-colors ${borderClassName}`}>
      <pre
        ref={preRef}
        aria-hidden
        className={`absolute inset-0 m-0 overflow-hidden pointer-events-none ${shared}`}
      >
        {tokens.map((t, i) => (
          <span key={i} className={TOKEN_CLASS[t.kind]}>{t.text}</span>
        ))}
        {/* trailing newline keeps pre height in sync with textarea when value ends with \n */}
        {value.endsWith("\n") ? " " : null}
      </pre>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
        readOnly={readOnly}
        spellCheck={false}
        style={{ fieldSizing: "content" as any, minHeight: "2lh", maxHeight: "12lh", ...style }}
        className={`relative block w-full bg-transparent text-transparent caret-text-primary outline-none resize-y ${shared}`}
      />
    </div>
  );
}
