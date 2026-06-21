import { useCallback, useEffect, useRef, useState } from "react";
import {
  X,
  Code2,
  Plus,
  RotateCcw,
} from "lucide-react";

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
  filters: FilterRow[];
  onFiltersChange: (filters: FilterRow[]) => void;
  onApply: () => void;
  onShowSql: () => void;
  onClear: () => void;
  canClear: boolean;
  onClose: () => void;
}

/* ── Fuzzy ──────────────────────────────────────────────── */

function fuzzyMatch(query: string, target: string): boolean {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
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
  onChange,
  onRemove,
  onApply,
  inputRef,
}: {
  filter: FilterRow;
  columns: string[];
  onChange: (patch: Partial<FilterRow>) => void;
  onRemove: () => void;
  onApply: () => void;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  const applyOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    onApply();
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
      />

      {filter.mode === "raw" ? (
        /* Raw SQL input */
        <input
          ref={inputRef}
          type="text"
          value={filter.rawSql}
          onChange={(e) => onChange({ rawSql: e.target.value })}
          onKeyDown={applyOnEnter}
          placeholder="e.g. age > 18 AND status = 'active'"
          className="flex-1 px-2 py-1 text-[11px] font-mono bg-bg-primary border border-border rounded outline-none focus:border-accent transition-colors min-w-0"
        />
      ) : (
        /* Column mode: operator + value */
        <>
          <select
            value={filter.operator}
            onChange={(e) => onChange({ operator: e.target.value })}
            className="px-1.5 py-1 text-[11px] bg-bg-primary border border-border rounded outline-none focus:border-accent cursor-pointer"
          >
            {OPERATORS.map((op) => (
              <option key={op} value={op}>{op}</option>
            ))}
          </select>
          {!NO_VALUE_OPS.has(filter.operator) && (
            <input
              ref={inputRef}
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

/* ── Mode / Column picker dropdown ──────────────────────── */

function ModeColumnPicker({
  mode,
  column,
  columns,
  onSelectRaw,
  onSelectColumn,
}: {
  mode: "raw" | "column";
  column: string;
  columns: string[];
  onSelectRaw: () => void;
  onSelectColumn: (col: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

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
      setSearch("");
      const rect = buttonRef.current.getBoundingClientRect();
      setDropdownPos({ top: rect.top - 4, left: rect.left });
      setTimeout(() => searchRef.current?.focus(), 30);
    }
  }, [open]);

  const filtered = search
    ? columns.filter((c) => fuzzyMatch(search, c))
    : columns;

  const label = mode === "raw" ? "Raw SQL" : column || "Column...";

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        ref={buttonRef}
        onClick={() => setOpen(!open)}
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
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setOpen(false);
                } else if (e.key === "Enter" && filtered.length > 0) {
                  onSelectColumn(filtered[0]);
                  setOpen(false);
                }
              }}
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
            {filtered.map((col) => (
              <div
                key={col}
                onClick={() => {
                  onSelectColumn(col);
                  setOpen(false);
                }}
                className={`px-2.5 py-1 text-[11px] font-mono cursor-pointer transition-colors truncate ${
                  mode === "column" && column === col
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
