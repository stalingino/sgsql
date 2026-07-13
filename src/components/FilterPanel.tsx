import { useCallback, useEffect, useRef, useState } from "react";
import {
  X,
  Code2,
  Plus,
  RotateCcw,
} from "lucide-react";
import { fuzzySearch } from "../lib/fuzzySearch";
import { getCompletionTarget, quoteCompletionIdentifier } from "../lib/sqlAutocomplete";

/* ── Types ──────────────────────────────────────────────── */

export interface FilterRow {
  id: string;
  enabled: boolean;
  mode: "raw" | "column";
  /** For mode "raw" — raw SQL WHERE clause fragment */
  rawSql: string;
  /** For mode "column" — selected column name */
  column: string;
  /** Operator */
  operator: string;
  /** Value text */
  value: string;
}

const OPERATORS = ["contains", "=", "!=", "<", "<=", ">", ">=", "LIKE", "NOT LIKE", "IN", "NOT IN", "BETWEEN", "IS NULL", "IS NOT NULL"] as const;

const NO_VALUE_OPS = new Set(["IS NULL", "IS NOT NULL"]);

interface FilterPanelProps {
  columns: string[];
  connectionType: "postgres" | "mysql" | "sqlite";
  filters: FilterRow[];
  onFiltersChange: (filters: FilterRow[]) => void;
  onApply: () => void;
  onShowSql: () => void;
  onClear: () => void;
  canClear: boolean;
  onClose: () => void;
}

/* ── Helpers ────────────────────────────────────────────── */

let _nextId = 1;
export function createFilter(): FilterRow {
  return {
    id: `f-${_nextId++}`,
    enabled: true,
    mode: "raw",
    rawSql: "",
    column: "",
    operator: "contains",
    value: "",
  };
}

function quoteIdent(type: "postgres" | "mysql" | "sqlite", name: string): string {
  if (type === "mysql") return `\`${name}\``;
  return `"${name}"`;
}

function quoteValue(val: string): string {
  return `'${val.replace(/'/g, "''")}'`;
}

export function buildWhereClause(
  filters: FilterRow[],
  connectionType: "postgres" | "mysql" | "sqlite",
  enabledOnly: boolean,
): string {
  const parts: string[] = [];
  for (const f of filters) {
    if (enabledOnly && !f.enabled) continue;
    if (f.mode === "raw") {
      if (f.rawSql.trim()) parts.push(f.rawSql.trim());
    } else if (f.column) {
      const col = quoteIdent(connectionType, f.column);
      if (NO_VALUE_OPS.has(f.operator)) {
        parts.push(`${col} ${f.operator}`);
      } else if (f.operator === "contains") {
        parts.push(`${col} LIKE ${quoteValue(`%${f.value}%`)}`);
      } else if (f.operator === "IN" || f.operator === "NOT IN") {
        const vals = f.value.split(",").map((v) => quoteValue(v.trim())).join(", ");
        parts.push(`${col} ${f.operator} (${vals})`);
      } else if (f.operator === "BETWEEN") {
        const vals = f.value.split(",").map((v) => quoteValue(v.trim()));
        if (vals.length >= 2) {
          parts.push(`${col} BETWEEN ${vals[0]} AND ${vals[1]}`);
        }
      } else {
        parts.push(`${col} ${f.operator} ${quoteValue(f.value)}`);
      }
    }
  }
  return parts.join(" AND ");
}

/* ── Component ──────────────────────────────────────────── */

