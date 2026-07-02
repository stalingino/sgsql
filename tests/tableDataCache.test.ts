import { beforeEach, describe, expect, test } from "bun:test";
import {
  cacheTableRows,
  clearTableDataCache,
  getCachedTableRows,
  loadTableColumns,
  loadTableRows,
  type TableRowsCacheTarget,
} from "../src/lib/tableDataCache";
import type { TableRowsResult } from "../src/lib/schema";

const target: TableRowsCacheTarget = {
  connectionId: "preprod",
  db: "app",
  schema: "public",
  table: "customer",
  offset: 0,
  orderBy: "id DESC",
  tableRevision: 0,
};
const result = { columns: ["id"], rows: [[1]], totalEstimate: 1 } as TableRowsResult;

describe("table data cache", () => {
  beforeEach(clearTableDataCache);

  test("restores rows for the exact connection and query state", () => {
    cacheTableRows(target, result);
    expect(getCachedTableRows(target)).toBe(result);
    expect(getCachedTableRows({ ...target, connectionId: "uat" })).toBeUndefined();
  });

  test("does not reuse stale rows after a table refresh", () => {
    cacheTableRows(target, result);
    expect(getCachedTableRows({ ...target, tableRevision: 1 })).toBeUndefined();
  });

  test("separates pages, sorting, and filters", () => {
    cacheTableRows(target, result);
    expect(getCachedTableRows({ ...target, offset: 50 })).toBeUndefined();
    expect(getCachedTableRows({ ...target, orderBy: "name ASC" })).toBeUndefined();
    expect(getCachedTableRows({ ...target, where: "active = true" })).toBeUndefined();
  });

  test("deduplicates identical in-flight row loads", async () => {
    let resolve!: (value: TableRowsResult) => void;
    let loads = 0;
    const loader = () => {
      loads += 1;
      return new Promise<TableRowsResult>((done) => { resolve = done; });
    };

    const first = loadTableRows(target, loader);
    const second = loadTableRows(target, loader);
    expect(second).toBe(first);
    expect(loads).toBe(1);

    resolve(result);
    expect(await first).toBe(result);
    expect(await loadTableRows(target, loader)).toBe(result);
    expect(loads).toBe(1);
  });

  test("deduplicates identical in-flight column loads", async () => {
    const columnTarget = { connectionId: "preprod", db: "app", schema: "public", table: "customer" };
    const result = [{ name: "id" }] as any;
    let resolve!: (value: any) => void;
    let loads = 0;
    const loader = () => {
      loads += 1;
      return new Promise<any>((done) => { resolve = done; });
    };

    const first = loadTableColumns(columnTarget, loader);
    const second = loadTableColumns(columnTarget, loader);
    expect(second).toBe(first);
    expect(loads).toBe(1);
    resolve(result);
    expect(await first).toBe(result);
  });
});
