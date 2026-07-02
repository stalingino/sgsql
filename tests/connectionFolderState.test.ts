import { describe, expect, test } from "bun:test";
import {
  decodeCollapsedConnectionFolders,
  encodeCollapsedConnectionFolders,
} from "../src/lib/connectionFolderState";

describe("connection folder collapsed state", () => {
  test("round-trips collapsed folder names", () => {
    const collapsed = new Set(["Connections", "Production"]);
    expect(decodeCollapsedConnectionFolders(encodeCollapsedConnectionFolders(collapsed))).toEqual(collapsed);
  });

  test("ignores invalid persisted values", () => {
    expect(decodeCollapsedConnectionFolders("not json")).toEqual(new Set());
    expect(decodeCollapsedConnectionFolders(JSON.stringify(["Production", 3, ""]))).toEqual(
      new Set(["Production"]),
    );
  });
});
