import {
  and,
  emailOutputs,
  emailRecipients,
  eq,
  familyMemberFeeds,
  familyMembers,
  getDb,
  inArray,
} from '@igt/db';
import {
  CreateEmailOutputInput,
  DEFAULT_EMAIL_OUTPUT_FILTERS,
  type EmailOutputFilters,
  UpdateEmailOutputInput,
} from '@igt/domain';
import { type Context, Hono } from 'hono';
import type { HonoEnv } from '../env.js';
import { emailEnabled, emailLinkBase, getOutbox } from '../lib/email.js';
import { requireFamilyMember } from '../middleware/auth.js';
import {
  consumeVerification,
  EMAIL_OUTPUTS_PER_MEMBER,
  EMAIL_VERIFICATION_DAILY_CAP,
  peekVerification,
  recipientByToken,
  RecipientUnsubscribedError,
  setUnsubscribed,
  cancelInvites,
  sendVerification,
  upcomingInvites,
  userHasVerified,
  VerificationCapExceededError,
} from '../services/email-outputs.js';
import { deferSync, enqueueReconcile } from '../services/mirror.js';
import { mayManageMemberOutputs } from './member-calendars.js';

type Db = ReturnType<typeof getDb>;
type EmailOutputRow = typeof emailOutputs.$inferSelect;

/**
 * A member's email invite outputs. Mounted under /families/:familyId (auth
 * applied by the parent router). Managed by the same people as the member's
 * calendar target — the member themselves, or an admin for an unlinked member
 * — and, unlike the target, not readable by the rest of the family: the
 * addresses are other people's.
 */
export const emailOutputRoutes = new Hono<HonoEnv>();
emailOutputRoutes.use('*', requireFamilyMember);

/**
 * The API shape: everything but the internals of verification. `unsubscribed`
 * is the recipient's own opt-out (from a link in any mail an output sent it),
 * which only they can undo — the app shows it so nobody wonders why the
 * invites stopped.
 */
function present(row: EmailOutputRow, unsubscribedAt: Date | null = null) {
  return {
    id: row.id,
    familyMemberId: row.familyMemberId,
    email: row.email,
    label: row.label,
    filters: row.filters,
    alertMinutes: row.alertMinutes ?? [],
    active: row.active,
    verified: row.verifiedAt != null,
    verifiedAt: row.verifiedAt,
    unsubscribed: unsubscribedAt != null,
    unsubscribedAt,
    lastMirroredAt: row.lastMirroredAt,
    createdAt: row.createdAt,
  };
}

async function loadManagedMember(c: Context<HonoEnv>, memberId: string) {
  const db = getDb(c.env.DB);
  const me = c.get('member');
  const member = (
    await db
      .select()
      .from(familyMembers)
      .where(and(eq(familyMembers.id, memberId), eq(familyMembers.familyId, me.familyId)))
      .limit(1)
  )[0];
  if (!member) return { error: 'not_found' as const, status: 404 as const };
  if (!mayManageMemberOutputs(me, member)) {
    return { error: 'forbidden' as const, status: 403 as const };
  }
  return { db, member };
}

/** Opt-out time per address, for addresses that have opted out. */
async function unsubscribedAtByEmail(db: Db, emails: string[]): Promise<Map<string, Date>> {
  if (emails.length === 0) return new Map();
  // Bounded by EMAIL_OUTPUTS_PER_MEMBER, so one inArray is fine under D1's cap.
  const rows = await db
    .select({ email: emailRecipients.email, at: emailRecipients.unsubscribedAt })
    .from(emailRecipients)
    .where(inArray(emailRecipients.email, emails));
  return new Map(rows.filter((r) => r.at != null).map((r) => [r.email, r.at!]));
}

async function loadOutput(db: Db, memberId: string, outputId: string) {
  return (
    await db
      .select()
      .from(emailOutputs)
      .where(and(eq(emailOutputs.id, outputId), eq(emailOutputs.familyMemberId, memberId)))
      .limit(1)
  )[0];
}

/** A `sourceLinkIds` filter may only name this member's own linked calendars. */
async function unknownLinkIds(
  db: Db,
  memberId: string,
  filters: EmailOutputFilters,
): Promise<string[]> {
  if (!filters.sourceLinkIds) return [];
  const found = await db
    .select({ id: familyMemberFeeds.id })
    .from(familyMemberFeeds)
    .where(
      and(
        eq(familyMemberFeeds.familyMemberId, memberId),
        inArray(familyMemberFeeds.id, filters.sourceLinkIds),
      ),
    );
  const ok = new Set(found.map((r) => r.id));
  return filters.sourceLinkIds.filter((id) => !ok.has(id));
}

