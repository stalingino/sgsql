import { describe, expect, test } from "bun:test";
import { formatDateTimeValue } from "../src/lib/formatDateTime";

describe("formatDateTimeValue", () => {
  test("preserves naive database timestamp wall-clock values", () => {
    expect(formatDateTimeValue("2026-08-14T17:15:06.000")).toBe("2026-08-14 17:15:06");
    expect(formatDateTimeValue("2026-08-14T17:15:06.123456")).toBe("2026-08-14 17:15:06");
  });

  test("does not collapse a midnight timestamp into a date", () => {
    expect(formatDateTimeValue("2026-08-14T00:00:00.000")).toBe("2026-08-14 00:00:00");
  });

  test("leaves date-only values to the normal string renderer", () => {
    expect(formatDateTimeValue("2026-08-14")).toBeNull();
  });
});
