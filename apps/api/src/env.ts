import type { familyMembers } from "@igt/db";
import type { SessionUser } from "./services/auth.js";
import type { DeliveryJob } from "./services/delivery.js";

/** Worker bindings (kept in sync with wrangler.jsonc + Terraform). */
export interface Bindings {
    DB: D1Database;
    ENVIRONMENT: string;
    /**
     * Public-facing origin this deployment is served on (scheme + host, no path),
     * e.g. `https://staging.igt.kylebjordahl.com`. The single-origin layout serves
     * the API under `/api` and the web client under `/app` here. Used to build
     * absolute URLs the outside world sees — notably the Apple web Return URL.
     * Unset (local dev / tests) ⇒ features that need an absolute public URL are off.
     */
    PUBLIC_ORIGIN?: string;
    /** base64 of 32 random bytes; the key-encryption key for envelope encryption. */
    KEK?: string;
    /** ORGANIZER email used on outbound iMIP invites (must be on the sending domain). */
    ORGANIZER_EMAIL?: string;
    /** Cloudflare Email Service `send_email` binding (outbound iMIP). */
    EMAIL?: SendEmail;
    /**
     * Cloudflare Queue for durable, retry-backed calendar delivery. Bound in
     * deployed envs; unset locally/in tests (reconciles run inline instead).
     */
    DELIVERY_QUEUE?: Queue<DeliveryJob>;
    /**
     * Static-assets binding serving the Flutter web client under /app. Present
     * only in deployed envs that host the web client on the same origin.
     */
    ASSETS?: Fetcher;
    /**
     * Comma-separated allowed Apple `aud` values for Sign in with Apple — your
     * iOS bundle id and/or web Services ID. Unset ⇒ Apple login disabled.
     */
    APPLE_CLIENT_IDS?: string;
    /**
     * The web **Services ID** used as `client_id` when redirecting to Apple's
     * authorize endpoint (the browser "Sign in with Apple" flow). Must also be
     * listed in APPLE_CLIENT_IDS. Unset (or PUBLIC_ORIGIN unset) ⇒ the web
     * redirect flow is disabled. The Return URL Apple form-POSTs back to is
     * derived from PUBLIC_ORIGIN: `<PUBLIC_ORIGIN>/api/auth/apple/callback`.
     */
    APPLE_WEB_CLIENT_ID?: string;
    /** Google OAuth client for the Calendar provider. Unset ⇒ Google OAuth off. */
    GOOGLE_OAUTH_CLIENT_ID?: string;
    GOOGLE_OAUTH_CLIENT_SECRET?: string;
}

/** Per-request context set by middleware. */
export interface Variables {
    user: SessionUser;
    member: typeof familyMembers.$inferSelect;
}

export type HonoEnv = { Bindings: Bindings; Variables: Variables };
