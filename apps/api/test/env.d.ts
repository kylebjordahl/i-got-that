import type { D1Migration } from 'cloudflare:test';

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database;
    ENVIRONMENT: string;
    KEK: string;
    ORGANIZER_EMAIL: string;
    TEST_MIGRATIONS: D1Migration[];
  }
}
