import { env } from 'cloudflare:test';
import { calendarTargets, deliveries, eq, getDb, tasks } from '@igt/db';
import {
  type DeliveryEvent,
  type DeliveryProvider,
  DeliveryProviderRegistry,
  type DeliveryTarget,
} from '@igt/delivery';
import type { DeliveryMethod } from '@igt/domain';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, loadSecret } from '../src/lib/secrets.js';
import { cancelTaskDeliveries, deliverTask } from '../src/services/delivery.js';
import { authed, bearer, call, login } from './helpers.js';

class FakeProvider implements DeliveryProvider {
  upserts: { event: DeliveryEvent; target: DeliveryTarget }[] = [];
  cancels: { event: DeliveryEvent; target: DeliveryTarget }[] = [];
  constructor(readonly method: DeliveryMethod) {}
  async upsert(event: DeliveryEvent, target: DeliveryTarget) {
    this.upserts.push({ event, target });
    return { externalRef: `fake-${event.uid}`, sequence: event.sequence };
  }
  async cancel(event: DeliveryEvent, target: DeliveryTarget) {
    this.cancels.push({ event, target });
  }
}

async function adminFamily(email: string) {
  const admin = await login(email);
  const res = await call('/families', authed(admin.token, { name: 'Del Fam' }));
  const { family, member } = (await res.json()) as {
    family: { id: string };
    member: { id: string };
  };
  return { admin, familyId: family.id, memberId: member.id };
}

describe('envelope encryption', () => {
  it('round-trips a secret through encrypt/decrypt', async () => {
    const enc = await encryptSecret(env.KEK, 'app-specific-password');
    expect(enc.ciphertext).toBeTruthy();
    expect(enc.wrappedDek).toBeTruthy();
    const back = await decryptSecret(env.KEK, enc);
    expect(back).toBe('app-specific-password');
  });
});

describe('delivery orchestration', () => {
  it('delivers an owned task, updates on redelivery, and cancels', async () => {
    const { admin, familyId, memberId } = await adminFamily('del-admin@example.com');
    const db = getDb(env.DB);

    const childRes = await call(
      `/families/${familyId}/members`,
      authed(admin.token, { relationName: 'child', requiresCaretaker: true }),
    );
    const { member: child } = (await childRes.json()) as { member: { id: string } };

    // An email target for the admin caretaker.
    const targetRes = await call(
      `/families/${familyId}/calendar-targets`,
      authed(admin.token, {
        memberId,
        name: 'Personal',
        method: 'email',
        addressOrUrl: 'del-admin@example.com',
      }),
    );
    expect(targetRes.status).toBe(201);

    // A task owned by the admin.
    const task = (
      await db
        .insert(tasks)
        .values({
          familyId,
          familyMemberId: child.id,
          type: 'pickup',
          dtstart: new Date('2026-03-10T15:00:00Z'),
          dtend: null,
          status: 'owned',
          ownerMemberId: memberId,
          createdVia: 'manual',
        })
        .returning()
    )[0]!;

    const fake = new FakeProvider('email');
    const registry = new DeliveryProviderRegistry().register(fake);

    const n1 = await deliverTask(db, registry, env.KEK, task.id);
    expect(n1).toBe(1);
    expect(fake.upserts).toHaveLength(1);
    expect(fake.upserts[0]!.target.addressOrUrl).toBe('del-admin@example.com');
    expect(fake.upserts[0]!.event.summary).toBe('Pickup — child');

    const d1 = (
      await db.select().from(deliveries).where(eq(deliveries.taskId, task.id))
    )[0]!;
    expect(d1.status).toBe('sent');
    expect(d1.sequence).toBe(0);

    // Redelivery updates + bumps sequence.
    await deliverTask(db, registry, env.KEK, task.id);
    const d2 = (
      await db.select().from(deliveries).where(eq(deliveries.taskId, task.id))
    )[0]!;
    expect(d2.status).toBe('updated');
    expect(d2.sequence).toBe(1);

    // Cancel.
    const c = await cancelTaskDeliveries(db, registry, env.KEK, task.id);
    expect(c).toBe(1);
    expect(fake.cancels).toHaveLength(1);
    const d3 = (
      await db.select().from(deliveries).where(eq(deliveries.taskId, task.id))
    )[0]!;
    expect(d3.status).toBe('cancelled');
  });
});

describe('calendar targets', () => {
  it('creates a target, hides credentials, and encrypts caldav secrets', async () => {
    const { admin, familyId, memberId } = await adminFamily('target-admin@example.com');
    const db = getDb(env.DB);

    // CalDAV target with a credential → encrypted into a secret.
    const res = await call(
      `/families/${familyId}/calendar-targets`,
      authed(admin.token, {
        memberId,
        name: 'iCloud',
        method: 'caldav',
        providerHint: 'icloud',
        addressOrUrl: 'https://caldav.icloud.com/123/calendars/home/',
        credential: { username: 'me@icloud.com', password: 'abcd-efgh-ijkl-mnop' },
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { target: Record<string, unknown> };
    expect('credentialsRef' in body.target).toBe(false); // never leaked

    // The stored credential decrypts to the original.
    const row = (
      await db
        .select()
        .from(calendarTargets)
        .where(eq(calendarTargets.memberId, memberId))
        .limit(1)
    )[0]!;
    expect(row.credentialsRef).toBeTruthy();
    const secret = JSON.parse((await loadSecret(db, env.KEK, row.credentialsRef!))!);
    expect(secret).toEqual({
      kind: 'basic',
      username: 'me@icloud.com',
      password: 'abcd-efgh-ijkl-mnop',
    });

    const list = await call(`/families/${familyId}/calendar-targets`, bearer(admin.token));
    const { targets } = (await list.json()) as { targets: unknown[] };
    expect(targets.length).toBeGreaterThanOrEqual(1);
  });
});
