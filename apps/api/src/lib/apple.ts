/**
 * Sign in with Apple — verify the identity token (a JWT) Apple returns to the
 * client, then map its `sub` to an identity (provider='apple').
 *
 * Scaffold only: full verification (fetch Apple's JWKS from
 * https://appleid.apple.com/auth/keys, select by `kid`, RS256-verify with
 * WebCrypto, and check iss/aud/exp) is wired up once Apple credentials
 * (Services ID / bundle id) are configured. The magic-link path is the
 * fully-implemented v1 login flow for now.
 */
export interface AppleIdentity {
  /** Apple's stable subject — becomes identities.provider_ref. */
  sub: string;
  email?: string;
}

export async function verifyAppleIdentityToken(
  _identityToken: string,
  _expectedAudience: string,
): Promise<AppleIdentity> {
  throw new Error('Sign in with Apple not yet configured (Phase 1 scaffold)');
}
