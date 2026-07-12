# Authentication

Two login methods feed the same session model (a `sessions` row → bearer token).

## Linking login methods (one user, many identities)

A user is a login account with one or more **identities** (`identities` rows,
`(provider, provider_ref)` unique). Sign-in resolves the identity → its `userId`,
so once several methods point at the same user, logging in with any of them lands
on the same account. This is how "Apple on one device, magic link on another"
threads together.

New logins create a fresh user; to make a *second* method resolve to an
*existing* account, the signed-in user links it. All linking routes require a
session (`authMiddleware`) and attach a **verified** credential to the current
user:

| Route | What it does |
| --- | --- |
| `GET /auth/identities` | List the caller's linked methods (`{ id, provider, providerRef }`). |
| `POST /auth/link/magic-link` `{ token }` | Request a magic link for the new email as usual, then post that token here (instead of `/magic-link/verify`) to attach the `magic_link` identity to the current user. |
| `POST /auth/link/apple` `{ identityToken }` | Verify a native Apple token (same as `/apple`) and attach the `apple` identity. |
| `DELETE /auth/identities/:id` | Unlink a method. Blocked (`409 last_identity`) when it's the only one — removing it would orphan the account. |

Linking is **idempotent** for the caller (`already_linked`) and refuses to steal
an identity already threaded to a different user (`409
identity_linked_to_other_user`). On **web**, Apple can't produce a token in-page,
so `GET /auth/apple/start?link=1` reuses the redirect flow: the same-origin
`igt_session` cookie rides along, the callback threads Apple onto the current
user (no new session) and returns to `/app/#linked=apple`.

The Flutter client surfaces all of this on the **Me** tab under "Login methods"
(list + add email + link Apple on web + unlink), following the account-card UI
pattern.

## Deleting an account

`DELETE /auth/me` deletes the signed-in user (`services/auth.ts`'s
`deleteUserAccount`). FK cascades drop their `sessions`, `identities`, and
`external_accounts`; each `family_members` row they held is kept but unlinked
(`userId` → `null`) rather than removed — the person stays in the family, just
loses login capability, same outcome as `handleAppleAccountEvent`'s
server-to-server `account-delete` case.

Blocked with `409 last_admin` if the user is the sole admin of a family that
still has other members — deleting the account would leave that family with no
one able to manage it. The caller must promote a co-admin, leave the family
(`POST /families/:familyId/leave` — self-service, same `userId` → `null`
unlink as account deletion, blocked with the same `409 last_admin` guard), or
delete the family outright (`DELETE /families/:familyId`, admin-only —
cascades the whole family away), before deleting their own account.

