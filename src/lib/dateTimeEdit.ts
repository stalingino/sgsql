/* ── Date/time editing helpers ─────────────────────────── */

export type DateTimeKind = "date" | "time" | "datetime";

/**
 * Classify a column data type for the date/time picker. Returns null for
 * anything that isn't a date/time column.
 */
export function getDateTimeKind(dataType: string): DateTimeKind | null {
  const t = dataType.toLowerCase().trim();
  if (/^(timestamp|datetime)/.test(t)) return "datetime";
  if (/^date\b/.test(t)) return "date";
  if (/^time\b/.test(t)) return "time";
  return null;
}

export interface DateTimeParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const DATE_RE = /(\d{4})-(\d{2})-(\d{2})/;
const TIME_RE = /(\d{1,2}):(\d{2})(?::(\d{2}))?/;

/**
 * Lenient parse of the text shown in a field ("YYYY-MM-DD HH:mm:ss",
 * "YYYY-MM-DD", "HH:mm:ss", or wire-format ISO). Missing parts fall back to
 * `now` for the date and midnight for the time. Returns null if nothing
 * date/time-like is present.
 */
export function parseDateTimeText(text: string, kind: DateTimeKind, now: Date = new Date()): DateTimeParts | null {
  const dateMatch = kind !== "time" ? DATE_RE.exec(text) : null;
  const timeMatch = kind !== "date" ? TIME_RE.exec(kind === "datetime" ? text.slice(dateMatch ? dateMatch.index + dateMatch[0].length : 0) : text) : null;
  if (!dateMatch && !timeMatch) return null;

  const parts: DateTimeParts = {
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    day: now.getDate(),
    hour: 0,
    minute: 0,
    second: 0,
  };
  if (dateMatch) {
    parts.year = Number(dateMatch[1]);
    parts.month = Number(dateMatch[2]);
    parts.day = Number(dateMatch[3]);
  }
  if (timeMatch) {
    parts.hour = Number(timeMatch[1]);
    parts.minute = Number(timeMatch[2]);
    parts.second = timeMatch[3] !== undefined ? Number(timeMatch[3]) : 0;
  }
  return clampParts(parts);
}

export function partsFromDate(date: Date): DateTimeParts {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes(),
    second: date.getSeconds(),
  };
}

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/** Bring every component into range (day is clamped to the month's length). */
export function clampParts(p: DateTimeParts): DateTimeParts {
  const month = Math.min(12, Math.max(1, p.month || 1));
  const year = Number.isFinite(p.year) ? p.year : new Date().getFullYear();
  return {
    year,
    month,
    day: Math.min(daysInMonth(year, month), Math.max(1, p.day || 1)),
    hour: Math.min(23, Math.max(0, p.hour || 0)),
    minute: Math.min(59, Math.max(0, p.minute || 0)),
    second: Math.min(59, Math.max(0, p.second || 0)),
  };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Text in the same shape the field displays and the edit store accepts. */
export function formatDateTimeParts(p: DateTimeParts, kind: DateTimeKind): string {
  const date = `${String(p.year).padStart(4, "0")}-${pad(p.month)}-${pad(p.day)}`;
  const time = `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
  if (kind === "date") return date;
  if (kind === "time") return time;
  return `${date} ${time}`;
}
