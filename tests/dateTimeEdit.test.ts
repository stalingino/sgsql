import { describe, expect, test } from "bun:test";
import { formatDateTimeParts, getDateTimeKind, parseDateTimeText } from "../src/lib/dateTimeEdit";

describe("getDateTimeKind", () => {
  test("classifies common column types", () => {
    expect(getDateTimeKind("datetime")).toBe("datetime");
    expect(getDateTimeKind("timestamp")).toBe("datetime");
    expect(getDateTimeKind("timestamptz")).toBe("datetime");
    expect(getDateTimeKind("timestamp without time zone")).toBe("datetime");
    expect(getDateTimeKind("date")).toBe("date");
    expect(getDateTimeKind("time")).toBe("time");
    expect(getDateTimeKind("time with time zone")).toBe("time");
    expect(getDateTimeKind("varchar(50)")).toBeNull();
    expect(getDateTimeKind("int")).toBeNull();
  });
});

describe("parseDateTimeText / formatDateTimeParts", () => {
  const now = new Date(2026, 8, 11, 10, 20, 30);

  test("round-trips display text", () => {
    const p = parseDateTimeText("2026-09-10 22:51:47", "datetime", now)!;
    expect(formatDateTimeParts(p, "datetime")).toBe("2026-09-10 22:51:47");
    expect(formatDateTimeParts(parseDateTimeText("2026-02-03", "date", now)!, "date")).toBe("2026-02-03");
    expect(formatDateTimeParts(parseDateTimeText("07:05:00", "time", now)!, "time")).toBe("07:05:00");
  });

  test("accepts wire-format ISO and partial text", () => {
    expect(formatDateTimeParts(parseDateTimeText("2026-09-10T22:51:47.123", "datetime", now)!, "datetime")).toBe("2026-09-10 22:51:47");
    // date only in a datetime column → midnight
    expect(formatDateTimeParts(parseDateTimeText("2026-09-10", "datetime", now)!, "datetime")).toBe("2026-09-10 00:00:00");
    // time without seconds
    expect(formatDateTimeParts(parseDateTimeText("9:05", "time", now)!, "time")).toBe("09:05:00");
  });

  test("returns null for non-date text and clamps out-of-range parts", () => {
    expect(parseDateTimeText("hello", "datetime", now)).toBeNull();
    expect(parseDateTimeText("", "date", now)).toBeNull();
    expect(formatDateTimeParts(parseDateTimeText("2026-02-31 25:61:99", "datetime", now)!, "datetime")).toBe("2026-02-28 23:59:59");
  });
});
