import { describe, expect, test } from "bun:test";
import { horizontalVisibilityDelta } from "../src/lib/scrollVisibility";

describe("horizontal cell visibility", () => {
  test("does not scroll an already visible cell", () => {
    expect(horizontalVisibilityDelta({
      viewportLeft: 100,
      viewportRight: 500,
      itemLeft: 180,
      itemRight: 320,
    })).toBe(0);
  });

  test("scrolls left to reveal a clipped cell", () => {
    expect(horizontalVisibilityDelta({
      viewportLeft: 100,
      viewportRight: 500,
      itemLeft: 70,
      itemRight: 160,
    })).toBe(-38);
  });

  test("scrolls right to reveal a clipped cell", () => {
    expect(horizontalVisibilityDelta({
      viewportLeft: 100,
      viewportRight: 500,
      itemLeft: 460,
      itemRight: 540,
    })).toBe(48);
  });
});
