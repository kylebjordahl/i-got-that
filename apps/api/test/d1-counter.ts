/**
 * Wrap a D1 binding so a spec can count what the code under test sends it.
 *
 * Every D1 call is a subrequest (10,000 per queue-consumer invocation, shared
 * by everything the tick does) and every row it writes is billed, so "how many
 * statements, how many round trips, how many rows" is the budget the pipeline's
 * batching work is measured against. Local miniflare D1 answers at memory speed
 * and never complains, which is exactly why a regression here is invisible
 * without a counter.
 *
 * What is counted, and how it maps onto D1's own accounting:
 *  - `roundTrips`: a prepared statement run on its own (`run`/`all`/`first`/
 *    `raw`) is one; a `batch()` of any size is one. This is the number that
 *    tracks subrequests and wall time.
 *  - `statements`: SQL statements executed — a batch of 50 counts 50. This is
 *    what the code *issues*, whatever it costs to deliver.
 *  - `writeStatements`: the INSERT/UPDATE/DELETE/REPLACE subset of those.
 *  - `rowsWritten`: the sum of `meta.rows_written` D1 reports (the figure it
 *    bills on); a no-op `ON CONFLICT DO UPDATE ... WHERE false` reports 0.
 *    Only `run()`, `all()` and `batch()` results carry meta. drizzle reads a
 *    plain SELECT through `raw()`, which doesn't, but those write nothing; a
 *    `.returning()` write also arrives through `raw()`, so that one is re-run
 *    as `all()` here to get its meta.
 */
export interface D1Stats {
  roundTrips: number;
  statements: number;
  batches: number;
  /** How many statements each `batch()` carried, in call order. */
  batchSizes: number[];
  writeStatements: number;
  /** Write statements sent on their own rather than inside a `batch()`. */
  unbatchedWrites: number;
  rowsWritten: number;
  /** `rowsWritten` split by the table the statement wrote to. */
  rowsWrittenBy: Record<string, number>;
  /** Every statement's SQL, in execution order (batch members in batch order). */
  log: string[];
}

export interface CountingD1 {
  db: D1Database;
  stats: D1Stats;
  /** Zero the counters (and the log) — call between the phases being measured. */
  reset(): void;
  /** A copy of the current counters, without the log. */
  snapshot(): Omit<D1Stats, 'log'>;
}

const WRITE = /^\s*(insert|update|delete|replace)\b/i;
const WRITE_TARGET = /^\s*(?:insert\s+(?:or\s+\w+\s+)?into|replace\s+into|update(?:\s+or\s+\w+)?|delete\s+from)\s+["`]?(\w+)/i;

export interface CountD1Options {
  /**
   * Reject any statement binding more than this many parameters, as D1 itself
   * does at 100. Local miniflare would bind thousands, so without this a
   * pipeline stage that fans a list out over one statement passes here and 500s
   * on the edge (see `lib/d1.ts`).
   */
  maxBoundParams?: number;
}

export function countD1(real: D1Database, options: CountD1Options = {}): CountingD1 {
  const stats: D1Stats = {
    roundTrips: 0,
    statements: 0,
    batches: 0,
    batchSizes: [],
    writeStatements: 0,
    unbatchedWrites: 0,
    rowsWritten: 0,
    rowsWrittenBy: {},
    log: [],
  };

  // A proxy handed back from `prepare`/`bind` -> the statement it stands for and
  // the SQL it was prepared with, so `batch()` can unwrap its members and count
  // them by SQL.
  const sqlOf = new WeakMap<object, string>();
  const rawOf = new WeakMap<object, D1PreparedStatement>();

  const record = (
    sql: string,
    result?: { meta?: Record<string, unknown> },
    inBatch = false,
  ) => {
    stats.statements++;
    stats.log.push(sql);
    if (WRITE.test(sql)) {
      stats.writeStatements++;
      if (!inBatch) stats.unbatchedWrites++;
    }
    const written = result?.meta?.rows_written;
    if (typeof written === 'number') {
      stats.rowsWritten += written;
      const table = WRITE_TARGET.exec(sql)?.[1];
      if (table) stats.rowsWrittenBy[table] = (stats.rowsWrittenBy[table] ?? 0) + written;
    }
  };

  const wrap = (stmt: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy: D1PreparedStatement = new Proxy(stmt, {
      get(target, prop) {
        if (prop === 'bind') {
          return (...values: unknown[]) => {
            if (options.maxBoundParams != null && values.length > options.maxBoundParams) {
              throw new Error(
                `too many SQL variables at offset 0: SQLITE_ERROR (${values.length} bound)`,
              );
            }
            return wrap(target.bind(...values), sql);
          };
        }
        if (prop === 'run' || prop === 'all') {
          return async () => {
            const result = await (target[prop] as () => Promise<{ meta?: Record<string, unknown> }>)();
            stats.roundTrips++;
            record(sql, result);
            return result;
          };
        }
        if (prop === 'raw' && WRITE.test(sql)) {
          // drizzle reads a `.returning()` write through raw(), which carries no
          // meta; run it as all() instead (same rows, keyed by column) so its
          // rows_written is counted, and hand back the arrays raw() would have.
          return async () => {
            const result = await target.all<Record<string, unknown>>();
            stats.roundTrips++;
            record(sql, result);
            return (result.results ?? []).map((row) => Object.values(row));
          };
        }
        if (prop === 'first' || prop === 'raw') {
          return async (...args: unknown[]) => {
            const out = await (target[prop] as (...a: unknown[]) => Promise<unknown>)(...args);
            stats.roundTrips++;
            record(sql);
            return out;
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    sqlOf.set(proxy, sql);
    rawOf.set(proxy, stmt);
    return proxy;
  };

  const db = new Proxy(real, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => wrap(target.prepare(sql), sql);
      }
      if (prop === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch(statements.map((s) => rawOf.get(s) ?? s));
          stats.roundTrips++;
          stats.batches++;
          stats.batchSizes.push(statements.length);
          statements.forEach((s, i) => record(sqlOf.get(s) ?? '(unknown)', results[i], true));
          return results;
        };
      }
      if (prop === 'exec') {
        return async (sql: string) => {
          const out = await target.exec(sql);
          stats.roundTrips++;
          record(sql);
          return out;
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const zero = () => {
    stats.roundTrips = 0;
    stats.statements = 0;
    stats.batches = 0;
    stats.batchSizes = [];
    stats.writeStatements = 0;
    stats.unbatchedWrites = 0;
    stats.rowsWritten = 0;
    stats.rowsWrittenBy = {};
    stats.log.length = 0;
  };

  return {
    db,
    stats,
    reset: zero,
    snapshot: () => ({
      roundTrips: stats.roundTrips,
      statements: stats.statements,
      batches: stats.batches,
      batchSizes: [...stats.batchSizes],
      writeStatements: stats.writeStatements,
      unbatchedWrites: stats.unbatchedWrites,
      rowsWritten: stats.rowsWritten,
      rowsWrittenBy: { ...stats.rowsWrittenBy },
    }),
  };
}
