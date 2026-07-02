import type { Sql } from "postgres";
import type { Connection } from "mysql2/promise";
import { Database } from "bun:sqlite";
import type { PoolEntry } from "./pool";
import { appendQueryLog } from "./queryLogHub";

export interface QueryTraceEntry {
  connectionId: string;
  query: string;
  timestamp: string;
  duration: number;
  rowCount?: number;
  error?: string;
}

const instrumentedEntries = new WeakSet<object>();

function errorFields(cause: unknown): Pick<QueryTraceEntry, "error"> & { cancelled?: boolean; cancelDetail?: string } {
  const error = cause instanceof Error ? cause.message : String(cause);
  const cancelled = /cancelled|canceled|canceling statement|aborted|interrupted|killed/i.test(error);
  return cancelled ? { error, cancelled: true, cancelDetail: error } : { error };
}

function resultRowCount(result: any): number | undefined {
  if (typeof result?.count === "number") return result.count;
  if (Array.isArray(result)) {
    if (Array.isArray(result[0])) return result[0].length;
    if (typeof result[0]?.affectedRows === "number") return result[0].affectedRows;
    return result.length;
  }
  if (typeof result?.affectedRows === "number") return result.affectedRows;
  if (typeof result?.changes === "number") return result.changes;
  return undefined;
}

function trace<T>(connectionId: string, db: string, query: string, execute: () => T): T {
  const timestamp = new Date().toISOString();
  const started = performance.now();
  try {
    const result = execute();
    if (result && typeof (result as any).then === "function") {
      return (result as any).then(
        (value: any) => {
          appendQueryLog({ connectionId, db, query, timestamp, duration: performance.now() - started, rowCount: resultRowCount(value) });
          return value;
        },
        (cause: unknown) => {
          appendQueryLog({ connectionId, db, query, timestamp, duration: performance.now() - started, ...errorFields(cause) });
          throw cause;
        },
      );
    }
    appendQueryLog({ connectionId, db, query, timestamp, duration: performance.now() - started, rowCount: resultRowCount(result) });
    return result;
  } catch (cause) {
    appendQueryLog({ connectionId, db, query, timestamp, duration: performance.now() - started, ...errorFields(cause) });
    throw cause;
  }
}

function postgresQuery(strings: TemplateStringsArray, values: unknown[]): string {
  return strings.reduce((sql, part, index) => sql + part + (index < values.length ? `$${index + 1}` : ""), "").trim();
}

function instrumentPostgres(connectionId: string, db: string, client: Sql): Sql {
  const wrap = (executor: any): any => new Proxy(executor, {
    apply(target, thisArg, args: [TemplateStringsArray, ...unknown[]]) {
      return trace(connectionId, db, postgresQuery(args[0], args.slice(1)), () => Reflect.apply(target, thisArg, args));
    },
    get(target, property, receiver) {
      if (property === "unsafe") {
        return (sql: string, ...args: unknown[]) => trace(connectionId, db, sql, () => target.unsafe(sql, ...args));
      }
      if (property === "begin") {
        return (...args: any[]) => {
          const callbackIndex = args.findIndex((arg) => typeof arg === "function");
          if (callbackIndex >= 0) {
            const callback = args[callbackIndex];
            args[callbackIndex] = (transaction: any) => callback(wrap(transaction));
          }
          return target.begin(...args);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return wrap(client) as Sql;
}

function mysqlQueryText(sql: unknown): string {
  if (typeof sql === "string") return sql;
  if (sql && typeof sql === "object" && "sql" in sql) return String((sql as { sql: unknown }).sql);
  return String(sql);
}

function instrumentMysql(connectionId: string, db: string, client: Connection): Connection {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === "query" || property === "execute") {
        return (sql: unknown, ...args: unknown[]) => trace(connectionId, db, mysqlQueryText(sql), () => (target as any)[property](sql, ...args));
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function instrumentSqlite(connectionId: string, db: string, client: Database): Database {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === "run" || property === "exec") {
        return (sql: string, ...args: unknown[]) => trace(connectionId, db, sql, () => (target as any)[property](sql, ...args));
      }
      if (property === "query" || property === "prepare") {
        return (sql: string, ...args: unknown[]) => {
          const statement = (target as any)[property](sql, ...args);
          return new Proxy(statement, {
            get(statementTarget, statementProperty, statementReceiver) {
              if (statementProperty === "all" || statementProperty === "get" || statementProperty === "run" || statementProperty === "values") {
                return (...statementArgs: unknown[]) => trace(connectionId, db, sql, () => statementTarget[statementProperty](...statementArgs));
              }
              const value = Reflect.get(statementTarget, statementProperty, statementReceiver);
              return typeof value === "function" ? value.bind(statementTarget) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Database;
}

export function instrumentConnection(connectionId: string, db: string, entry: PoolEntry): PoolEntry {
  if (instrumentedEntries.has(entry as object)) return entry;

  switch (entry.type) {
    case "postgres": entry.client = instrumentPostgres(connectionId, db, entry.client); break;
    case "mysql": entry.client = instrumentMysql(connectionId, db, entry.client); break;
    case "sqlite": entry.client = instrumentSqlite(connectionId, db, entry.client); break;
  }
  instrumentedEntries.add(entry as object);
  return entry;
}
