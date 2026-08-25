import type { familyMembers } from "@igt/db";
import type { SessionUser } from "./services/auth.js";
import type { DeliveryJob } from "./services/mirror.js";

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
    /**
     * The original, unversioned key-encryption key — base64 of 32 random bytes.
     * Superseded by `KEK_V<n>` below, and read now only as the **version-1
     * fallback**: secrets written before that split are stamped
     * `key_version = 1` and wrapped with this value, so an env that has `KEK`
     * but no `KEK_V1` keeps working (see `lib/secrets.ts#buildKekKeySet`).
     *
     * Deliberately not removed. Worker secrets are write-only — nobody can read
     * `KEK`'s value back out of Cloudflare to re-set it as `KEK_V1` — so for a
     * deployment that predates the split, this binding is the *only* thing that
     * can still decrypt its stored credentials. Dropping it, or deleting the
     * secret, orphans every credential in that env permanently.
     */
    KEK?: string;
    /**
     * Versioned key-encryption keys for envelope-encrypted secrets
     * (`lib/secrets.ts`) — each `KEK_V<n>` is base64 of 32 random bytes, set
     * via `wrangler secret put KEK_V<n> [--env <env>]`. Every deployed env needs
     * the current version's key (or, for version 1, the legacy `KEK` above):
     * without it nothing can decrypt a stored credential, so connecting an
     * account fails (503) and every feed and mirror skips. `GET /health` reports
     * which of the two is in play as `config.secretsKek` (`ok` vs `legacy`).
     *
     * Add a `KEK_V<n>` field here (and set the matching secret) for each new
     * version as you rotate — `lib/secrets.ts#buildKekKeySet` looks versions up
     * by name, so no other code changes with each rotation. See
     * `docs/DEPLOYMENT.md` § KEK rotation.
     */
    KEK_V1?: string;
    /**
     * Which `KEK_V<n>` new secrets are encrypted with (`encryptSecret` stamps
     * `secrets.keyVersion` from this). Unset ⇒ version 1, matching today's
     * single-key deployments. Existing rows keep decrypting with whichever
     * version they were stamped with, as long as that `KEK_V<n>` stays
     * configured — bump this only after the new `KEK_V<n>` secret is set, then
     * run `tools/rotate-kek.ts` to re-encrypt rows still on the old version.
     */
    KEK_CURRENT_VERSION?: string;
    /**
     * base64 of 32 random bytes; the HMAC signing secret for the short-lived
     * Apple/Google OAuth `state` cookies (`routes/auth.ts`). Deliberately
     * distinct from the `KEK_V<n>` keys — signing the state cookie and wrapping
     * stored credentials are unrelated cryptographic purposes with different
     * rotation profiles, and the state cookie carries the link-mode session
     * reference used to graft an OAuth identity onto an account, so a shared
     * or predictable key would be a real account-takeover path. Unset ⇒ the
     * Apple/Google web start/callback routes fail closed with 501 rather than
     * falling back to any constant. Set via `wrangler secret put
     * COOKIE_SIGNING_KEY` per env; see docs/DEPLOYMENT.md.
     */
    COOKIE_SIGNING_KEY?: string;
    /**
     * Escape hatch for the outbound-URL (SSRF) policy in
     * `lib/outbound-url.ts`: comma-separated `host` or `host:port` entries that
     * user-supplied feed / CalDAV URLs may target even though the default
     * policy would reject them (a self-hosted CalDAV server on an odd port, a
     * local ICS fixture during development). Unset ⇒ public hosts on 80/443 only.
     */
    OUTBOUND_ALLOWED_HOSTS?: string;
    /** ORGANIZER email used on outbound iMIP invites (must be on the sending domain). */
    ORGANIZER_EMAIL?: string;
    /**
     * Return the raw magic-link token in the `POST /auth/magic-link/request`
     * response (`devToken`) so dev + tests can complete the login flow without a
     * mailbox. **Local development and tests ONLY** — anyone who can reach the
     * endpoint could then log in as any email address. Set to the string `'true'`
     * in the top-level `vars` of `wrangler.jsonc`; named envs don't inherit
     * top-level vars, so `staging`/`production` fail closed by construction.
     */
    ALLOW_DEV_TOKENS?: string;
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
    /**
     * Comma-separated allowed Google `aud` values for native Sign in with
     * Google — the iOS OAuth client id(s) (one per flavor), distinct from
     * GOOGLE_OAUTH_CLIENT_ID (the Web client used for the redirect flow and
     * for redeeming a native `serverAuthCode`). Unset ⇒ native Google login
     * disabled (web flow is unaffected).
     */
    GOOGLE_IOS_CLIENT_IDS?: string;
    /**
     * Custom URL scheme the native "connect a Google Calendar" wizard
     * (`accounts.ts`'s `/google/authorize-url` + the plain OAuth code-exchange
     * flow, distinct from Sign in with Google) registers in `Info.plist`.
     * Google's Web-application client type can't redirect straight to a
     * custom scheme, so `GET /auth/google/native-callback` is registered in
     * the Cloud Console as an ordinary HTTPS redirect URI instead, and just
     * 302s the `code`/`state` on to `<scheme>://google-oauth-callback`, which
     * `flutter_web_auth_2`/`ASWebAuthenticationSession` intercepts on-device.
     * Unset ⇒ that route 501s (the wizard still works via manual copy/paste).
     */
    GOOGLE_IOS_OAUTH_CALLBACK_SCHEME?: string;
    /**
     * Comma-separated Apple App ID prefixes (`<TeamID>.<bundleId>`) for iOS
     * Universal Links, served in the apple-app-site-association file at
     * `/.well-known/apple-app-site-association`. List every bundle id that
     * should open invite links (e.g. staging + production). Unset/empty ⇒ the
     * AASA endpoint 404s and Universal Links are disabled (web fallback still
     * works).
     */
    APPLE_APP_ID_PREFIX?: string;
}

/** Per-request context set by middleware. */
export interface Variables {
    user: SessionUser;
    member: typeof familyMembers.$inferSelect;
}

export type HonoEnv = { Bindings: Bindings; Variables: Variables };