export function FilterPanel({
  columns,
  connectionType,
  filters,
  onFiltersChange,
  onApply,
  onShowSql,
  onClear,
  canClear,
  onClose,
}: FilterPanelProps) {
  const firstInputRef = useRef<HTMLInputElement | null>(null);

  // Focus the first input on mount
  useEffect(() => {
    setTimeout(() => firstInputRef.current?.focus(), 50);
  }, []);

  // Esc to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const updateFilter = useCallback(
    (id: string, patch: Partial<FilterRow>) => {
      onFiltersChange(filters.map((f) => (f.id === id ? { ...f, ...patch } : f)));
    },
    [filters, onFiltersChange],
  );

  const removeFilter = useCallback(
    (id: string) => {
      onFiltersChange(filters.filter((f) => f.id !== id));
    },
    [filters, onFiltersChange],
  );

  const addFilter = useCallback(() => {
    onFiltersChange([...filters, createFilter()]);
  }, [filters, onFiltersChange]);

  return (
    <div className="border-t border-border bg-bg-secondary px-3 py-2.5 text-[11px] shrink-0 shadow-[0_-4px_16px_rgba(0,0,0,0.08)]">
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="text-[11px] font-semibold text-text-primary uppercase tracking-wider">Filter conditions</div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={addFilter}
            className="flex items-center gap-1 px-2 py-1 rounded border border-border bg-bg-primary text-text-primary hover:border-accent/50 hover:bg-bg-hover transition-colors cursor-pointer"
          >
            <Plus size={10} />
            Add
          </button>
          <button
            onClick={onShowSql}
            className="flex items-center gap-1 px-2 py-1 rounded border border-border bg-bg-primary text-text-primary hover:border-accent/50 hover:bg-bg-hover transition-colors cursor-pointer"
          >
            <Code2 size={10} />
            SQL
          </button>
          <button
            onClick={onClear}
            disabled={!canClear}
            className="flex items-center gap-1 px-2 py-1 rounded border border-border bg-bg-primary text-text-primary hover:border-accent/50 hover:bg-bg-hover transition-colors cursor-pointer disabled:opacity-35 disabled:cursor-default"
          >
            <RotateCcw size={10} />
            Clear
          </button>
          <button
            onClick={onApply}
            className="flex items-center gap-1 px-3 py-1 rounded bg-accent text-white hover:bg-accent-hover transition-colors cursor-pointer font-medium"
          >
            Apply
          </button>
        </div>
      </div>

      {/* Filter rows */}
      <div className="flex flex-col gap-1.5 max-h-[200px] overflow-y-auto">
        {filters.map((f, i) => (
          <FilterRowItem
            key={f.id}
            filter={f}
            columns={columns}
            connectionType={connectionType}
            onChange={(patch) => updateFilter(f.id, patch)}
            onRemove={() => removeFilter(f.id)}
            onApply={onApply}
            inputRef={i === 0 ? firstInputRef : undefined}
          />
        ))}
      </div>

    </div>
  );
}

/* ── Single filter row ──────────────────────────────────── */

