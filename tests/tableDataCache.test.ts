import { beforeEach, describe, expect, test } from "bun:test";
import {
  cacheTableRows,
  clearTableDataCache,
  getCachedTableRows,
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
});
