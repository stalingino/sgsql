import { describe, expect, test } from "bun:test";
import { formatDuration } from "../src/components/ProcessList";

describe("formatDuration", () => {
  test("uses the two largest units", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(59)).toBe("59s");
    expect(formatDuration(61)).toBe("1m 1s");
    expect(formatDuration(3_725)).toBe("1h 2m");
    expect(formatDuration(90_000)).toBe("1d 1h");
  });
});
