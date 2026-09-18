import { describe, expect, test } from "bun:test";
import {
  popQueryHistory,
  pushQueryHistory,
  queryHistoryKey,
  QUERY_HISTORY_MAX,
} from "../src/lib/queryHistory";

describe("query history", () => {
  test("restores only within the same connection profile and database", () => {
    let history = {};
    history = pushQueryHistory(history, "prod", "accounts", ["select from prod"]);
    history = pushQueryHistory(history, "staging", "accounts", ["select from staging"]);
    history = pushQueryHistory(history, "prod", "reporting", ["select report"]);

    const prod = popQueryHistory(history, "prod", "accounts");
    expect(prod.sql).toBe("select from prod");
    expect(popQueryHistory(prod.history, "staging", "accounts").sql).toBe("select from staging");
    expect(popQueryHistory(prod.history, "prod", "reporting").sql).toBe("select report");
  });

  test("uses LIFO ordering and ignores blank editors", () => {
    const history = pushQueryHistory({}, "profile", "db", ["first", "  ", "second"]);
    const second = popQueryHistory(history, "profile", "db");
    const first = popQueryHistory(second.history, "profile", "db");
    expect([second.sql, first.sql]).toEqual(["second", "first"]);
  });

  test("retains only the newest entries per workspace", () => {
    const queries = Array.from({ length: QUERY_HISTORY_MAX + 5 }, (_, i) => `query ${i}`);
    const history = pushQueryHistory({}, "profile", "db", queries);
    expect(history[queryHistoryKey("profile", "db")]).toEqual(queries.slice(-QUERY_HISTORY_MAX));
  });

  test("does not collide when profile and database boundaries differ", () => {
    expect(queryHistoryKey("ab", "c")).not.toBe(queryHistoryKey("a", "bc"));
  });
});
