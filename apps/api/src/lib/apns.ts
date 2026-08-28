/**
 * Apple Push Notification service sender.
 *
 * Token-based (JWT) auth rather than certificates: one `.p8` auth key signs for
 * every bundle id and both APNs environments, so nothing here expires annually.
 * Shaped like `lib/mailer.ts` — a narrow interface, a dev implementation that
 * captures instead of sending, and a `getPusher(env)` that picks between them.
 *
 * That fallback isn't only about tests. APNs speaks HTTP/2 only, and local
 * `wrangler dev` can't negotiate it (it works in deployed Workers) — so local
 * development always gets the `DevPusher` and real sends are verified on
 * staging.
 */
import type { ApnsEnvironment } from '@igt/domain';
import type { Bindings } from '../env.js';

export interface PushMessage {
  deviceToken: string;
  /** Becomes the `apns-topic` header — the receiving app's bundle id. */
  bundleId: string;
  environment: ApnsEnvironment;
  title: string;
  body: string;
  /** App-icon badge. `0` clears it; omit to leave it alone. */
  badge?: number;
  /** Groups related notifications in the shade. */
  threadId?: string;
  /**
   * Replaces any undelivered notification with the same id instead of stacking
   * — so a retried digest supersedes rather than duplicates.
   */
  collapseId?: string;
  /** Custom payload the app reads on tap (deep-link target). */
  data?: Record<string, unknown>;
}

/** Why a send failed, and whether it's worth trying again. */
export type PushFailure =
  /** The token is dead — 410 Unregistered, or a token/topic mismatch. Stop using it. */
  | { kind: 'device_gone'; reason: string }
  /** Transient (429/5xx, network). The queue should retry. */
  | { kind: 'retryable'; reason: string }
  /** Our fault — bad key, malformed payload. Retrying won't help. */
  | { kind: 'permanent'; reason: string };

export type PushResult = { ok: true } | ({ ok: false } & PushFailure);

export interface Pusher {
  send(message: PushMessage): Promise<PushResult>;
}

/**
 * Captures the most recent push instead of sending it, so local dev and the
 * workerd test suite can exercise the whole path without APNs.
 */
export class DevPusher implements Pusher {
  readonly sent: PushMessage[] = [];

  get lastPush(): PushMessage | null {
    return this.sent[this.sent.length - 1] ?? null;
  }

  async send(message: PushMessage): Promise<PushResult> {
    this.sent.push(message);
    console.log(`[dev-pusher] ${message.title} — ${message.body}`);
    return { ok: true };
  }
}

const APNS_HOSTS: Record<ApnsEnvironment, string> = {
  production: 'https://api.push.apple.com',
  development: 'https://api.sandbox.push.apple.com',
};

/**
 * Apple rejects a provider token refreshed more often than once per 20 minutes
 * and requires one no older than an hour, so the JWT is cached in between.
 */
const TOKEN_TTL_MS = 45 * 60 * 1000;