`GET /auth/me/deletable` reports whether the signed-in user is currently free
to delete their account (`{ deletable: boolean }`), backed by the same guard
(`services/auth.ts`'s `accountDeletionBlocked`). The client checks this before
opening the delete-account speedbump so a block reads as the sheet's own
message ("Before you can delete your account, you must either leave or delete
all the families you are involved in.") instead of a toast raised after a
failed slide.

The Flutter client surfaces this on the **Me** tab as "Delete account", gated
behind a slide-to-confirm speedbump (`widgets/slide_to_confirm.dart`); "Leave
family" and "Delete family" on the **Family** tab use the same control, the
latter admin-only.

## Session persistence on web (surviving a page refresh)

The Flutter web SPA keeps its session token in memory only (`AuthState` in
`lib/state/auth.dart`) — it's never written to `localStorage`/`sessionStorage`,
which JS-side XSS could read. Instead, every route that issues a session
(`POST /auth/apple`, `POST /auth/apple/callback`, `POST /auth/magic-link/verify`)
also mirrors the token into an **`igt_session`** cookie — `HttpOnly` (invisible
to JS), `Secure`, `SameSite=Lax`, set in `apps/api/src/lib/session-cookie.ts`.
`authMiddleware` (`apps/api/src/middleware/auth.ts`) accepts either the
`Authorization: Bearer` header (native) or this cookie (web) — whichever is
present.

On startup, before falling back to the login screen, the web client calls
`GET /me` with the cookie attached (`credentials: 'include'`, wired via
`apps/mobile/lib/api/dio_credentials_html.dart`); a valid cookie restores the
session with no token ever touching JS. `POST /auth/logout` invalidates the
session server-side and clears the cookie.

`SameSite=Lax` is enough because deployed envs serve the SPA and API
same-origin (see below), and local dev (`flutter run` on one port, `wrangler
dev` on `:8787`) is still "same-site" (same `localhost` host, different port).
Cross-origin dev CORS (`apps/api/src/index.ts`) reflects the request `Origin`
and sets `credentials: true`, which a wildcard `origin: '*'` can't do.

## Session persistence on native (surviving an app relaunch)

Native has no cookie jar, so it persists the bearer token itself: on a
successful login, `AuthController` (`lib/state/auth.dart`) writes the
`sessionToken` to the platform Keychain/Keystore via
[`flutter_secure_storage`](https://pub.dev/packages/flutter_secure_storage)
(`pubspec.yaml`); `logout()` deletes it. On startup, before falling back to
the login screen, native reads that stored token and validates it against
`GET /me`, discarding it on any failure (missing, expired, revoked, Keychain
unreadable) rather than getting stuck. This mirrors the web cookie flow one
layer down the stack — same "never trust a token you can't currently verify"
shape, different storage primitive per platform.

| Method | State | Notes |
| --- | --- | --- |
| **Magic link** (email) | Fully implemented | Needs outbound email, which is **off** (no paid plan). In **dev/staging** the request endpoint returns the token directly (`devToken`) so you can log in without a mailbox; in **production** it does not. |
| **Sign in with Apple** | Server + web redirect flow **implemented + tested**; native (iOS) client wiring + Apple config required | The primary login for deployed environments (works without email). |

## Sign in with Apple

There are two client shapes, both landing on the same verifier + session model:

- **Native (iOS)** posts an identity token directly — `POST /auth/apple`.
- **Web** can't obtain a token in-page, so it uses Apple's browser **redirect**
  flow through a server-hosted **Return URL**: `/auth/apple/start` → Apple →
  `/auth/apple/callback` → back to the SPA. See "Web redirect flow" below.

### How token verification works
Whichever path supplies it, the Apple **identity token** (an RS256 JWT) is
verified by `apps/api/src/lib/apple.ts`:
1. fetches Apple's JWKS (`https://appleid.apple.com/auth/keys`), selects the key
   by the token's `kid`, and RS256-verifies the signature (WebCrypto);
2. checks `iss == https://appleid.apple.com`, `aud ∈ APPLE_CLIENT_IDS`, `exp`,
   and — when supplied (web flow) — the `nonce`;
3. maps the token's `sub` to an `identity(provider='apple')` → user → session.

If `APPLE_CLIENT_IDS` is unset `POST /auth/apple` returns **501** (Apple disabled).

### Web redirect flow (the Return URL)
The web client has no native Apple SDK, so it drives the OAuth redirect flow.
The **Return URL** — the value you asked about — is this API's own callback:

```
<PUBLIC_ORIGIN>/api/auth/apple/callback
```

(e.g. `https://staging.igt.kylebjordahl.com/api/auth/apple/callback`). Register
this exact URL on the web **Services ID**. It's derived from the `PUBLIC_ORIGIN`
env var (below) — you don't configure the Return URL separately. The flow:

1. **`GET /auth/apple/start`** — the browser navigates here (the "Continue with
   Apple" button). The server mints a `state` + `nonce`, stores them in a
   short-lived signed cookie (`igt_apple_oauth`, `SameSite=None; Secure; HttpOnly`),
   and 302-redirects to `https://appleid.apple.com/auth/authorize` with
   `client_id=<Services ID>`, `redirect_uri=<Return URL>` (derived as
   `<PUBLIC_ORIGIN>/api/auth/apple/callback`),
   `response_type=code id_token`, `response_mode=form_post`, `scope=name email`,
   and the `state`/`nonce`.
2. The user authenticates at Apple; Apple **form-POSTs** the `id_token` (+ echoed
   `state`) to **`POST /auth/apple/callback`** (the Return URL). The SameSite=None
   cookie rides along on this cross-site POST.
3. The callback checks `state` against the cookie (login-CSRF guard), verifies the
   `id_token` (incl. the round-tripped `nonce`), issues a session, and
   302-redirects the browser to **`/app/#session=<token>`**. The token is in the
   URL **fragment** (never sent to a server / logged); the Flutter SPA reads it on
   load (`lib/util/web_auth.dart`), stores it, and strips the fragment.
   Failures redirect to `/app/#auth_error=<code>` instead.

The Return URL isn't its own config value — it's derived from **`PUBLIC_ORIGIN`**
(the public scheme+host this deployment is served on) as
`<PUBLIC_ORIGIN>/api/auth/apple/callback`. If `APPLE_WEB_CLIENT_ID` or
`PUBLIC_ORIGIN` is unset, `/auth/apple/start` and `/auth/apple/callback` return
**501** (web flow disabled); native `/auth/apple` still works.

### What you need to configure

**Apple Developer (developer.apple.com):**
1. Enable the **Sign in with Apple** capability on your App ID (the iOS bundle
   id, e.g. `com.yourco.caretaker`).
2. For the **web** client, create a **Services ID** (e.g. `com.yourco.caretaker.web`).
   Under its Sign in with Apple config, register the **domain** and the **Return
   URL** `<PUBLIC_ORIGIN>/api/auth/apple/callback` (see "Web redirect flow" above).
   Web needs a verified domain + an associated private key.
3. The token's `aud` is the **bundle id** (native) or the **Services ID** (web).

**This API:** set `APPLE_CLIENT_IDS` to the allowed `aud`(s), comma-separated.
For web, also set `PUBLIC_ORIGIN` (the public origin — the Return URL is derived
from it) and the Services ID as `APPLE_WEB_CLIENT_ID` (plain per-env vars in
`wrangler.jsonc`; `APPLE_CLIENT_IDS` can be a var or a secret):
```bash
cd apps/api
echo "com.yourco.caretaker,com.yourco.caretaker.web" \
  | pnpm wrangler secret put APPLE_CLIENT_IDS --env staging
# Web redirect flow (edit these in wrangler.jsonc per env):
#   PUBLIC_ORIGIN       = https://staging.igt.kylebjordahl.com
#   APPLE_WEB_CLIENT_ID = com.yourco.caretaker.web   # must also be in APPLE_CLIENT_IDS
#   → derived Return URL to register at Apple:
#     https://staging.igt.kylebjordahl.com/api/auth/apple/callback
```

**Flutter client (not yet wired):**
1. Add the [`sign_in_with_apple`](https://pub.dev/packages/sign_in_with_apple)
   package and, in Xcode, add the **Sign in with Apple** capability/entitlement.
2. On the login screen:
   ```dart
   final cred = await SignInWithApple.getAppleIDCredential(
     scopes: [AppleIDAuthorizationScopes.email, AppleIDAuthorizationScopes.fullName],
     nonce: sha256Hex(rawNonce), // recommended — see below
   );
   // POST { identityToken: cred.identityToken } to /auth/apple → { sessionToken }
   ```
3. Store the returned `sessionToken` the same way the magic-link flow does.

### iOS app IDs (flavors)
The native bundle id **is** the Apple `aud` for the native flow, and it differs
per environment so staging and prod installs can coexist and use separate Apple
configs:

| Flavor | Bundle id (native `aud`) | Web Services ID |
| --- | --- | --- |
| `staging` | `com.kylebjordahl.igt.staging` | `com.kylebjordahl.igt.web.staging` |
| `prod` | `com.kylebjordahl.igt` | `com.kylebjordahl.igt.web` |

These are wired as Flutter **flavors** (`apps/mobile/ios/` — build configs +
`prod`/`staging` schemes, generated by [`flutter_flavorizr`](https://pub.dev/packages/flutter_flavorizr)
from the `flavorizr:` block in `pubspec.yaml`). Build a flavor with
`flutter build ipa --flavor staging` (or `prod`); regenerate native config after
editing flavors with `dart run flutter_flavorizr -p ios:xcconfig,ios:buildTargets,ios:schema`.
Each env's `APPLE_CLIENT_IDS` lists that flavor's bundle id **and** its web
Services ID. (Web has no bundle id; there's no Android target yet.)

### Nonce (replay protection)
The **web** flow already binds a `nonce`: `/auth/apple/start` mints it, round-trips
it through Apple, and `/auth/apple/callback` passes it to `verifyAppleIdentityToken`,
which asserts `payload.nonce == nonce`.

The **native** `POST /auth/apple` path does **not** yet — to harden it, have the
client generate a random nonce, send its SHA-256 to Apple
(`getAppleIDCredential(nonce: sha256(rawNonce))`), send the **raw** nonce to the
API alongside the token, add `nonce` to `AppleSignInInput`, and pass
`nonce: sha256(rawNonce)` into `verifyAppleIdentityToken`.

### Server-to-Server Notification Endpoint (Apple → us)
When you configure Sign in with Apple on the **primary App ID**, Apple offers a
**"Server-to-Server Notification Endpoint"** field. This is **not** part of the
login handshake and is **not** where the identity token is sent — it's a separate
HTTPS URL Apple calls, out of band, to tell us about **account-lifecycle changes
the user makes on Apple's side** (in iOS Settings → their Apple ID → *Apps Using
Apple ID*), long after they've signed in. It's configured once and covers **all**
sign-in surfaces (native and web) — despite living under the App ID it isn't
native-only.

Why it matters: without it, we never learn that a user revoked access or deleted
their Apple ID, so their `identities(provider='apple')` row and any relay email we
cached would silently go stale.

**How it works.** Apple sends an HTTP POST whose body is `{ "payload": "<JWS>" }`
— a JWT signed by Apple. We verify it against the same JWKS + issuer as the
identity token (with `aud ∈ APPLE_CLIENT_IDS`) and decode its `events` claim (a
JSON *string* nesting one event):

| `type` | Meaning | What we do |
| --- | --- | --- |
| `email-disabled` / `email-enabled` | User toggled forwarding of their private-relay address | Nothing today — no stored data depends on it (no-op) |
| `consent-revoked` | User revoked our app's access | Sign out: delete the Apple identity + all the user's sessions |
| `account-delete` | User deleted their Apple ID | Delete the user (FK-cascades identities + sessions) |

The endpoint returns `200` on any valid (or unknown-subject) event so Apple
doesn't retry; only signature/shape failures return 4xx. It's unauthenticated at
the transport level — trust comes from **verifying the JWS signature**, not the
caller.

**Status: implemented** at `POST /auth/apple/notifications`
(public `<PUBLIC_ORIGIN>/api/auth/apple/notifications`) — register that URL in the
App ID's Sign in with Apple config. Verification lives in
`verifyAppleNotificationToken` (`apps/api/src/lib/apple.ts`) and the account
mutations in `handleAppleAccountEvent` (`apps/api/src/services/auth.ts`). Requires
`APPLE_CLIENT_IDS` set (else 501).

## Google Calendar — OAuth (delivery target, not a login)

The Google Calendar delivery provider needs an OAuth token. A pasted access
token still works but expires in ~1h; the proper flow stores a **refresh token**
and exchanges it for a fresh access token at delivery time.

### Configure
1. In **Google Cloud Console** → APIs & Services → Credentials, create an
   **OAuth client ID** (Web application). Add your **redirect URI(s)** (the same
   value the client sends — e.g. a small page that displays the `code`, or a
   custom scheme for native). Enable the **Google Calendar API**.
2. Set the client on the API:
   ```bash
   cd apps/api
   # ID can be a plain var (wrangler.jsonc) or a secret; secret for the secret:
   echo "<client-id>"     | pnpm wrangler secret put GOOGLE_OAUTH_CLIENT_ID --env staging
   echo "<client-secret>" | pnpm wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET --env staging
   ```
   Unset ⇒ `POST /families/:id/google/authorize-url` returns 501 and the OAuth
   path is disabled (paste-token still works).

### Flow
1. Client calls `POST /families/:id/google/authorize-url { redirectUri }` →
   consent URL (requests `access_type=offline` + `prompt=consent` so Google
   returns a refresh token).
2. The user approves; the client captures the `code` from the redirect and sends
   it on the target credential as `{ authCode, redirectUri }`.
3. The server exchanges the code for a **refresh token** (stored encrypted). At
   delivery, `GoogleCalendarProvider` gets a fresh access token via the
   server-held client secret. Re-authorizing on edit replaces the stored token.

> Note: `prompt=consent` is required to receive a refresh token; without it
> Google may return only an access token (the API responds `google_no_refresh_token`).

## Onboarding a caretaker (no email)
Until email is enabled, add caretakers with the **invite/share-link** flow (see
the Family tab): an admin creates the member, then shares a link, and the
invitee signs in (Apple, or magic-link `devToken` on staging) and is linked to
that member — the second-caretaker join flow (`JoinFlow`) then walks them
through connecting one calendar. See the `/invites` endpoints.

### Invite deep link

`POST /families/:familyId/members/:memberId/invite` returns
`{ token, expiresAt, url }`. When `PUBLIC_ORIGIN` is set, `url` is a shareable
deep link:

```
<PUBLIC_ORIGIN>/app/?invite=<token>
```

One URL serves both surfaces:

- **Web** — the Flutter web client reads `?invite=` (or `#invite=`) from the
  launch URL and renders the join flow (`onboarding/onboarding_entry.dart`).
- **iOS** — the same URL is a **Universal Link**: with the app installed,
  tapping it opens the app straight into the join flow (`app_links` captures the
  link and seeds `activeInviteTokenProvider` in `main.dart`); without the app,
  it falls back to the web flow above.

The invitee never pastes a code. The manual **Redeem invite code** path (Me tab)
stays as a fallback — the URL still contains the raw token.

Without `PUBLIC_ORIGIN` (local dev / tests), `url` is `null` and the client
shows the bare token with the paste-the-code instructions.

### iOS Universal Links setup

The Worker serves the association file at
`/.well-known/apple-app-site-association` (apex path, **not** under `/api`),
built from the `APPLE_APP_ID_PREFIX` env var — a comma-separated list of
`<TeamID>.<bundleId>` (list staging + production bundle ids). Empty ⇒ the
endpoint 404s and Universal Links are off (web fallback still works), mirroring
how empty `APPLE_CLIENT_IDS` disables Apple login.

```jsonc
// wrangler.jsonc, per env
"APPLE_APP_ID_PREFIX": "ABCDE12345.com.kylebjordahl.igt.staging"
```

The iOS app declares the domains in `ios/Runner/Runner.entitlements`
(`com.apple.developer.associated-domains` → `applinks:<host>`).

**Manual steps you own (Apple side):**

1. Set `APPLE_APP_ID_PREFIX` per env (your 10-char Apple **Team ID** +
   bundle id). Verify it's live:
   `curl https://staging.igt.kylebjordahl.com/.well-known/apple-app-site-association`.
2. Enable the **Associated Domains** capability on each App ID in the Apple
   Developer portal, and regenerate provisioning profiles so the entitlement
   ships in the build.
3. The native leg can only be verified on a **real device / TestFlight**
   against a deployed env (the Simulator + AASA don't cooperate) — tap the
   invite link from Messages and confirm the app opens into the join flow.
