export type QueryHistory = Record<string, string[]>;

export const QUERY_HISTORY_MAX = 50;

/**
 * A saved query belongs to a connection profile and database workspace. The
 * length prefix keeps arbitrary profile/database names from colliding.
 */
export function queryHistoryKey(profileId: string, database: string): string {
  return `${profileId.length}:${profileId}${database}`;
}

export function pushQueryHistory(
  history: QueryHistory,
  profileId: string,
  database: string,
  sqlStatements: readonly string[],
): QueryHistory {
  const additions = sqlStatements.filter((sql) => sql.trim());
  if (additions.length === 0) return history;

  const key = queryHistoryKey(profileId, database);
  const stack = [...(history[key] ?? []), ...additions].slice(-QUERY_HISTORY_MAX);
  return { ...history, [key]: stack };
}

export function popQueryHistory(
  history: QueryHistory,
  profileId: string,
  database: string,
): { history: QueryHistory; sql: string } {
  const key = queryHistoryKey(profileId, database);
  const stack = history[key] ?? [];
  if (stack.length === 0) return { history, sql: "" };

  return {
    history: { ...history, [key]: stack.slice(0, -1) },
    sql: stack[stack.length - 1],
  };
}