/** APNs `reason` strings that mean the token will never work again. */
const DEAD_TOKEN_REASONS = new Set([
  'BadDeviceToken',
  'Unregistered',
  'DeviceTokenNotForTopic',
  'TopicDisallowed',
]);

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlEncodeJson(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

/**
 * Decode a PEM-wrapped PKCS#8 private key (the `.p8` Apple hands out) to DER.
 * Tolerates the header/footer being absent and any line-ending style, because
 * this arrives via `wrangler secret put` and gets pasted by a human.
 */
export function pemToPkcs8(pem: string): Uint8Array {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export interface ApnsConfig {
  /** Contents of the `.p8` APNs auth key. */
  keyP8: string;
  /** The auth key's 10-character Key ID. */
  keyId: string;
  /** The Apple Developer Team ID. */
  teamId: string;
  fetchImpl?: typeof fetch;
  /** Clock override (ms) for tests. */
  now?: () => number;
}

/**
 * Sign an APNs provider token.
 *
 * WebCrypto's ECDSA sign returns the raw `r||s` pair, which is exactly what JWS
 * wants — unlike Node's `crypto`, which returns DER and needs unwrapping. Most
 * APNs examples do that unwrapping; doing it here would corrupt the signature.
 */
export async function signApnsToken(
  config: Pick<ApnsConfig, 'keyP8' | 'keyId' | 'teamId'>,
  issuedAtSeconds: number,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToPkcs8(config.keyP8),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const signingInput =
    `${base64UrlEncodeJson({ alg: 'ES256', kid: config.keyId })}.` +
    `${base64UrlEncodeJson({ iss: config.teamId, iat: issuedAtSeconds })}`;
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export class ApnsPusher implements Pusher {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private cached: { token: string; issuedAt: number } | null = null;

  constructor(private readonly config: ApnsConfig) {
    // Not just `config.fetchImpl ?? fetch`: the platform `fetch` is a native
    // function that requires its receiver to be the global scope. Stashing it
    // on `this.fetchImpl` and calling it as `this.fetchImpl(...)` below invokes
    // it with `this` bound to the ApnsPusher instance instead, which throws
    // "Illegal invocation" in workerd — every real send failed with that
    // before ever reaching the network. The wrapper calls `fetch` bare, so the
    // receiver is always correct regardless of how the property is called.
    this.fetchImpl = config.fetchImpl ?? ((...args) => fetch(...args));
    this.now = config.now ?? Date.now;
  }

  private async providerToken(forceRefresh = false): Promise<string> {
    const now = this.now();
    if (
      !forceRefresh &&
      this.cached &&
      now - this.cached.issuedAt < TOKEN_TTL_MS
    ) {
      return this.cached.token;
    }
    const issuedAt = Math.floor(now / 1000);
    const token = await signApnsToken(this.config, issuedAt);
    this.cached = { token, issuedAt: now };
    return token;
  }

  async send(message: PushMessage): Promise<PushResult> {
    const result = await this.post(message, await this.providerToken());
    // An expired provider token is the one failure worth retrying inline: the
    // cached JWT aged out mid-flight, and a fresh one fixes it immediately.
    if (!result.ok && result.kind === 'permanent' && result.reason === 'ExpiredProviderToken') {
      return this.post(message, await this.providerToken(true));
    }
    return result;
  }

  private async post(message: PushMessage, jwt: string): Promise<PushResult> {
    const url = `${APNS_HOSTS[message.environment]}/3/device/${message.deviceToken}`;
    const payload = {
      aps: {
        alert: { title: message.title, body: message.body },
        sound: 'default',
        ...(message.badge === undefined ? {} : { badge: message.badge }),
        ...(message.threadId ? { 'thread-id': message.threadId } : {}),
      },
      ...message.data,
    };

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `bearer ${jwt}`,
          'apns-topic': message.bundleId,
          'apns-push-type': 'alert',
          // A digest is worth waking the screen for, but it goes stale: if it
          // can't be delivered before the day it describes, drop it.
          'apns-priority': '10',
          'apns-expiration': String(Math.floor(this.now() / 1000) + 6 * 60 * 60),
          ...(message.collapseId ? { 'apns-collapse-id': message.collapseId } : {}),
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      return { ok: false, kind: 'retryable', reason: String(err) };
    }

    if (res.status === 200) return { ok: true };

    const reason = await apnsReason(res);
    if (res.status === 410 || DEAD_TOKEN_REASONS.has(reason)) {
      return { ok: false, kind: 'device_gone', reason };
    }
    if (res.status === 429 || res.status >= 500) {
      return { ok: false, kind: 'retryable', reason };
    }
    return { ok: false, kind: 'permanent', reason };
  }
}

/** APNs puts a machine-readable `reason` in the body of every error response. */
async function apnsReason(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { reason?: string };
    return body.reason ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/**
 * Choose a pusher for the environment. Fails closed to the `DevPusher` unless
 * all three APNs bindings are configured, which keeps local dev and tests
 * hermetic — and means a half-configured deployment logs digests instead of
 * throwing on every cron tick.
 */
export function getPusher(
  env: Pick<Bindings, 'APNS_KEY_P8' | 'APNS_KEY_ID' | 'APNS_TEAM_ID'>,
): Pusher {
  const { APNS_KEY_P8, APNS_KEY_ID, APNS_TEAM_ID } = env;
  if (!APNS_KEY_P8 || !APNS_KEY_ID || !APNS_TEAM_ID) return new DevPusher();
  return new ApnsPusher({
    keyP8: APNS_KEY_P8,
    keyId: APNS_KEY_ID,
    teamId: APNS_TEAM_ID,
  });
}