/**
 * Without a mail binding a verification can't go out, so a new address could
 * never be confirmed. Dev/tests (dev tokens allowed) get the capture-only
 * outbox and the token back in the response instead.
 */
function canVerify(env: HonoEnv['Bindings']): boolean {
  return emailEnabled(env) || env.ALLOW_DEV_TOKENS === 'true';
}

const clip = (s: string) => (s.length > 60 ? `${s.slice(0, 59)}…` : s);

async function mailVerification(
  c: Context<HonoEnv>,
  db: Db,
  output: EmailOutputRow,
  member: typeof familyMembers.$inferSelect,
) {
  const raw = await sendVerification(db, getOutbox(c.env), {
    userId: c.get('user').id,
    output,
    memberName: clip(member.relationName),
    requesterName: clip(c.get('user').displayName),
    linkBase: emailLinkBase(c.env),
  });
  return c.env.ALLOW_DEV_TOKENS === 'true' ? { devToken: raw } : {};
}

emailOutputRoutes.get('/members/:memberId/email-outputs', async (c) => {
  const loaded = await loadManagedMember(c, c.req.param('memberId'));
  if ('error' in loaded) return c.json({ error: loaded.error }, loaded.status);
  const rows = await loaded.db
    .select()
    .from(emailOutputs)
    .where(eq(emailOutputs.familyMemberId, loaded.member.id));
  const optedOut = await unsubscribedAtByEmail(
    loaded.db,
    rows.map((r) => r.email),
  );
  return c.json({
    outputs: rows.map((r) => present(r, optedOut.get(r.email) ?? null)),
    emailEnabled: emailEnabled(c.env),
  });
});

/**
 * Add an output. It starts unverified and a verification mail goes to the
 * address — unless the caller has already verified that address on another
 * output, in which case it's live at once and costs no mail.
 */
emailOutputRoutes.post('/members/:memberId/email-outputs', async (c) => {
  const parsed = CreateEmailOutputInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
  }
  const loaded = await loadManagedMember(c, c.req.param('memberId'));
  if ('error' in loaded) return c.json({ error: loaded.error }, loaded.status);
  const { db, member } = loaded;
  if (!canVerify(c.env)) return c.json({ error: 'email_disabled' }, 503);

  const filters = parsed.data.filters ?? DEFAULT_EMAIL_OUTPUT_FILTERS;
  const unknown = await unknownLinkIds(db, member.id, filters);
  if (unknown.length > 0) {
    return c.json({ error: 'unknown_source', linkIds: unknown }, 400);
  }
  const siblings = await db
    .select({ email: emailOutputs.email })
    .from(emailOutputs)
    .where(eq(emailOutputs.familyMemberId, member.id));
  if (siblings.some((s) => s.email === parsed.data.email)) {
    return c.json({ error: 'duplicate_email' }, 409);
  }
  if (siblings.length >= EMAIL_OUTPUTS_PER_MEMBER) {
    return c.json({ error: 'too_many_outputs', limit: EMAIL_OUTPUTS_PER_MEMBER }, 409);
  }

  // Up front, not only in sendVerification: an address the caller already
  // verified skips that mail, and an opted-out one must be refused either way.
  if ((await unsubscribedAtByEmail(db, [parsed.data.email])).size > 0) {
    return c.json({ error: 'recipient_unsubscribed' }, 409);
  }

  const user = c.get('user');
  const alreadyVerified = await userHasVerified(db, user.id, parsed.data.email);
  const output = (
    await db
      .insert(emailOutputs)
      .values({
        familyId: member.familyId,
        familyMemberId: member.id,
        createdByUserId: user.id,
        email: parsed.data.email,
        label: parsed.data.label ?? null,
        filters,
        alertMinutes: parsed.data.alertMinutes ?? null,
        verifiedAt: alreadyVerified ? new Date() : null,
      })
      .returning()
  )[0]!;

  if (alreadyVerified) {
    enqueueReconcile(c, { kind: 'member', memberId: member.id });
    return c.json({ output: present(output), verificationSent: false }, 201);
  }
  try {
    const dev = await mailVerification(c, db, output, member);
    return c.json({ output: present(output), verificationSent: true, ...dev }, 201);
  } catch (err) {
    // Nothing was mailed, so don't leave an output that can never verify.
    await db.delete(emailOutputs).where(eq(emailOutputs.id, output.id));
    if (err instanceof RecipientUnsubscribedError) {
      return c.json({ error: 'recipient_unsubscribed' }, 409);
    }
    if (err instanceof VerificationCapExceededError) {
      return c.json({ error: 'too_many_requests', limit: EMAIL_VERIFICATION_DAILY_CAP }, 429);
    }
    throw err;
  }
});

