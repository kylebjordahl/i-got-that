import type { Db } from '@igt/db';

/**
 * D1 caps a single statement at **100 bound parameters** — the 101st comes back
 * as `too many SQL variables at offset N: SQLITE_ERROR`, which surfaces as a
 * 500. Every `inArray(column, ids)` binds one parameter per id, so any query
 * that fans out over a list which grows with a family's data eventually trips
 * it: staging's `GET /tasks` started answering 500 on the day the family's
 * 101st task appeared, because decorating the list with its owners does one
 * `inArray(taskOwners.taskId, everyTaskId)`.
 *
 * Nothing catches this before production. The API tests run against miniflare's
 * local D1, which is ordinary SQLite with `SQLITE_MAX_VARIABLE_NUMBER` in the
 * tens of thousands, so a 500-id `inArray` passes locally and in CI and fails
 * only on the edge. Treat the limit as something you have to reason about
 * rather than something a test will tell you about: an `inArray` over a list
 * that is not bounded by the size of a *family* (members, a member's feeds, a
 * task's owners) goes through the helpers here.
 *
 * `reserved` is the number of parameters the *rest* of the statement binds —
 * Drizzle binds comparison values too, so `and(eq(tasks.familyId, id),
 * inArray(...))` has one reserved parameter.
 */
export const D1_MAX_BOUND_PARAMS = 100;

/** Split `items` into runs that fit inside one statement's parameter budget. */
export function chunkForD1<T>(items: readonly T[], reserved = 0): T[][] {
  const size = Math.max(1, D1_MAX_BOUND_PARAMS - reserved);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Run a SELECT once per chunk and concatenate the rows, in chunk order. */
export async function selectChunked<T, R>(
  items: readonly T[],
  run: (chunk: T[]) => Promise<R[]>,
  reserved = 0,
): Promise<R[]> {
  const out: R[] = [];
  for (const chunk of chunkForD1(items, reserved)) out.push(...(await run(chunk)));
  return out;
}

/** Run a write once per chunk, in order, for its effect. */
export async function runChunked<T>(
  items: readonly T[],
  run: (chunk: T[]) => Promise<unknown>,
  reserved = 0,
): Promise<void> {
  for (const chunk of chunkForD1(items, reserved)) await run(chunk);
}

/** One write a `db.batch()` can carry (any Drizzle insert/update/delete/select). */
export type BatchStatement = Parameters<Db['batch']>[0][number];

/**
 * How many statements one `batch()` carries. A batch is a single D1 call and a
 * single implicit transaction — all of it lands or none of it does — so the cap
 * trades two things: a bigger batch is fewer round trips, but one bad row in it
 * rolls back (and fails) every statement beside it. 50 keeps a feed's worth of
 * upserts to a couple of round trips while a poison row can only hold up its own
 * 49 neighbours, and each statement still binds its own (<=100) parameters, so
 * the per-statement cap above is untouched.
 */
export const D1_BATCH_SIZE = 50;

/**
 * Send `statements` to D1 as `db.batch()` calls of at most `size`, in order, and
 * return every statement's result in the same order — what a `.returning()` in
 * the list yielded, or the run metadata for a plain write.
 *
 * Use it instead of `await`ing a loop of single writes: each of those is its
 * own round trip *and* its own subrequest against the invocation's 10,000
 * (every D1 call counts), where a batch is one of each. Order is preserved across
 * chunks, so a list that must run "deletes, then upserts" still does. Chunks
 * commit one at a time, not as a whole: a failure in chunk N leaves chunks
 * before it applied and throws, exactly as a failure in a loop of single writes
 * would have — callers must stay idempotent (they already have to be, see
 * AGENTS.md "every pipeline insert is idempotent").
 *
 * Build the statements *without* awaiting them (`db.insert(...).values(...)`
 * is a lazy builder; `await` is what runs it). An empty list makes no call.
 */
export async function batchChunked(
  db: Db,
  statements: readonly BatchStatement[],
  size = D1_BATCH_SIZE,
): Promise<unknown[]> {
  const results: unknown[] = [];
  const step = Math.max(1, size);
  for (let i = 0; i < statements.length; i += step) {
    const chunk = statements.slice(i, i + step) as [BatchStatement, ...BatchStatement[]];
    results.push(...(await db.batch(chunk)));
  }
  return results;
}
