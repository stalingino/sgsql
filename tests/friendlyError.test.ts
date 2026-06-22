import { describe, expect, test } from "bun:test";
import { friendlyError } from "../sidecar/lib/friendlyError";

describe("friendly connection errors", () => {
  test("preserves SSH layer diagnostics instead of collapsing them", () => {
    expect(friendlyError(new Error("SSH connection to bastion.example.com:22 timed out.")))
      .toBe("SSH connection to bastion.example.com:22 timed out.");
  });

  test("still simplifies direct connection timeouts", () => {
    const error = Object.assign(new Error("connect timed out"), { code: "ETIMEDOUT" });
    expect(friendlyError(error)).toBe("Connection timed out. The host is unreachable or not responding.");
  });
});
