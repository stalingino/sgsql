function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Format a real Date instant as "YYYY-MM-DD HH:mm:ss" in the local timezone. */
export function formatLocalDateTime(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// Exact shape produced by Date.prototype.toISOString(), which is how the
// sidecar serializes every DB date/timestamp value it hands back.
const ISO_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;

/**
 * Reformat a wire-format date/timestamp value into "YYYY-MM-DD HH:mm:ss"
 * local time, or "YYYY-MM-DD" if it looks like a date-only column.
 *
 * The sidecar's DB drivers parse "timestamp without time zone" values as
 * local wall-clock time, then `JSON.stringify` re-serializes that Date via
 * `toISOString()`, which re-labels the same digits as UTC. Naively printing
 * that string (as `String(value)`) shows time shifted by the local UTC
 * offset. Parsing it back into a `Date` and reading local getters undoes
 * that relabeling and recovers the original wall-clock value — and for
 * true timestamptz/instant values, local getters correctly show local time.
 *
 * Date-only columns arrive as midnight UTC (e.g. "2026-06-28T00:00:00.000Z");
 * reading those with local getters would roll the date back a day in
 * negative-UTC-offset timezones, so they're special-cased to keep the UTC
 * date parts instead.
 *
 * Returns null when `value` isn't a wire-format date/timestamp string, so
 * callers can fall back to their normal formatting.
 */
export function formatDateTimeValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = ISO_DATETIME_RE.exec(value);
  if (!match) return null;

  const isMidnightUTC = match[4] === "00" && match[5] === "00" && match[6] === "00" && match[7] === "000";
  if (isMidnightUTC) {
    return `${match[1]}-${match[2]}-${match[3]}`;
  }

  const date = new Date(value);
  if (isNaN(date.getTime())) return null;
  return formatLocalDateTime(date);
}
