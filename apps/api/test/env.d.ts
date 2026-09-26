import type { D1Migration } from 'cloudflare:test';

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database;
    ENVIRONMENT: string;
    KEK?: string;
    KEK_V1: string;
    KEK_CURRENT_VERSION?: string;
    ORGANIZER_EMAIL: string;
    // Unbound in tests; declared so a test can supply a deployed env's shape.
    PUBLIC_ORIGIN?: string;
    EMAIL?: SendEmail;
    ALLOW_DEV_TOKENS?: string;
    OPS_DASHBOARD_PASSWORD?: string;
    TEST_MIGRATIONS: D1Migration[];
  }
}
