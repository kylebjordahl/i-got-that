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
