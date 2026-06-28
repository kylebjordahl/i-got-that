import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll } from 'vitest';

// Apply the Drizzle migrations to the test D1 once; isolated storage gives each
// test a fresh copy of this migrated baseline.
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
