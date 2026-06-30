# Authentication

Two login methods feed the same session model (a `sessions` row → bearer token).

| Method | State | Notes |
| --- | --- | --- |
| **Magic link** (email) | Fully implemented | Needs outbound email, which is **off** (no paid plan). In **dev/staging** the request endpoint returns the token directly (`devToken`) so you can log in without a mailbox; in **production** it does not. |
| **Sign in with Apple** | Server **implemented + tested**; client wiring + Apple config required | The primary login for deployed environments (works without email). |

## Sign in with Apple

### How it works
The client obtains an Apple **identity token** (an RS256 JWT) and POSTs it to
`POST /auth/apple`. The server (`apps/api/src/lib/apple.ts`):
1. fetches Apple's JWKS (`https://appleid.apple.com/auth/keys`), selects the key
   by the token's `kid`, and RS256-verifies the signature (WebCrypto);
2. checks `iss == https://appleid.apple.com`, `aud ∈ APPLE_CLIENT_IDS`, and `exp`;
3. maps the token's `sub` to an `identity(provider='apple')` → user → session.

If `APPLE_CLIENT_IDS` is unset the route returns **501** (Apple disabled).

### What you need to configure

**Apple Developer (developer.apple.com):**
1. Enable the **Sign in with Apple** capability on your App ID (the iOS bundle
   id, e.g. `com.yourco.caretaker`).
2. For the **web** client, create a **Services ID** (e.g. `com.yourco.caretaker.web`)
   and configure its return URL/domain.
3. The token's `aud` is the **bundle id** (native) or the **Services ID** (web).

**This API:** set `APPLE_CLIENT_IDS` to those id(s), comma-separated:
```bash
cd apps/api
echo "com.yourco.caretaker,com.yourco.caretaker.web" \
  | pnpm wrangler secret put APPLE_CLIENT_IDS --env staging
# (or set it as a plain var per-env in wrangler.jsonc — it isn't secret)
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

### Recommended follow-up: nonce (replay protection)
The verifier does **not** yet check a `nonce`. To harden against replay: have
the client generate a random nonce, send its SHA-256 to Apple
(`getAppleIDCredential(nonce: sha256(rawNonce))`), send the **raw** nonce to the
API alongside the token, and have the server assert
`sha256(rawNonce) == payload.nonce`. (Add `nonce` to `AppleSignInInput` and a
check in `verifyAppleIdentityToken`.)

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
the Family tab): an admin creates the member, shares the code, and the invitee
signs in (Apple, or magic-link `devToken` on staging) and redeems the code to
link their account to that member. See `docs/` and the `/invites` endpoints.
