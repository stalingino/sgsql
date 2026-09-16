import { useState } from "react";
import { Check, Clipboard, Eye, EyeOff, KeyRound, Loader2, Save } from "lucide-react";
import { HighlightedSQL } from "../lib/highlightSQL";
import { PRIVILEGES, maskPasswords, presetPrivileges, type GrantScope, type UserDialect } from "../lib/userDdl";

/* ── Read-only chip row ─────────────────────────────────── */

export function Chips({ items, withGrant, empty = "—" }: { items: string[]; withGrant?: boolean; empty?: string }) {
  if (items.length === 0 && !withGrant) return <span className="text-[11px] text-text-muted">{empty}</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {items.map((item) => (
        <span key={item} className="px-1.5 py-px rounded border border-border bg-bg-secondary text-[10px] font-mono text-text-secondary">
          {item}
        </span>
      ))}
      {withGrant && (
        <span title="WITH GRANT OPTION" className="flex items-center gap-0.5 px-1.5 py-px rounded border border-warning/40 bg-warning/10 text-[10px] font-mono text-warning">
          <KeyRound size={9} />
          GRANT
        </span>
      )}
    </span>
  );
}

/* ── Editable privilege picker ──────────────────────────── */

interface PrivilegeChipsProps {
  dialect: UserDialect;
  scope: GrantScope;
  value: string[];
  onChange: (next: string[]) => void;
  withGrant?: boolean;
  onWithGrantChange?: (next: boolean) => void;
  /** Hide the Read / Read-write / All / None shortcuts. */
  compact?: boolean;
}

export function PrivilegeChips({ dialect, scope, value, onChange, withGrant, onWithGrantChange, compact }: PrivilegeChipsProps) {
  // Servers can report privileges our vocabulary does not know (dynamic
  // MySQL privileges, newer PG versions); keep them toggleable too.
  const vocab = PRIVILEGES[dialect][scope];
  const options = [...vocab, ...value.filter((p) => !vocab.includes(p))];
  const toggle = (privilege: string) =>
    onChange(value.includes(privilege) ? value.filter((p) => p !== privilege) : [...value, privilege]);
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((p) => b.includes(p));
  const presetButton = (label: string, privileges: string[]) => (
    <button
      key={label}
      onClick={() => onChange(privileges)}
      className={`px-1.5 py-0.5 rounded text-[10px] transition-colors cursor-pointer ${
        same(value, privileges) && (privileges.length > 0 || value.length === 0)
          ? "text-accent bg-accent/10"
          : "text-text-muted hover:text-text-primary hover:bg-bg-hover"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1">
        {options.map((privilege) => {
          const selected = value.includes(privilege);
          return (
            <button
              key={privilege}
              onClick={() => toggle(privilege)}
              className={`px-2 py-0.5 rounded border text-[11px] font-mono transition-colors cursor-pointer ${
                selected
                  ? "border-accent bg-accent/15 text-text-primary"
                  : "border-border text-text-muted hover:border-border-light hover:text-text-secondary"
              }`}
            >
              {privilege}
            </button>
          );
        })}
      </div>
      {!compact && (
        <div className="flex items-center gap-1">
          {presetButton("Read", presetPrivileges(dialect, scope, "read"))}
          {presetButton("Read / write", presetPrivileges(dialect, scope, "readwrite"))}
          {presetButton("All", presetPrivileges(dialect, scope, "all"))}
          {presetButton("None", [])}
          {onWithGrantChange && (
            <label className="ml-auto flex items-center gap-1.5 text-[11px] text-text-secondary cursor-pointer select-none">
              <input type="checkbox" checked={withGrant ?? false} onChange={(event) => onWithGrantChange(event.target.checked)} />
              With grant option
            </label>
          )}
        </div>
      )}
    </div>
  );
}

/* ── SQL review block (shared by wizard + account actions) ── */

export function SqlReview({ statements, emptyMessage = "No changes to apply." }: { statements: string[]; emptyMessage?: string }) {
  const [reveal, setReveal] = useState(false);
  const [copied, setCopied] = useState(false);
  const hasSecret = statements.some((sql) => /IDENTIFIED BY|PASSWORD '/.test(sql));
  const shown = reveal ? statements : maskPasswords(statements);
  const text = shown.map((sql) => `${sql};`).join("\n\n");
  if (statements.length === 0) {
    return <div className="rounded border border-dashed border-border px-4 py-6 text-center text-xs text-text-muted">{emptyMessage}</div>;
  }
  return (
    <div className="relative rounded border border-border bg-bg-secondary">
      <pre className="p-4 pr-24 overflow-auto text-[12px] leading-5 font-mono whitespace-pre-wrap selectable"><HighlightedSQL sql={text} /></pre>
      <div className="absolute top-2 right-2 flex items-center gap-1">
        {hasSecret && (
          <button
            onClick={() => setReveal((v) => !v)}
            title={reveal ? "Hide passwords" : "Show passwords"}
            className="flex items-center px-1.5 py-1 rounded border border-border bg-bg-primary text-text-muted hover:text-text-primary cursor-pointer"
          >
            {reveal ? <EyeOff size={11} /> : <Eye size={11} />}
          </button>
        )}
        <button
          onClick={async () => {
            await navigator.clipboard.writeText(statements.map((sql) => `${sql};`).join("\n\n"));
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
          className="flex items-center gap-1 px-2 py-1 rounded border border-border bg-bg-primary text-[11px] text-text-secondary hover:text-text-primary cursor-pointer"
        >
          {copied ? <Check size={11} /> : <Clipboard size={11} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

/* ── Modal shell used by the small account actions ──────── */

export function ActionModal({
  title,
  subtitle,
  children,
  statements,
  confirmLabel,
  danger,
  working,
  error,
  disabled,
  onCancel,
  onConfirm,
}: {
  title: string;
  subtitle?: string;
  children?: React.ReactNode;
  statements: string[];
  confirmLabel: string;
  danger?: boolean;
  working: boolean;
  error: string | null;
  disabled?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/55 p-6" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <div className="w-full max-w-2xl max-h-full flex flex-col rounded-lg border border-border bg-bg-primary shadow-2xl">
        <div className="px-4 py-3 border-b border-border">
          <div className="text-sm font-semibold">{title}</div>
          {subtitle && <div className={`text-[11px] mt-0.5 ${danger ? "text-warning" : "text-text-muted"}`}>{subtitle}</div>}
        </div>
        {error && <div className="px-4 py-2 text-xs text-error bg-error/10 border-b border-border">{error}</div>}
        <div className="p-4 flex flex-col gap-3 overflow-auto">
          {children}
          <SqlReview statements={statements} />
        </div>
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-border">
          <button onClick={onCancel} className="px-3 py-1.5 rounded border border-border text-xs cursor-pointer hover:bg-bg-hover">Cancel</button>
          <button
            disabled={working || disabled || statements.length === 0}
            onClick={onConfirm}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-white text-xs cursor-pointer disabled:opacity-50 disabled:cursor-default ${danger ? "bg-error" : "bg-accent hover:bg-accent-hover"}`}
          >
            {working ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
