import { beforeEach, describe, expect, test } from "bun:test";
import { useEditStore, type RowKey } from "../src/lib/editStore";

const rowKey = (id: number): RowKey => ({
  connectionId: "conn",
  connectionType: "postgres",
  db: "app",
  schema: "public",
  table: "users",
  pkValues: { id },
});

describe("saving pending changes", () => {
  beforeEach(() => {
    useEditStore.getState().revertAll();
    useEditStore.getState().clearSaveError();
  });

  test("keeps the failure in the store and stops at the first error", async () => {
    const store = useEditStore.getState();
    store.setChange(rowKey(1), "name", "a", "b");
    store.setChange(rowKey(2), "name", "c", "d");

    const executed: string[] = [];
    const ok = await store.saveAll(async (_conn, sql) => {
      executed.push(sql);
      if (executed.length === 2) throw new Error("duplicate key");
    });

    expect(ok).toBe(false);
    expect(executed).toHaveLength(2);
    expect(useEditStore.getState().saveError).toBe("UPDATE users: duplicate key");
    expect(useEditStore.getState().saving).toBe(false);
    // The first statement succeeded and was removed; the failing one stays pending.
    expect(useEditStore.getState().changes.size).toBe(1);
  });

  test("clears the failure once the pending set changes", async () => {
    const store = useEditStore.getState();
    store.setChange(rowKey(1), "name", "a", "b");
    await store.saveRow(rowKey(1), async () => { throw new Error("permission denied"); });
    expect(useEditStore.getState().saveError).toBe("UPDATE users: permission denied");

    useEditStore.getState().setChange(rowKey(1), "name", "a", "c");
    expect(useEditStore.getState().saveError).toBeNull();
  });
});
