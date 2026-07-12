import { and, eq, familyMembers, ne, type Db } from '@igt/db';

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
