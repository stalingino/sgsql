import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronLeft, ChevronRight, X } from "lucide-react";
import {
  clampParts,
  daysInMonth,
  formatDateTimeParts,
  parseDateTimeText,
  partsFromDate,
  type DateTimeKind,
  type DateTimeParts,
} from "../lib/dateTimeEdit";

/* ── Date / time picker ────────────────────────────────── */

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const YEAR_LIST_PADDING = 100;

interface DateTimePickerProps {
  kind: DateTimeKind;
  /** Current field text; anything unparseable starts the picker at "now". */
  value: string;
  onChange: (text: string) => void;
  readOnly?: boolean;
}

/**
 * Calendar grid + time spinners. Every interaction calls `onChange` with
 * the formatted text immediately, so it can be embedded in a popover
 * (live edits) or a modal (buffered by the parent).
 */
export function DateTimePicker({ kind, value, onChange, readOnly }: DateTimePickerProps) {
  const parsed = useMemo(() => parseDateTimeText(value, kind), [value, kind]);
  const [parts, setParts] = useState<DateTimeParts>(() => parsed ?? partsFromDate(new Date()));
  // Month being browsed in the calendar, independent of the selected day.
  const [view, setView] = useState({ year: parts.year, month: parts.month });
  // Year/month chooser (opened from the header); `expandedYear` is the one showing its months.
  const [yearPickerOpen, setYearPickerOpen] = useState(false);
  const [expandedYear, setExpandedYear] = useState(view.year);

  // Follow external edits (typing in the text field while the popover is open).
  useEffect(() => {
    if (parsed) {
      setParts(parsed);
      setView({ year: parsed.year, month: parsed.month });
    }
  }, [parsed]);

  const update = (patch: Partial<DateTimeParts>) => {
    if (readOnly) return;
    const next = clampParts({ ...parts, ...patch });
    setParts(next);
    setView({ year: next.year, month: next.month });
    onChange(formatDateTimeParts(next, kind));
  };

  const setNow = () => update(partsFromDate(new Date()));

  const shiftMonth = (delta: number) => {
    setView((v) => {
      const d = new Date(v.year, v.month - 1 + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() + 1 };
    });
  };

  const toggleYearPicker = () => {
    setExpandedYear(view.year);
    setYearPickerOpen((open) => !open);
  };

  const pickMonth = (year: number, month: number) => {
    setView({ year, month });
    setYearPickerOpen(false);
  };

  const today = partsFromDate(new Date());
  const showCalendar = kind !== "time";
  const showTime = kind !== "date";

  // Calendar cells: leading blanks + days of the viewed month.
  const cells = useMemo(() => {
    const first = new Date(view.year, view.month - 1, 1).getDay();
    const count = daysInMonth(view.year, view.month);
    const out: (number | null)[] = Array.from({ length: first }, () => null);
    for (let d = 1; d <= count; d++) out.push(d);
    while (out.length % 7 !== 0) out.push(null);
    return out;
  }, [view]);

  return (
    <div className="flex flex-col gap-2 text-text-primary no-select" data-datetime-picker>
      {showCalendar && (
        <>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => (yearPickerOpen ? setExpandedYear((y) => y - 1) : shiftMonth(-1))}
              className="p-1 rounded hover:bg-bg-hover text-text-muted hover:text-text-primary cursor-pointer"
              title={yearPickerOpen ? "Previous year" : "Previous month"}
            >
              <ChevronLeft size={14} />
            </button>
            <button
              type="button"
              onClick={toggleYearPicker}
              className={`flex-1 flex items-center justify-center gap-1 text-[12px] font-semibold cursor-pointer ${yearPickerOpen ? "text-accent" : "hover:text-accent"}`}
              title={yearPickerOpen ? "Back to calendar" : "Choose month and year"}
              aria-expanded={yearPickerOpen}
            >
              {MONTHS[view.month - 1]} {view.year}
              <ChevronDown size={12} className={`transition-transform ${yearPickerOpen ? "rotate-180" : ""}`} />
            </button>
            <button
              type="button"
              onClick={() => (yearPickerOpen ? setExpandedYear((y) => y + 1) : shiftMonth(1))}
              className="p-1 rounded hover:bg-bg-hover text-text-muted hover:text-text-primary cursor-pointer"
              title={yearPickerOpen ? "Next year" : "Next month"}
            >
              <ChevronRight size={14} />
            </button>
          </div>
          {yearPickerOpen ? (
            <YearMonthList
              expandedYear={expandedYear}
              onExpandYear={setExpandedYear}
              current={view}
              selected={{ year: parts.year, month: parts.month }}
              today={{ year: today.year, month: today.month }}
              onPick={pickMonth}
            />
          ) : (
            <div className="grid grid-cols-7 gap-0.5 text-center">
              {WEEKDAYS.map((w) => (
                <div key={w} className="text-[10px] font-medium text-text-muted py-0.5">{w}</div>
              ))}
              {cells.map((d, i) => {
                if (d === null) return <div key={i} />;
                const selected = d === parts.day && view.month === parts.month && view.year === parts.year;
                const isToday = d === today.day && view.month === today.month && view.year === today.year;
                return (
                  <button
                    key={i}
                    type="button"
                    disabled={readOnly}
                    onClick={() => update({ year: view.year, month: view.month, day: d })}
                    className={`h-7 rounded text-[12px] tabular-nums transition-colors cursor-pointer ${
                      selected
                        ? "bg-accent text-white font-semibold"
                        : isToday
                          ? "text-accent font-semibold hover:bg-bg-hover"
                          : "hover:bg-bg-hover"
                    } disabled:cursor-default`}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}

      {showTime && (
        <div className={`flex items-center justify-center gap-1 ${showCalendar ? "pt-2 border-t border-border" : ""}`}>
          <TimeField label="hh" value={parts.hour} max={23} onChange={(hour) => update({ hour })} readOnly={readOnly} />
          <span className="text-text-muted font-mono">:</span>
          <TimeField label="mm" value={parts.minute} max={59} onChange={(minute) => update({ minute })} readOnly={readOnly} />
          <span className="text-text-muted font-mono">:</span>
          <TimeField label="ss" value={parts.second} max={59} onChange={(second) => update({ second })} readOnly={readOnly} />
        </div>
      )}

      {!readOnly && (
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={setNow}
            className="px-2 py-1 text-[11px] rounded border border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
          >
            Now
          </button>
          {kind === "datetime" && (
            <button
              type="button"
              onClick={() => update({ hour: 0, minute: 0, second: 0 })}
              className="px-2 py-1 text-[11px] rounded border border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
            >
              Midnight
            </button>
          )}
          <span className="flex-1 text-right font-mono text-[11px] text-text-muted truncate">{formatDateTimeParts(parts, kind)}</span>
        </div>
      )}
    </div>
  );
}

/* ── Year list with one expanded year showing its months ── */

interface YearMonth {
  year: number;
  month: number;
}

function YearMonthList({
  expandedYear,
  onExpandYear,
  current,
  selected,
  today,
  onPick,
}: {
  expandedYear: number;
  onExpandYear: (year: number) => void;
  /** Month currently shown in the calendar. */
  current: YearMonth;
  /** Month of the selected date. */
  selected: YearMonth;
  today: YearMonth;
  onPick: (year: number, month: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  // Stable range so the list doesn't reflow while browsing.
  const [range] = useState(() => ({ from: expandedYear - YEAR_LIST_PADDING, to: expandedYear + YEAR_LIST_PADDING }));
  const years = useMemo(() => {
    const out: number[] = [];
    for (let y = range.from; y <= range.to; y++) out.push(y);
    return out;
  }, [range]);

  // Keep the expanded year in view (on open and when the arrows change it).
  useLayoutEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>(`[data-year="${expandedYear}"]`);
    if (!list || !row) return;
    const top = row.offsetTop - list.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < list.scrollTop || bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = Math.max(0, top - 4);
    }
  }, [expandedYear]);

  return (
    // Height matches the six-row day grid so the popover doesn't jump.
    <div ref={listRef} className="h-[228px] overflow-y-auto -mx-1 px-1 rounded border border-border bg-bg-primary">
      {years.map((year) => {
        const expanded = year === expandedYear;
        return (
          <div key={year} data-year={year} className={expanded ? "bg-bg-secondary rounded" : ""}>
            <button
              type="button"
              onClick={() => onExpandYear(year)}
              className={`w-full text-left px-2 py-1 text-[12px] tabular-nums cursor-pointer transition-colors ${
                expanded ? "font-semibold text-text-primary" : year === current.year ? "text-accent hover:bg-bg-hover" : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
              }`}
            >
              {year}
            </button>
            {expanded && (
              <div className="grid grid-cols-4 gap-0.5 px-1 pb-1.5">
                {MONTHS_SHORT.map((label, i) => {
                  const month = i + 1;
                  const isSelected = year === selected.year && month === selected.month;
                  const isCurrent = year === current.year && month === current.month;
                  const isToday = year === today.year && month === today.month;
                  return (
                    <button
                      key={label}
                      type="button"
                      onClick={() => onPick(year, month)}
                      className={`h-7 rounded text-[12px] transition-colors cursor-pointer ${
                        isSelected
                          ? "bg-accent text-white font-semibold"
                          : isCurrent
                            ? "outline outline-1 outline-accent outline-offset-[-1px] hover:bg-bg-hover"
                            : isToday
                              ? "text-accent font-semibold hover:bg-bg-hover"
                              : "hover:bg-bg-hover"
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function TimeField({ label, value, max, onChange, readOnly }: { label: string; value: number; max: number; onChange: (n: number) => void; readOnly?: boolean }) {
  // Keep a local string so the user can clear and retype without the clamp fighting them.
  const [text, setText] = useState(String(value).padStart(2, "0"));
  useEffect(() => setText(String(value).padStart(2, "0")), [value]);

  const commit = (raw: string) => {
    const n = Number(raw);
    if (raw === "" || !Number.isFinite(n)) {
      setText(String(value).padStart(2, "0"));
      return;
    }
    onChange(Math.min(max, Math.max(0, Math.trunc(n))));
  };

  return (
    <input
      type="text"
      inputMode="numeric"
      aria-label={label}
      value={text}
      readOnly={readOnly}
      onChange={(e) => setText(e.target.value.replace(/\D/g, "").slice(0, 2))}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit(e.currentTarget.value);
        else if (e.key === "ArrowUp") { e.preventDefault(); onChange(value >= max ? 0 : value + 1); }
        else if (e.key === "ArrowDown") { e.preventDefault(); onChange(value <= 0 ? max : value - 1); }
      }}
      onFocus={(e) => e.target.select()}
      className="w-9 h-7 text-center text-[12px] font-mono tabular-nums bg-bg-primary border border-border-light rounded outline-none focus:border-accent"
    />
  );
}

/* ── Anchored popover ──────────────────────────────────── */

interface DateTimePopoverProps extends DateTimePickerProps {
  anchor: HTMLElement;
  onClose: () => void;
}

/** DateTimePicker in a fixed-position popover under `anchor`, closed on outside click or Esc. */
export function DateTimePopover({ anchor, onClose, ...pickerProps }: DateTimePopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const margin = 8;
    let left = Math.min(r.left, window.innerWidth - w - margin);
    let top = r.bottom + 4;
    if (top + h > window.innerHeight - margin) top = Math.max(margin, r.top - h - 4);
    left = Math.max(margin, left);
    setPos({ top, left });
  }, [anchor]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={ref}
      style={{ position: "fixed", top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
      className="z-[240] w-[248px] p-2.5 bg-bg-primary border border-border rounded-lg shadow-2xl"
    >
      <DateTimePicker {...pickerProps} />
    </div>,
    document.body,
  );
}

/* ── Centered modal (used by the cell pop-out) ─────────── */

interface DateTimeModalProps {
  title: string;
  dataType?: string;
  kind: DateTimeKind;
  value: string;
  readOnly?: boolean;
  onApply: (text: string) => void;
  onClose: () => void;
}

export function DateTimeModal({ title, dataType, kind, value, readOnly, onApply, onClose }: DateTimeModalProps) {
  const [draft, setDraft] = useState(value);
  const dirty = draft !== value;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && dirty && !readOnly) onApply(draft);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [draft, dirty, readOnly, onApply, onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Edit ${title}`}
      className="fixed inset-0 z-[230] flex items-center justify-center bg-black/50 p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-[300px] bg-bg-primary border border-border rounded-xl shadow-2xl overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border bg-bg-secondary no-select">
          <span className="text-sm font-semibold text-text-primary truncate">{title}</span>
          {dataType && <span className="text-[11px] font-mono text-text-secondary truncate">{dataType}</span>}
          {dirty && <span className="text-[10px] text-warning">modified</span>}
          <div className="flex-1" />
          <button type="button" onClick={onClose} title="Close (Esc)" className="p-1 rounded hover:bg-bg-hover transition-colors cursor-pointer text-text-muted hover:text-text-primary">
            <X size={14} />
          </button>
        </div>
        <div className="px-4 py-3">
          <input
            type="text"
            value={draft}
            readOnly={readOnly}
            onChange={(e) => setDraft(e.target.value)}
            className="w-full mb-3 px-2.5 py-1.5 text-[12px] font-mono text-text-primary bg-bg-primary border border-border-light rounded-md outline-none focus:border-accent focus:ring-1 focus:ring-accent/30"
          />
          <DateTimePicker kind={kind} value={draft} onChange={setDraft} readOnly={readOnly} />
        </div>
        <div className="flex items-center gap-2 px-4 py-2.5 border-t border-border bg-bg-secondary no-select">
          <div className="flex-1" />
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs rounded-md border border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer">
            Cancel
          </button>
          {!readOnly && (
            <button
              type="button"
              onClick={() => onApply(draft)}
              disabled={!dirty}
              className="px-3 py-1.5 text-xs rounded-md bg-accent text-white hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
            >
              Apply
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
