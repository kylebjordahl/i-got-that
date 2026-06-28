import type { familyMembers } from '@igt/db';
import type { SessionUser } from './services/auth.js';

/** Worker bindings (kept in sync with wrangler.jsonc + Terraform). */
export interface Bindings {
  DB: D1Database;
  ENVIRONMENT: string;
}

/** Per-request context set by middleware. */
export interface Variables {
  user: SessionUser;
  member: typeof familyMembers.$inferSelect;
}

export type HonoEnv = { Bindings: Bindings; Variables: Variables };
