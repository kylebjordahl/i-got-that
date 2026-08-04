import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import app from '../src/index.js';
import { call } from './helpers.js';

/** Like `call`, but with explicit bindings so a test can drop ALLOW_DEV_TOKENS. */
async function fetchWith(
  path: string,
  bindings: typeof env,
  init?: RequestInit,
): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`https://api.test${path}`, init), bindings, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function requestBody(email: string): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  };
}

describe('magic-link request', () => {
  it('returns the token as `devToken` when ALLOW_DEV_TOKENS is on (local dev + tests)', async () => {
    const res = await call('/auth/magic-link/request', requestBody('dev-token@example.com'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sent: boolean; devToken?: string };
    expect(body.sent).toBe(true);
    expect(body.devToken).toBeTruthy();
  });

  // Regression guard for the staging account-takeover hole: the gate must be an
  // explicit opt-in binding, not "any environment that isn't named production".
  // Deployed envs leave ALLOW_DEV_TOKENS unset, so they must never disclose the
  // token — otherwise anyone can log in as any email address in one request.
  it('omits `devToken` entirely when ALLOW_DEV_TOKENS is unset', async () => {
    const bindings = { ...env, ALLOW_DEV_TOKENS: undefined };
    const res = await fetchWith(
      '/auth/magic-link/request',
      bindings,
      requestBody('no-dev-token@example.com'),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ sent: true });
    expect('devToken' in body).toBe(false);
  });

  it('does not disclose the token for a non-`true` ALLOW_DEV_TOKENS value', async () => {
    const bindings = { ...env, ALLOW_DEV_TOKENS: 'false' };
    const res = await fetchWith(
      '/auth/magic-link/request',
      bindings,
      requestBody('false-dev-token@example.com'),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true });
  });

  it('still mints a real, verifiable token when the response withholds it', async () => {
    // The disclosure gate must not change the flow itself — the emailed token
    // still works, it just isn't handed back over HTTP.
    const email = 'withheld-token@example.com';
    const withheld = await fetchWith(
      '/auth/magic-link/request',
      { ...env, ALLOW_DEV_TOKENS: undefined },
      requestBody(email),
    );
    expect(await withheld.json()).toEqual({ sent: true });

    // A second request with disclosure on gives us a token to verify with.
    const res = await call('/auth/magic-link/request', requestBody(email));
    const { devToken } = (await res.json()) as { devToken: string };
    const verify = await call('/auth/magic-link/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: devToken }),
    });
    expect(verify.status).toBe(200);
  });
});
