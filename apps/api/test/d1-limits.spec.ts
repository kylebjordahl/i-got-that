import { env } from 'cloudflare:test';
import { calendarEvents, getDb, inArray, tasks, taskOwners } from '@igt/db';
import { describe, expect, it } from 'vitest';
import { chunkForD1, D1_MAX_BOUND_PARAMS, runChunked, selectChunked } from '../src/lib/d1.js';
import { reconcileClaimEvents } from '../src/services/claim.js';
import { claimedTaskMeta } from '../src/services/mirror.js';
import { withOwners } from '../src/services/task-owners.js';
import { bearer, call, setupFamily } from './helpers.js';

/**
 * D1 rejects a statement binding more than 100 parameters. Miniflare's local D1
 * — what these tests run against — is ordinary SQLite and happily binds
 * thousands, so a `GET /tasks` over 101 tasks passed CI and 500'd on staging.
 * `cappedDb` puts the real limit back in front of the local database so the
 * regression can actually be caught here.
 */
function cappedDb(db: D1Database): D1Database {
  const wrapStatement = (stmt: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(stmt, {
      get(target, prop, receiver) {
        if (prop === 'bind') {
          return (...values: unknown[]) => {
            if (values.length > D1_MAX_BOUND_PARAMS) {
              throw new Error(
                `too many SQL variables at offset 0: SQLITE_ERROR (${values.length} bound)`,
              );
            }
            return wrapStatement(target.bind(...values));
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (sql: string) => wrapStatement(target.prepare(sql));
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('D1 bound-parameter chunking', () => {
  it('splits a list into runs that fit the parameter budget', () => {
    expect(chunkForD1([])).toEqual([]);
    expect(chunkForD1(Array.from({ length: 100 }, (_, i) => i))).toHaveLength(1);
    expect(chunkForD1(Array.from({ length: 101 }, (_, i) => i)).map((c) => c.length)).toEqual([
      100, 1,
    ]);
    expect(chunkForD1(Array.from({ length: 250 }, (_, i) => i)).map((c) => c.length)).toEqual([
      100, 100, 50,
    ]);
  });

  it('leaves room for the parameters the rest of the statement binds', () => {
    expect(chunkForD1(Array.from({ length: 100 }, (_, i) => i), 3).map((c) => c.length)).toEqual([
      97, 3,
    ]);
    // A statement with no budget left still makes progress one id at a time.
    expect(chunkForD1([1, 2], D1_MAX_BOUND_PARAMS).map((c) => c.length)).toEqual([1, 1]);
  });

  it('keeps chunk order when collecting and when writing', async () => {
    const seen: number[][] = [];
    const rows = await selectChunked(
      Array.from({ length: 250 }, (_, i) => i),
      async (chunk) => {
        seen.push(chunk);
        return chunk;
      },
    );
    expect(rows).toEqual(Array.from({ length: 250 }, (_, i) => i));
    expect(seen).toHaveLength(3);

    const written: number[] = [];
    await runChunked(Array.from({ length: 101 }, (_, i) => i), async (chunk) => {
      written.push(chunk.length);
    });
    expect(written).toEqual([100, 1]);
  });

  it('the cap guard rejects an unchunked list, so the test below means something', () => {
    const db = cappedDb(env.DB);
    const placeholders = Array.from({ length: 101 }, () => '?').join(',');
    expect(() =>
      db.prepare(`select 1 from tasks where id in (${placeholders})`).bind(
        ...Array.from({ length: 101 }, (_, i) => `${i}`),
      ),
    ).toThrow(/too many SQL variables/);
  });

  it('decorates more tasks with their owners than D1 will bind at once', async () => {
    const { admin, familyId, adminMemberId, childId } = await setupFamily(
      'd1-chunking@example.com',
    );
    const db = getDb(env.DB);
    const count = D1_MAX_BOUND_PARAMS + 51; // two chunks and change
    const rows = Array.from({ length: count }, (_, i) => ({
      familyId,
      familyMemberId: childId,
      type: 'pickup' as const,
      dtstart: new Date(Date.UTC(2026, 6, 6, 15, 0) + i * 60_000),
      status: 'unowned' as const,
      createdVia: 'generated' as const,
    }));
    const inserted: (typeof tasks.$inferSelect)[] = [];
    for (let i = 0; i < rows.length; i += 10) {
      inserted.push(...(await db.insert(tasks).values(rows.slice(i, i + 10)).returning()));
    }
    // Owners on the first and last task, so a chunking bug that drops a chunk
    // (or mixes their rows up) shows as a wrong owner set, not just a 500.
    const first = inserted[0]!;
    const last = inserted[inserted.length - 1]!;
    for (const task of [first, last]) {
      await db.insert(taskOwners).values({ taskId: task.id, familyMemberId: adminMemberId });
    }

    const decorated = await withOwners(getDb(cappedDb(env.DB)), inserted);
    expect(decorated).toHaveLength(count);
    expect(decorated.find((t) => t.id === first.id)!.ownerMemberIds).toEqual([adminMemberId]);
    expect(decorated.find((t) => t.id === last.id)!.ownerMemberIds).toEqual([adminMemberId]);
    expect(decorated.filter((t) => t.ownerMemberIds.length > 0)).toHaveLength(2);

    // And end to end: the list the home screen loads comes back whole.
    const res = await call(`/families/${familyId}/tasks`, bearer(admin.token));
    expect(res.status).toBe(200);
    const { tasks: listed } = (await res.json()) as {
      tasks: { id: string; ownerMemberIds: string[] }[];
    };
    expect(listed.length).toBeGreaterThanOrEqual(count);
    expect(listed.find((t) => t.id === last.id)!.ownerMemberIds).toEqual([adminMemberId]);
  });

  it('looks up the task metadata of more claimed events than D1 will bind at once', async () => {
    const { familyId, childId } = await setupFamily('d1-task-meta@example.com');
    const db = getDb(env.DB);
    const inserted: (typeof tasks.$inferSelect)[] = [];
    for (let i = 0; i < D1_MAX_BOUND_PARAMS + 30; i += 10) {
      inserted.push(
        ...(await db
          .insert(tasks)
          .values(
            Array.from({ length: 10 }, (_, j) => ({
              familyId,
              familyMemberId: childId,
              type: (j % 2 === 0 ? 'pickup' : 'dropoff') as 'pickup' | 'dropoff',
              dtstart: new Date(Date.now() + (i + j) * 60_000),
              status: 'owned' as const,
              createdVia: 'generated' as const,
            })),
          )
          .returning()),
      );
    }

    const meta = await claimedTaskMeta(
      getDb(cappedDb(env.DB)),
      // Repeats are one lookup, not a chunk's worth of parameters.
      [...inserted, ...inserted].map((t) => t.id),
    );
    expect(meta.size).toBe(inserted.length);
    expect(meta.get(inserted[0]!.id)).toMatchObject({ type: 'pickup' });
    expect(meta.get(inserted[inserted.length - 1]!.id)).toMatchObject({ type: 'dropoff' });
  });

  it('trues up claimed events for more tasks than D1 will bind at once', async () => {
    const { familyId, childId, adminMemberId } = await setupFamily('d1-claim-trueup@example.com');
    const db = getDb(env.DB);
    const day = 24 * 60 * 60_000;
    const soon = Date.now() + day;
    const longAgo = Date.now() - 180 * day;
    // Past each statement's budget, so every batched lookup takes more than one chunk.
    const count = D1_MAX_BOUND_PARAMS + 5;

    async function insertTasks(
      n: number,
      status: 'owned' | 'unowned',
      at: number,
      values: (i: number) => Partial<typeof tasks.$inferInsert> = () => ({}),
    ) {
      const out: (typeof tasks.$inferSelect)[] = [];
      for (let i = 0; i < n; i += 5) {
        out.push(
          ...(await db
            .insert(tasks)
            .values(
              Array.from({ length: Math.min(5, n - i) }, (_, j) => ({
                familyId,
                familyMemberId: childId,
                type: 'attendance' as const,
                dtstart: new Date(at + (i + j) * 60_000),
                dtend: new Date(at + (i + j) * 60_000 + 30 * 60_000),
                status,
                createdVia: 'generated' as const,
                ...values(i + j),
              })),
            )
            .returning()),
        );
      }
      return out;
    }
    async function insertOwners(rows: (typeof tasks.$inferSelect)[]) {
      for (let i = 0; i < rows.length; i += 10) {
        await db
          .insert(taskOwners)
          .values(rows.slice(i, i + 10).map((t) => ({ taskId: t.id, familyMemberId: adminMemberId })));
      }
    }
    async function insertClaims(rows: (typeof tasks.$inferSelect)[], at: number) {
      for (let i = 0; i < rows.length; i += 5) {
        await db.insert(calendarEvents).values(
          rows.slice(i, i + 5).map((t, j) => ({
            familyId,
            familyMemberId: adminMemberId,
            provenance: 'claimed_task' as const,
            synthKey: `task:${t.id}`,
            taskId: t.id,
            contentHash: 'stale',
            dtstart: new Date(at + (i + j) * 60_000),
          })),
        );
      }
    }
    const claimsOf = (ids: string[]) =>
      selectChunked(ids, (chunk) =>
        db.select().from(calendarEvents).where(inArray(calendarEvents.taskId, chunk)),
      );

    // Attendance tasks about real events, so the source lookup is batched too.
    const sources: (typeof calendarEvents.$inferSelect)[] = [];
    for (let i = 0; i < count; i += 5) {
      sources.push(
        ...(await db
          .insert(calendarEvents)
          .values(
            Array.from({ length: Math.min(5, count - i) }, (_, j) => ({
              familyId,
              familyMemberId: childId,
              provenance: 'synthesized' as const,
              synthKey: `ev:src:${i + j}`,
              contentHash: 'h',
              summary: `Practice ${i + j}`,
              dtstart: new Date(soon + (i + j) * 60_000),
            })),
          )
          .returning()),
      );
    }
    const current = await insertTasks(count, 'owned', soon, (i) => ({
      calendarEventId: sources[i]!.id,
    }));
    await insertOwners(current);
    // Finished long ago, but its claim has drifted onto the horizon: not a stray.
    const drifted = await insertTasks(count, 'owned', longAgo);
    await insertOwners(drifted);
    await insertClaims(drifted, soon);
    // No longer owned, claim left behind: strays to sweep.
    const strays = await insertTasks(count, 'unowned', soon);
    await insertClaims(strays, soon);

    await reconcileClaimEvents(getDb(cappedDb(env.DB)), familyId);

    const made = await claimsOf(current.map((t) => t.id));
    expect(made).toHaveLength(count);
    expect(made.map((e) => e.summary).sort()).toEqual(
      sources.map((s) => s.summary).sort(), // the batched source events reached each claim
    );
    const kept = await claimsOf(drifted.map((t) => t.id));
    expect(kept).toHaveLength(count);
    expect(kept.every((e) => e.dtstart.getTime() < Date.now() - 100 * day)).toBe(true);
    expect(await claimsOf(strays.map((t) => t.id))).toHaveLength(0);
  });
});