function FilterRowItem({
  filter,
  columns,
  connectionType,
  onChange,
  onRemove,
  onApply,
  inputRef,
}: {
  filter: FilterRow;
  columns: string[];
  connectionType: "postgres" | "mysql" | "sqlite";
  onChange: (patch: Partial<FilterRow>) => void;
  onRemove: () => void;
  onApply: () => void;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  const operatorRef = useRef<HTMLSelectElement>(null);
  const valueRef = useRef<HTMLInputElement>(null);

  const applyOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    onApply();
  };

  // After a column is picked in the popup, jump straight to the value input so the
  // user can keep going without touching the mouse. Value-less operators (IS NULL /
  // IS NOT NULL) don't render a value input, so fall back to the operator select.
  const focusAfterColumnPick = useCallback(() => {
    setTimeout(() => {
      if (NO_VALUE_OPS.has(filter.operator)) operatorRef.current?.focus();
      else valueRef.current?.focus();
    }, 0);
  }, [filter.operator]);

  // Merge the external first-input ref with the local value ref.
  const setValueRef = useCallback((node: HTMLInputElement | null) => {
    valueRef.current = node;
    if (typeof inputRef === "function") inputRef(node);
    else if (inputRef) (inputRef as React.MutableRefObject<HTMLInputElement | null>).current = node;
  }, [inputRef]);

  const handleOperatorKeyDown = (e: React.KeyboardEvent<HTMLSelectElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    // For value-less operators (IS NULL / IS NOT NULL) there is nothing to type,
    // so Enter runs the search straight from the operator.
    if (NO_VALUE_OPS.has(filter.operator)) {
      onApply();
    } else {
      valueRef.current?.focus();
    }
  };

  return (
    <div className="flex items-center gap-1.5 rounded-md border border-border bg-bg-primary/70 px-2 py-1.5">
      {/* Checkbox */}
      <input
        type="checkbox"
        checked={filter.enabled}
        onChange={(e) => onChange({ enabled: e.target.checked })}
        className="accent-accent shrink-0"
      />

      {/* Mode selector: Raw SQL or Column */}
      <ModeColumnPicker
        mode={filter.mode}
        column={filter.column}
        columns={columns}
        onSelectRaw={() => onChange({ mode: "raw", column: "" })}
        onSelectColumn={(col) => onChange({ mode: "column", column: col })}
        onColumnPicked={focusAfterColumnPick}
      />

      {filter.mode === "raw" ? (
        /* Raw SQL input with column autocomplete */
        <RawSqlInput
          value={filter.rawSql}
          columns={columns}
          connectionType={connectionType}
          onChange={(rawSql) => onChange({ rawSql })}
          onApply={onApply}
          inputRef={inputRef}
        />
      ) : (
        /* Column mode: operator + value */
        <>
          <select
            ref={operatorRef}
            value={filter.operator}
            onChange={(e) => {
              const nextOp = e.target.value;
              onChange({ operator: nextOp });
              // Selecting an operator that takes a value hands focus to the value input.
              if (!NO_VALUE_OPS.has(nextOp)) setTimeout(() => valueRef.current?.focus(), 0);
            }}
            onKeyDown={handleOperatorKeyDown}
            className="px-1.5 py-1 text-[11px] bg-bg-primary border border-border rounded outline-none focus:border-accent cursor-pointer"
          >
            {OPERATORS.map((op) => (
              <option key={op} value={op}>{op}</option>
            ))}
          </select>
          {!NO_VALUE_OPS.has(filter.operator) && (
            <input
              ref={setValueRef}
              type="text"
              value={filter.value}
              onChange={(e) => onChange({ value: e.target.value })}
              onKeyDown={applyOnEnter}
              placeholder={
                filter.operator === "contains"
                  ? "search text..."
                  : filter.operator === "IN" || filter.operator === "NOT IN"
                  ? "val1, val2, ..."
                  : filter.operator === "BETWEEN"
                    ? "low, high"
                    : "value"
              }
              className="flex-1 px-2 py-1 text-[11px] font-mono bg-bg-primary border border-border rounded outline-none focus:border-accent transition-colors min-w-0"
            />
          )}
        </>
      )}

      <div className="flex-1" />
      {/* Remove */}
      <button
        onClick={onRemove}
        className="p-0.5 text-text-muted hover:text-error transition-colors cursor-pointer shrink-0"
      >
        <X size={12} />
      </button>
    </div>
  );
}

/* ── Raw SQL input with column autocomplete ─────────────── */

