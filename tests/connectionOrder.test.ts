import { describe, expect, test } from "bun:test";
import { reconcileItemGroup, resolveConnectionDropFolder } from "../src/lib/connectionOrder";

describe("connection folder ordering", () => {
  test("moves a connection into the folder identified by the drop target", () => {
    const result = reconcileItemGroup(
      {
        "folder:Connections": ["connection:a", "connection:b"],
        "folder:Production": ["connection:c"],
      },
      "connection:b",
      "folder:Production",
      1,
    );

    expect(result).toEqual({
      "folder:Connections": ["connection:a"],
      "folder:Production": ["connection:c", "connection:b"],
    });
  });

  test("preserves the projected order when dnd-kit already moved the item", () => {
    const groups = {
      "folder:Connections": ["connection:a"],
      "folder:Production": ["connection:b", "connection:c"],
    };

    expect(reconcileItemGroup(groups, "connection:b", "folder:Production", 1)).toEqual(groups);
  });

  test("prefers the last real hovered folder over the source's stale target data", () => {
    expect(resolveConnectionDropFolder(
      ["Connections", "Production"],
      "Production",
      "folder-order",
      "Connections",
    )).toBe("Production");
  });
});