/** Change label/filters/alerts, or pause. The address itself is fixed. */
emailOutputRoutes.patch('/members/:memberId/email-outputs/:outputId', async (c) => {
  const parsed = UpdateEmailOutputInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
  }
  const loaded = await loadManagedMember(c, c.req.param('memberId'));
  if ('error' in loaded) return c.json({ error: loaded.error }, loaded.status);
  const { db, member } = loaded;
  const output = await loadOutput(db, member.id, c.req.param('outputId'));
  if (!output) return c.json({ error: 'not_found' }, 404);
  if (parsed.data.filters) {
    const unknown = await unknownLinkIds(db, member.id, parsed.data.filters);
    if (unknown.length > 0) {
      return c.json({ error: 'unknown_source', linkIds: unknown }, 400);
    }
  }
  const { label, filters, alertMinutes, active } = parsed.data;
  const row = (
    await db
      .update(emailOutputs)
      .set({
        ...(label !== undefined ? { label } : {}),
        ...(filters ? { filters } : {}),
        ...(alertMinutes ? { alertMinutes } : {}),
        ...(active !== undefined ? { active } : {}),
      })
      .where(eq(emailOutputs.id, output.id))
      .returning()
  )[0]!;
  // Invites that no longer match are cancelled; newly matching ones go out.
  enqueueReconcile(c, { kind: 'member', memberId: member.id });
  const optedOut = await unsubscribedAtByEmail(db, [row.email]);
  return c.json({ output: present(row, optedOut.get(row.email) ?? null) });
});

/** Re-send the verification mail (counts against the daily cap). */
emailOutputRoutes.post(
  '/members/:memberId/email-outputs/:outputId/resend-verification',
  async (c) => {
    const loaded = await loadManagedMember(c, c.req.param('memberId'));
    if ('error' in loaded) return c.json({ error: loaded.error }, loaded.status);
    const { db, member } = loaded;
    const output = await loadOutput(db, member.id, c.req.param('outputId'));
    if (!output) return c.json({ error: 'not_found' }, 404);
    if (output.verifiedAt) return c.json({ error: 'already_verified' }, 409);
    if (!canVerify(c.env)) return c.json({ error: 'email_disabled' }, 503);
    try {
      const dev = await mailVerification(c, db, output, member);
      return c.json({ verificationSent: true, ...dev });
    } catch (err) {
      if (err instanceof RecipientUnsubscribedError) {
        return c.json({ error: 'recipient_unsubscribed' }, 409);
      }
      if (err instanceof VerificationCapExceededError) {
        return c.json({ error: 'too_many_requests', limit: EMAIL_VERIFICATION_DAILY_CAP }, 429);
      }
      throw err;
    }
  },
);

/** Remove an output, mailing cancellations for its upcoming invites first. */
emailOutputRoutes.delete('/members/:memberId/email-outputs/:outputId', async (c) => {
  const loaded = await loadManagedMember(c, c.req.param('memberId'));
  if ('error' in loaded) return c.json({ error: loaded.error }, loaded.status);
  const { db, member } = loaded;
  const output = await loadOutput(db, member.id, c.req.param('outputId'));
  if (!output) return c.json({ error: 'not_found' }, 404);
  // Read what to cancel before the delete cascades those rows away; the mails
  // themselves are slow network calls, so they go out in the background.
  const upcoming = await upcomingInvites(db, output.id);
  await db.delete(emailOutputs).where(eq(emailOutputs.id, output.id));
  if (upcoming.length > 0 && emailEnabled(c.env)) {
    deferSync(
      c.executionCtx,
      cancelInvites(db, getOutbox(c.env), output.email, upcoming, emailLinkBase(c.env)),
    );
  }
  return c.json({ ok: true });
});

// --- Public verification link --------------------------------------------------

