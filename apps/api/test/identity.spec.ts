import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import app from '../src/index.js';

async function call(path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`https://api.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function authed(token: string, body?: unknown): RequestInit {
  return {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}

/** Run the magic-link flow and return a session token + user id. */
async function login(email: string): Promise<{ token: string; userId: string }> {
  const reqRes = await call('/auth/magic-link/request', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  expect(reqRes.status).toBe(200);
  const { devToken } = (await reqRes.json()) as { devToken: string };
  expect(devToken).toBeTruthy();

  const verifyRes = await call('/auth/magic-link/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: devToken }),
  });
  expect(verifyRes.status).toBe(200);
  const { sessionToken, user } = (await verifyRes.json()) as {
    sessionToken: string;
    user: { id: string };
  };
  return { token: sessionToken, userId: user.id };
}

describe('identity & tenancy', () => {
  it('rejects unauthenticated /me', async () => {
    const res = await call('/me');
    expect(res.status).toBe(401);
  });

  it('rejects an invalid magic-link token', async () => {
    const res = await call('/auth/magic-link/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'not-a-real-token' }),
    });
    expect(res.status).toBe(401);
  });

  it('logs in, creates a family, and seeds the creator as admin', async () => {
    const alice = await login('alice@example.com');

    const me = await call('/me', { headers: { Authorization: `Bearer ${alice.token}` } });
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { user: { id: string }; families: unknown[] };
    expect(meBody.user.id).toBe(alice.userId);
    expect(meBody.families).toHaveLength(0);

    const created = await call('/families', authed(alice.token, { name: 'Smith', relationName: 'mom' }));
    expect(created.status).toBe(201);
    const { family, member } = (await created.json()) as {
      family: { id: string };
      member: { isAdmin: boolean; isCaretaker: boolean };
    };
    expect(member.isAdmin).toBe(true);
    expect(member.isCaretaker).toBe(true);

    // A dependent (child) — admin adds it.
    const child = await call(
      `/families/${family.id}/members`,
      authed(alice.token, { relationName: 'child', requiresCaretaker: true }),
    );
    expect(child.status).toBe(201);

    const list = await call(`/families/${family.id}/members`, {
      headers: { Authorization: `Bearer ${alice.token}` },
    });
    const { members } = (await list.json()) as { members: unknown[] };
    expect(members).toHaveLength(2);
  });

  it('defaults generatesFamilyTasks from role: off for caretakers, on for dependents', async () => {
    const alice = await login('roles-alice@example.com');

    const created = await call('/families', authed(alice.token, { name: 'Roles', relationName: 'mom' }));
    const { family, member: creator } = (await created.json()) as {
      family: { id: string };
      member: { generatesFamilyTasks: boolean };
    };
    // The creator is seeded as a caretaker — defaults to not generating tasks.
    expect(creator.generatesFamilyTasks).toBe(false);

    const dependent = await call(
      `/families/${family.id}/members`,
      authed(alice.token, { relationName: 'child', requiresCaretaker: true }),
    );
    const { member: dependentMember } = (await dependent.json()) as {
      member: { generatesFamilyTasks: boolean };
    };
    expect(dependentMember.generatesFamilyTasks).toBe(true);

    const caretaker = await call(
      `/families/${family.id}/members`,
      authed(alice.token, { relationName: 'dad', isCaretaker: true }),
    );
    const { member: caretakerMember } = (await caretaker.json()) as {
      member: { generatesFamilyTasks: boolean };
    };
    expect(caretakerMember.generatesFamilyTasks).toBe(false);

    // An explicit value always wins over the role-based default.
    const explicit = await call(
      `/families/${family.id}/members`,
      authed(alice.token, {
        relationName: 'grandma',
        isCaretaker: true,
        generatesFamilyTasks: true,
      }),
    );
    const { member: explicitMember } = (await explicit.json()) as {
      member: { generatesFamilyTasks: boolean };
    };
    expect(explicitMember.generatesFamilyTasks).toBe(true);
  });

  it('enforces tenant isolation and admin-only member creation', async () => {
    const alice = await login('alice2@example.com');
    const bob = await login('bob@example.com');

    const created = await call('/families', authed(alice.token, { name: 'Jones' }));
    const { family } = (await created.json()) as { family: { id: string } };

    // Bob is not a member → cannot read the family's members.
    const bobList = await call(`/families/${family.id}/members`, {
      headers: { Authorization: `Bearer ${bob.token}` },
    });
    expect(bobList.status).toBe(403);

    // Alice (admin) adds Bob as a non-admin caretaker.
    const addBob = await call(
      `/families/${family.id}/members`,
      authed(alice.token, {
        relationName: 'uncle',
        isCaretaker: true,
        isAdmin: false,
        userId: bob.userId,
      }),
    );
    expect(addBob.status).toBe(201);

    // Now Bob can read members...
    const bobListAfter = await call(`/families/${family.id}/members`, {
      headers: { Authorization: `Bearer ${bob.token}` },
    });
    expect(bobListAfter.status).toBe(200);

    // ...but cannot add members (not an admin).
    const bobAdd = await call(
      `/families/${family.id}/members`,
      authed(bob.token, { relationName: 'friend', isCaretaker: true }),
    );
    expect(bobAdd.status).toBe(403);
  });
});

describe('member editing & permissions', () => {
  function patch(token: string, body: unknown): RequestInit {
    return {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    };
  }

  it('lets self rename, admins change roles, and blocks the rest', async () => {
    const alice = await login('memedit-alice@example.com');
    const bob = await login('memedit-bob@example.com');

    const fam = await call('/families', authed(alice.token, { name: 'Edit Fam' }));
    const familyId = ((await fam.json()) as { family: { id: string } }).family.id;

    // Alice (admin) adds Bob as a non-admin caretaker.
    const addBob = await call(
      `/families/${familyId}/members`,
      authed(alice.token, {
        relationName: 'uncle',
        isCaretaker: true,
        isAdmin: false,
        userId: bob.userId,
      }),
    );
    const bobMemberId = ((await addBob.json()) as { member: { id: string } }).member.id;

    // Bob renames himself — allowed.
    const rename = await call(
      `/families/${familyId}/members/${bobMemberId}`,
      patch(bob.token, { relationName: 'Uncle Bob' }),
    );
    expect(rename.status).toBe(200);
    expect(((await rename.json()) as { member: { relationName: string } }).member.relationName).toBe('Uncle Bob');

    // Bob cannot grant himself admin.
    const escalate = await call(
      `/families/${familyId}/members/${bobMemberId}`,
      patch(bob.token, { isAdmin: true }),
    );
    expect(escalate.status).toBe(403);

    // Find Alice's member id via /me.
    const aliceMe = await call('/me', { headers: { Authorization: `Bearer ${alice.token}` } });
    const aliceMemberId = ((await aliceMe.json()) as {
      families: { member: { id: string } }[];
    }).families[0]!.member.id;

    // Bob cannot edit Alice.
    const editOther = await call(
      `/families/${familyId}/members/${aliceMemberId}`,
      patch(bob.token, { relationName: 'hacked' }),
    );
    expect(editOther.status).toBe(403);

    // Alice (admin) can flip Bob's flags.
    const adminEdit = await call(
      `/families/${familyId}/members/${bobMemberId}`,
      patch(alice.token, { isCaretaker: false }),
    );
    expect(adminEdit.status).toBe(200);
    expect(((await adminEdit.json()) as { member: { isCaretaker: boolean } }).member.isCaretaker).toBe(false);
  });

  it('lets a member set their own accent color and validates the hex', async () => {
    const alice = await login('color-alice@example.com');
    const bob = await login('color-bob@example.com');

    const fam = await call('/families', authed(alice.token, { name: 'Color Fam' }));
    const familyId = ((await fam.json()) as { family: { id: string } }).family.id;

    const addBob = await call(
      `/families/${familyId}/members`,
      authed(alice.token, { relationName: 'uncle', isCaretaker: true, userId: bob.userId }),
    );
    const bobMemberId = ((await addBob.json()) as { member: { id: string } }).member.id;

    // Bob sets his own color (not a role flag) — allowed.
    const setColor = await call(
      `/families/${familyId}/members/${bobMemberId}`,
      patch(bob.token, { color: '#C08CFF' }),
    );
    expect(setColor.status).toBe(200);
    expect(((await setColor.json()) as { member: { color: string } }).member.color).toBe('#C08CFF');

    // A malformed hex is rejected.
    const bad = await call(
      `/families/${familyId}/members/${bobMemberId}`,
      patch(bob.token, { color: 'purple' }),
    );
    expect(bad.status).toBe(400);
  });

  it('removes a member (admin), but not self or the last admin', async () => {
    const alice = await login('rm-alice@example.com');
    const bob = await login('rm-bob@example.com');

    const fam = await call('/families', authed(alice.token, { name: 'Remove Fam' }));
    const familyId = ((await fam.json()) as { family: { id: string } }).family.id;
    const aliceMe = await call('/me', { headers: { Authorization: `Bearer ${alice.token}` } });
    const aliceMemberId = ((await aliceMe.json()) as {
      families: { member: { id: string } }[];
    }).families[0]!.member.id;

    const addBob = await call(
      `/families/${familyId}/members`,
      authed(alice.token, { relationName: 'uncle', isCaretaker: true, userId: bob.userId }),
    );
    const bobMemberId = ((await addBob.json()) as { member: { id: string } }).member.id;

    const del = (token: string): RequestInit => ({
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });

    // Bob (non-admin) can't remove anyone.
    expect((await call(`/families/${familyId}/members/${bobMemberId}`, del(bob.token))).status).toBe(403);
    // Alice can't remove herself...
    expect((await call(`/families/${familyId}/members/${aliceMemberId}`, del(alice.token))).status).toBe(409);
    // ...but can remove Bob.
    expect((await call(`/families/${familyId}/members/${bobMemberId}`, del(alice.token))).status).toBe(204);

    const list = await call(`/families/${familyId}/members`, {
      headers: { Authorization: `Bearer ${alice.token}` },
    });
    expect(((await list.json()) as { members: unknown[] }).members).toHaveLength(1);
  });
});

describe('member-claim invites', () => {
  it('links an accepting user to a pre-created member (idempotent, single-claim)', async () => {
    const alice = await login('inv-alice@example.com');
    const famRes = await call('/families', authed(alice.token, { name: 'Invite Fam' }));
    const familyId = ((await famRes.json()) as { family: { id: string } }).family.id;

    // Admin pre-creates a caretaker with no login.
    const memberRes = await call(
      `/families/${familyId}/members`,
      authed(alice.token, { relationName: 'Grandma', isCaretaker: true }),
    );
    const grandmaId = ((await memberRes.json()) as { member: { id: string } }).member.id;

    // Issue the share token.
    const issued = await call(
      `/families/${familyId}/members/${grandmaId}/invite`,
      authed(alice.token),
    );
    expect(issued.status).toBe(201);
    const { token } = (await issued.json()) as { token: string };
    expect(token).toBeTruthy();

    // Public preview shows what you're joining.
    const preview = await call(`/invites/${token}`);
    expect(preview.status).toBe(200);
    expect((await preview.json()) as unknown).toMatchObject({
      invite: { familyName: 'Invite Fam', relationName: 'Grandma', status: 'pending' },
    });

    // Bob (a different, already-registered user) accepts → linked to Grandma.
    const bob = await login('inv-bob@example.com');
    const accept = await call(`/invites/${token}/accept`, authed(bob.token));
    expect(accept.status).toBe(200);
    expect((await accept.json()) as unknown).toMatchObject({ ok: true, familyId, memberId: grandmaId });

    // Bob's /me now includes the family as Grandma.
    const bobMe = await call('/me', { headers: { Authorization: `Bearer ${bob.token}` } });
    const fams = ((await bobMe.json()) as {
      families: { family: { id: string }; member: { id: string } }[];
    }).families;
    expect(fams.find((f) => f.family.id === familyId)?.member.id).toBe(grandmaId);

    // Re-accepting by Bob is idempotent.
    const reaccept = await call(`/invites/${token}/accept`, authed(bob.token));
    expect(reaccept.status).toBe(200);

    // A third user cannot claim an already-claimed member.
    const carol = await login('inv-carol@example.com');
    const taken = await call(`/invites/${token}/accept`, authed(carol.token));
    expect(taken.status).toBe(409);
  });

  it('only admins can issue invites; preview 404s for bad tokens', async () => {
    const alice = await login('inv-admin2@example.com');
    const famRes = await call('/families', authed(alice.token, { name: 'Fam2' }));
    const familyId = ((await famRes.json()) as { family: { id: string } }).family.id;
    const memberRes = await call(
      `/families/${familyId}/members`,
      authed(alice.token, { relationName: 'Helper', isCaretaker: true }),
    );
    const helperId = ((await memberRes.json()) as { member: { id: string } }).member.id;

    // Bob claims Helper (a non-admin member), then cannot issue invites himself.
    const issued = await call(`/families/${familyId}/members/${helperId}/invite`, authed(alice.token));
    const { token } = (await issued.json()) as { token: string };
    const bob = await login('inv-bob2@example.com');
    await call(`/invites/${token}/accept`, authed(bob.token));
    const bobIssue = await call(
      `/families/${familyId}/members/${helperId}/invite`,
      authed(bob.token),
    );
    expect(bobIssue.status).toBe(403);

    expect((await call('/invites/does-not-exist')).status).toBe(404);
  });
});
