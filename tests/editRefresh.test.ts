import { describe, expect, test } from "bun:test";
import { tableRefreshKey, useEditStore } from "../src/lib/editStore";

describe("targeted table refresh", () => {
  test("increments each affected table once per commit batch", () => {
    const users = { connectionId: "conn", db: "app", schema: "public", table: "users" };
    const orders = { connectionId: "conn", db: "app", schema: "public", table: "orders" };
    const beforeUsers = useEditStore.getState().tableRevisions.get(tableRefreshKey(users)) ?? 0;
    const beforeOrders = useEditStore.getState().tableRevisions.get(tableRefreshKey(orders)) ?? 0;

    useEditStore.getState().requestDataRefresh([users, users, orders]);

    expect(useEditStore.getState().tableRevisions.get(tableRefreshKey(users))).toBe(beforeUsers + 1);
    expect(useEditStore.getState().tableRevisions.get(tableRefreshKey(orders))).toBe(beforeOrders + 1);
  });
});
