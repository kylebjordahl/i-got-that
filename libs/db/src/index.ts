import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import { schema } from './schema.js';

export * from './schema.js';
export { schema } from './schema.js';

// Re-export the common query operators so API/services depend only on @igt/db.
export {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from 'drizzle-orm';

/** Construct a Drizzle client bound to a Cloudflare D1 database. */
export function getDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

export type Db = ReturnType<typeof getDb>;

/**
 * Tenancy guard helper: the last-line `familyId` filter applied to every
 * tenant-scoped query. Pass a table's `familyId` column. Membership/authz
 * itself is enforced in the API layer.
 */
export function tenantFilter(familyIdColumn: AnySQLiteColumn, familyId: string) {
  return eq(familyIdColumn, familyId);
}
