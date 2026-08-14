function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Format a real Date instant as "YYYY-MM-DD HH:mm:ss" in the local timezone. */
export function formatLocalDateTime(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// Zoned instants (Postgres timestamptz) end in Z. Naive timestamps (MySQL
// TIMESTAMP/DATETIME and Postgres timestamp) deliberately do not: their
// digits are wall-clock values and must not be shifted by the browser.
const ISO_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z)?$/;

/**
 * Reformat a wire-format date/timestamp value into "YYYY-MM-DD HH:mm:ss"
 * local time. Naive timestamps retain their wall-clock digits.
 *
 * The sidecar serializes timestamps without a timezone without a trailing
 * zone marker, so those are reformatted directly. True timestamptz/instant
 * values end in Z and are converted to the browser's local timezone.
 *
 * Returns null when `value` isn't a wire-format date/timestamp string, so
 * callers can fall back to their normal formatting.
 */
export function formatDateTimeValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = ISO_DATETIME_RE.exec(value);
  if (!match) return null;

  const wallClock = `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6]}`;
  if (!match[7]) return wallClock;

  const date = new Date(value);
  if (isNaN(date.getTime())) return null;
  return formatLocalDateTime(date);
}