/**
 * The link in a verification mail. Opening it (GET) only shows a confirm
 * button: mail scanners prefetch links, and a prefetch mustn't sign the
 * recipient up for invites they never agreed to. The POST behind the button
 * does the verifying. Unauthenticated by design — possession of the token is
 * the proof that the reader has the mailbox.
 */
export const emailVerifyRoutes = new Hono<HonoEnv>();

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5}button{font:inherit;padding:.6rem 1.2rem;border-radius:.5rem;border:0;background:#2563eb;color:#fff;cursor:pointer}</style></head><body><h1>${title}</h1>${body}</body></html>`;
}

const FAILURE: Record<'invalid' | 'expired' | 'gone', string> = {
  invalid: 'This link has already been used or is not valid.',
  expired: 'This link has expired. Ask whoever set this up to send a new one.',
  gone: 'The invites this link was for have since been turned off.',
};

emailVerifyRoutes.get('/verify/:token', async (c) => {
  const outcome = await peekVerification(getDb(c.env.DB), c.req.param('token'));
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  if (!outcome.ok) return c.html(page('Link not usable', `<p>${FAILURE[outcome.reason]}</p>`), 410);
  return c.html(
    page(
      'Confirm calendar invites',
      '<p>Confirm that you want to receive calendar invites at this address. You can ignore this page to receive nothing.</p><form method="post"><button type="submit">Confirm</button></form>',
    ),
  );
});

emailVerifyRoutes.post('/verify/:token', async (c) => {
  const db = getDb(c.env.DB);
  const outcome = await consumeVerification(db, c.req.param('token'));
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  if (!outcome.ok) return c.html(page('Link not usable', `<p>${FAILURE[outcome.reason]}</p>`), 410);
  enqueueReconcile(c, { kind: 'member', memberId: outcome.output.familyMemberId });
  return c.html(page('Confirmed', '<p>Calendar invites will now arrive at this address.</p>'));
});

// --- Public unsubscribe link ---------------------------------------------------

/**
 * The unsubscribe link in every mail an email output sends (verification and
 * invites), mounted at /email. GET shows a button, for the same prefetch
 * reason as verification; POST unsubscribes — which is also what a mail
 * client's one-click "Unsubscribe" sends (RFC 8058: a POST with body
 * `List-Unsubscribe=One-Click`, no confirmation page), so POST must act
 * without further interaction. The token is the credential and only covers
 * this one address.
 */
export const emailUnsubscribeRoutes = new Hono<HonoEnv>();

emailUnsubscribeRoutes.get('/unsubscribe/:token', async (c) => {
  const recipient = await recipientByToken(getDb(c.env.DB), c.req.param('token'));
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  if (!recipient) return c.html(page('Link not usable', `<p>${FAILURE.invalid}</p>`), 404);
  if (recipient.unsubscribedAt) {
    return c.html(
      page(
        'Unsubscribed',
        '<p>This address gets no calendar invites or confirmation requests.</p><form method="post" action="../resubscribe/' +
          encodeURIComponent(c.req.param('token')) +
          '"><button type="submit">Allow them again</button></form>',
      ),
    );
  }
  return c.html(
    page(
      'Unsubscribe',
      '<p>Stop all calendar invites and confirmation requests to this address, from everyone who uses the app.</p><form method="post"><button type="submit">Unsubscribe</button></form>',
    ),
  );
});

emailUnsubscribeRoutes.post('/unsubscribe/:token', async (c) => {
  const email = await setUnsubscribed(getDb(c.env.DB), c.req.param('token'), true);
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  if (!email) return c.html(page('Link not usable', `<p>${FAILURE.invalid}</p>`), 404);
  return c.html(
    page(
      'Unsubscribed',
      '<p>No more calendar invites or confirmation requests will be sent to this address. Invites already in your calendar stay there.</p><form method="post" action="../resubscribe/' +
        encodeURIComponent(c.req.param('token')) +
        '"><button type="submit">Undo</button></form>',
    ),
  );
});

emailUnsubscribeRoutes.post('/resubscribe/:token', async (c) => {
  const email = await setUnsubscribed(getDb(c.env.DB), c.req.param('token'), false);
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  if (!email) return c.html(page('Link not usable', `<p>${FAILURE.invalid}</p>`), 404);
  return c.html(
    page(
      'Invites allowed again',
      '<p>Invites you had already confirmed will resume. Nothing new is sent to this address unless you confirm it.</p>',
    ),
  );
});