function RawSqlInput({
  value,
  columns,
  connectionType,
  onChange,
  onApply,
  inputRef,
}: {
  value: string;
  columns: string[];
  connectionType: "postgres" | "mysql" | "sqlite";
  onChange: (sql: string) => void;
  onApply: () => void;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  const localRef = useRef<HTMLInputElement | null>(null);
  const activeRowRef = useRef<HTMLDivElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [replaceRange, setReplaceRange] = useState<[number, number]>([0, 0]);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  // Merge the external first-input ref with the local ref.
  const setRef = useCallback((node: HTMLInputElement | null) => {
    localRef.current = node;
    if (typeof inputRef === "function") inputRef(node);
    else if (inputRef) (inputRef as React.MutableRefObject<HTMLInputElement | null>).current = node;
  }, [inputRef]);

  // Place the caret right after an accepted completion once the new value renders.
  useEffect(() => {
    if (pendingCaret.current != null && localRef.current) {
      localRef.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [value]);

  useEffect(() => {
    if (suggestions.length > 0) activeRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, suggestions.length]);

  const close = useCallback(() => setSuggestions([]), []);

  const refresh = (sql: string, cursor: number) => {
    const target = getCompletionTarget(sql, cursor);
    // No suggestions without a typed prefix, or inside a string literal
    // (an odd number of quotes before the token means we're inside one).
    const quotesBefore = (sql.slice(0, target.replaceStart).match(/'/g) ?? []).length;
    if (!target.prefix || quotesBefore % 2 === 1) {
      close();
      return;
    }
    const matches = fuzzySearch(columns, target.prefix).slice(0, 12);
    if (matches.length === 0) {
      close();
      return;
    }
    setSuggestions(matches);
    setActiveIndex(0);
    setReplaceRange([target.replaceStart, target.replaceEnd]);
    const rect = localRef.current?.getBoundingClientRect();
    if (rect) setDropdownPos({ top: rect.top - 4, left: rect.left });
  };

  const accept = (col: string) => {
    const [start, end] = replaceRange;
    const insert = quoteCompletionIdentifier(col, connectionType);
    pendingCaret.current = start + insert.length;
    onChange(value.slice(0, start) + insert + value.slice(end));
    close();
    localRef.current?.focus();
  };

  const open = suggestions.length > 0;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (open) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => Math.min(suggestions.length - 1, i + 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        accept(suggestions[activeIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
        return;
      }
    }
    if (e.key === "Enter") {
      e.preventDefault();
      onApply();
    }
  };

  return (
    <div className="relative flex-1 min-w-0">
      <input
        ref={setRef}
        type="text"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          refresh(e.target.value, e.target.selectionStart ?? e.target.value.length);
        }}
        onKeyDown={handleKeyDown}
        onBlur={() => setTimeout(close, 100)}
        placeholder="e.g. age > 18 AND status = 'active'"
        className="w-full px-2 py-1 text-[11px] font-mono bg-bg-primary border border-border rounded outline-none focus:border-accent transition-colors"
      />

      {open && (
        <div
          className="fixed z-[9999] w-[220px] max-h-[190px] border border-border rounded bg-bg-primary shadow-xl overflow-y-auto py-0.5"
          style={{ top: dropdownPos.top, left: dropdownPos.left, transform: "translateY(-100%)" }}
        >
          {suggestions.map((col, index) => (
            <div
              key={col}
              ref={index === activeIndex ? activeRowRef : undefined}
              onMouseEnter={() => setActiveIndex(index)}
              onMouseDown={(e) => {
                // Accept on mousedown so the input's blur doesn't close the list first.
                e.preventDefault();
                accept(col);
              }}
              className={`px-2.5 py-1 text-[11px] font-mono cursor-pointer transition-colors truncate ${
                index === activeIndex
                  ? "bg-accent/15 text-accent"
                  : "text-text-secondary hover:bg-bg-hover"
              }`}
            >
              {col}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Mode / Column picker dropdown ──────────────────────── */

function ModeColumnPicker({
  mode,
  column,
  columns,
  onSelectRaw,
  onSelectColumn,
  onColumnPicked,
}: {
  mode: "raw" | "column";
  column: string;
  columns: string[];
  onSelectRaw: () => void;
  onSelectColumn: (col: string) => void;
  onColumnPicked?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const activeRowRef = useRef<HTMLDivElement>(null);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  // Holds a character typed on the closed button so the dropdown opens pre-seeded
  // with it, instead of always opening with an empty search.
  const seededSearchRef = useRef<string | null>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Auto-focus search on open + compute position
  useEffect(() => {
    if (open && buttonRef.current) {
      const seeded = seededSearchRef.current;
      seededSearchRef.current = null;
      setSearch(seeded ?? "");
      setActiveIndex(0);
      const rect = buttonRef.current.getBoundingClientRect();
      setDropdownPos({ top: rect.top - 4, left: rect.left });
      setTimeout(() => {
        searchRef.current?.focus();
        if (seeded) searchRef.current?.setSelectionRange(seeded.length, seeded.length);
      }, 30);
    }
  }, [open]);

  // Typing a printable character while the closed button is focused opens the
  // dropdown and starts filtering immediately, instead of requiring a click first.
  const handleButtonKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    // Space/Enter fall through to the button's native activation (opens empty).
    if (open || e.key === " " || e.key.length !== 1 || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    seededSearchRef.current = e.key;
    setOpen(true);
  };

  const filtered = fuzzySearch(columns, search);

  // Keep the highlighted option in range as the list narrows, and in view.
  useEffect(() => { setActiveIndex(0); }, [search]);
  useEffect(() => {
    if (open) activeRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  const pickColumn = (col: string) => {
    onSelectColumn(col);
    setOpen(false);
    onColumnPicked?.();
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" && filtered.length > 0) {
      e.preventDefault();
      pickColumn(filtered[Math.min(activeIndex, filtered.length - 1)]);
    }
  };

  const label = mode === "raw" ? "Raw SQL" : column || "Column...";

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        ref={buttonRef}
        onClick={() => setOpen(!open)}
        onKeyDown={handleButtonKeyDown}
        className={`flex items-center gap-0.5 px-2 py-1 text-[11px] rounded border transition-colors cursor-pointer min-w-[80px] max-w-[160px] truncate ${
          open
            ? "border-accent bg-accent/10 text-accent"
            : "border-border bg-bg-primary text-text-secondary hover:border-accent/50"
        }`}
      >
        <span className="truncate">{label}</span>
      </button>

      {open && (
        <div
          className="fixed z-[9999] w-[200px] max-h-[240px] border border-border rounded bg-bg-primary shadow-xl overflow-hidden"
          style={{ top: dropdownPos.top, left: dropdownPos.left, transform: "translateY(-100%)" }}
        >
          {/* Search */}
          <div className="p-1 border-b border-border">
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter..."
              className="w-full px-2 py-0.5 text-[11px] bg-bg-secondary border border-border rounded outline-none focus:border-accent"
              onKeyDown={handleSearchKeyDown}
            />
          </div>

          <div className="overflow-y-auto max-h-[190px] py-0.5">
            {/* Raw SQL option */}
            <div
              onClick={() => {
                onSelectRaw();
                setOpen(false);
              }}
              className={`flex items-center gap-1.5 px-2.5 py-1 text-[11px] cursor-pointer transition-colors ${
                mode === "raw"
                  ? "bg-accent/10 text-accent"
                  : "text-text-secondary hover:bg-bg-hover"
              }`}
            >
              <Code2 size={10} className="shrink-0" />
              Raw SQL
            </div>

            {/* Separator */}
            <div className="border-t border-border my-0.5" />

            {/* Columns */}
            {filtered.map((col, index) => (
              <div
                key={col}
                ref={index === activeIndex ? activeRowRef : undefined}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => pickColumn(col)}
                className={`px-2.5 py-1 text-[11px] font-mono cursor-pointer transition-colors truncate ${
                  index === activeIndex
                    ? "bg-accent/15 text-accent"
                    : mode === "column" && column === col
                      ? "bg-accent/10 text-accent"
                      : "text-text-secondary hover:bg-bg-hover"
                }`}
              >
                {col}
              </div>
            ))}
            {filtered.length === 0 && (
              <div className="px-2.5 py-1 text-[11px] text-text-muted italic">No match</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
