import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defineWorkersConfig,
  readD1Migrations,
} from '@cloudflare/vitest-pool-workers/config';

/**
 * Integration tests run inside workerd with real bindings (D1) provisioned from
 * wrangler.jsonc. We read the Drizzle-generated migrations and apply them to the
 * test D1 in a setup file so each isolated test starts from the real schema.
 */
const here = path.dirname(fileURLToPath(import.meta.url));

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(
    path.join(here, '../../libs/db/migrations'),
  );

  return {
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
      poolOptions: {
        workers: {
          singleWorker: true,
          wrangler: { configPath: './wrangler.jsonc' },
          miniflare: {
            compatibilityFlags: ['nodejs_compat'],
            bindings: { TEST_MIGRATIONS: migrations },
          },
        },
      },
    },
  };
});
