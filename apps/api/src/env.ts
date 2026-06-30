import type { familyMembers } from "@igt/db";
import type { SessionUser } from "./services/auth.js";

/** Worker bindings (kept in sync with wrangler.jsonc + Terraform). */
export interface Bindings {
    DB: D1Database;
    ENVIRONMENT: string;
    /** base64 of 32 random bytes; the key-encryption key for envelope encryption. */
    KEK?: string;
    /** ORGANIZER email used on outbound iMIP invites (must be on the sending domain). */
    ORGANIZER_EMAIL?: string;
    /** Cloudflare Email Service `send_email` binding (outbound iMIP). */
    EMAIL?: SendEmail;
    /**
     * Comma-separated allowed Apple `aud` values for Sign in with Apple — your
     * iOS bundle id and/or web Services ID. Unset ⇒ Apple login disabled.
     */
    APPLE_CLIENT_IDS?: string;
}

/** Per-request context set by middleware. */
export interface Variables {
    user: SessionUser;
    member: typeof familyMembers.$inferSelect;
}

export type HonoEnv = { Bindings: Bindings; Variables: Variables };
