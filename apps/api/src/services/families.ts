import { and, eq, families, familyMembers, isNotNull, ne, type Db } from '@igt/db';

/**
 * True if `memberId` is currently the family's only admin among its *other*
 * members — i.e. removing/unlinking them would leave a family that still has
 * other members with no one able to manage it. False when the family has no
 * other members at all (nothing left to orphan). Callers only need this when
 * `memberId` is itself an admin.
 */
export async function wouldOrphanFamily(
  db: Db,
  familyId: string,
  memberId: string,
): Promise<boolean> {
  const others = await db
    .select({ id: familyMembers.id, isAdmin: familyMembers.isAdmin })
    .from(familyMembers)
    .where(and(eq(familyMembers.familyId, familyId), ne(familyMembers.id, memberId)));
  if (others.length === 0) return false;
  return !others.some((o) => o.isAdmin);
}

export type AccountFamilyPlan = {
  /** Families that go away with the account: no one else can log in to them. */
  deleted: { id: string; name: string }[];
  /** Families that survive; the user's member row stays, just unlinked. */
  kept: { id: string; name: string; relationName: string }[];
};

/**
 * What deleting `userId`'s account does to each family they belong to. A
 * family survives only if some *other* member still has a login; otherwise
 * deleting the account would strand it — data nobody can reach, manage, or
 * delete. Both the real deletion and the `/auth/me/deletable` preview call
 * this, so what the UI promises is what happens.
 */
export async function planAccountFamilies(db: Db, userId: string): Promise<AccountFamilyPlan> {
  const memberships = await db
    .select({
      memberId: familyMembers.id,
      familyId: familyMembers.familyId,
      relationName: familyMembers.relationName,
      familyName: families.name,
    })
    .from(familyMembers)
    .innerJoin(families, eq(families.id, familyMembers.familyId))
    .where(eq(familyMembers.userId, userId));

  const plan: AccountFamilyPlan = { deleted: [], kept: [] };
  for (const m of memberships) {
    const others = await db
      .select({ id: familyMembers.id })
      .from(familyMembers)
      .where(
        and(
          eq(familyMembers.familyId, m.familyId),
          ne(familyMembers.id, m.memberId),
          isNotNull(familyMembers.userId),
        ),
      )
      .limit(1);
    if (others.length === 0) plan.deleted.push({ id: m.familyId, name: m.familyName });
    else plan.kept.push({ id: m.familyId, name: m.familyName, relationName: m.relationName });
  }
  return plan;
}
