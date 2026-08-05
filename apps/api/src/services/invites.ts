import { and, type Db, desc, eq, families, familyMembers, invites } from '@igt/db';
import { randomToken, sha256hex } from '../lib/crypto.js';

/**
 * Member-claim invites: an admin pre-creates a family member (no login), then
 * shares a link. When an authenticated user accepts it, their existing user is
 * linked to that member (sets family_members.user_id) — no new user is created,
 * so it also works for someone who already has an account in another family.
 *
 * Only a SHA-256 hash of the token is persisted (`invites.tokenHash`) — the
 * raw value is handed back once, at creation, and never stored (same pattern
 * as `auth_tokens`/`sessions` in services/auth.ts).
 */

// Matched to the flow: a share link that's normally used within minutes, not
// a long-lived credential. 48h gives an admin/invitee a couple of days of
// slack without leaving stale bearer credentials sitting in the DB.
export const INVITE_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours

export type Invite = typeof invites.$inferSelect;
/** `createMemberClaimInvite`'s result: the stored row plus the one-time raw token. */
export type CreatedInvite = Omit<Invite, 'tokenHash'> & { token: string };

export async function createMemberClaimInvite(
  db: Db,
  familyId: string,
  memberId: string,
  issuedByMemberId: string,
): Promise<CreatedInvite> {
  const token = randomToken();
  const tokenHash = await sha256hex(token);
  const [row] = await db
    .insert(invites)
    .values({
      type: 'claim_member',
      familyId,
      memberId,
      issuedByMemberId,
      tokenHash,
      status: 'pending',
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    })
    .returning();
  const { tokenHash: _tokenHash, ...rest } = row!;
  return { ...rest, token };
}

/** Public preview of an invite (family + member names), by token. */
export async function previewInvite(db: Db, token: string) {
  const tokenHash = await sha256hex(token);
  const rows = await db
    .select({ invite: invites, family: families, member: familyMembers })
    .from(invites)
    .innerJoin(families, eq(families.id, invites.familyId))
    .leftJoin(familyMembers, eq(familyMembers.id, invites.memberId))
    .where(eq(invites.tokenHash, tokenHash))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const expired = (row.invite.expiresAt?.getTime() ?? 0) < Date.now();
  return {
    type: row.invite.type,
    status: expired && row.invite.status === 'pending' ? 'expired' : row.invite.status,
    familyName: row.family.name,
    relationName: row.member?.relationName ?? null,
  };
}

/** Outstanding + historical invites for a family (admin view) — never exposes the token hash. */
export async function listFamilyInvites(db: Db, familyId: string) {
  const rows = await db
    .select()
    .from(invites)
    .where(eq(invites.familyId, familyId))
    .orderBy(desc(invites.createdAt));
  return rows.map(({ tokenHash: _tokenHash, ...row }) => {
    const expired = (row.expiresAt?.getTime() ?? 0) < Date.now();
    return {
      ...row,
      status: expired && row.status === 'pending' ? 'expired' : row.status,
    };
  });
}

/** Soft-revoke an invite (admin) so its token can no longer be accepted. Returns false if not found. */
export async function revokeInvite(
  db: Db,
  familyId: string,
  inviteId: string,
): Promise<boolean> {
  const result = await db
    .update(invites)
    .set({ status: 'revoked' })
    .where(and(eq(invites.id, inviteId), eq(invites.familyId, familyId)))
    .returning({ id: invites.id });
  return result.length > 0;
}

export type AcceptResult =
  | { ok: true; familyId: string; memberId: string }
  | { ok: false; error: string; httpStatus: 400 | 404 | 409 | 410 };

/** Link the accepting user to the invite's member. Idempotent for that user. */
export async function acceptMemberClaimInvite(
  db: Db,
  token: string,
  userId: string,
): Promise<AcceptResult> {
  const tokenHash = await sha256hex(token);
  const invite = (
    await db.select().from(invites).where(eq(invites.tokenHash, tokenHash)).limit(1)
  )[0];
  if (!invite || invite.type !== 'claim_member' || !invite.memberId) {
    return { ok: false, error: 'invite_not_found', httpStatus: 404 };
  }

  const member = (
    await db
      .select()
      .from(familyMembers)
      .where(
        and(
          eq(familyMembers.id, invite.memberId),
          eq(familyMembers.familyId, invite.familyId!),
        ),
      )
      .limit(1)
  )[0];
  if (!member) return { ok: false, error: 'member_not_found', httpStatus: 404 };

  // Already linked to this same user → idempotent success (even once consumed).
  if (member.userId === userId) {
    await db.update(invites).set({ status: 'accepted' }).where(eq(invites.id, invite.id));
    return { ok: true, familyId: invite.familyId!, memberId: member.id };
  }
  if (member.userId && member.userId !== userId) {
    return { ok: false, error: 'member_already_claimed', httpStatus: 409 };
  }
  if (invite.status !== 'pending') {
    return { ok: false, error: 'invite_not_pending', httpStatus: 410 };
  }
  if ((invite.expiresAt?.getTime() ?? 0) < Date.now()) {
    await db.update(invites).set({ status: 'expired' }).where(eq(invites.id, invite.id));
    return { ok: false, error: 'invite_expired', httpStatus: 410 };
  }

  // The user must not already occupy a different member slot in this family.
  const existing = (
    await db
      .select()
      .from(familyMembers)
      .where(
        and(
          eq(familyMembers.familyId, invite.familyId!),
          eq(familyMembers.userId, userId),
        ),
      )
      .limit(1)
  )[0];
  if (existing) return { ok: false, error: 'already_in_family', httpStatus: 409 };

  await db.update(familyMembers).set({ userId }).where(eq(familyMembers.id, member.id));
  await db.update(invites).set({ status: 'accepted' }).where(eq(invites.id, invite.id));
  return { ok: true, familyId: invite.familyId!, memberId: member.id };
}
