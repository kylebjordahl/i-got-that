import { getDb } from '@igt/db';
import { AssistantCoverageQuery } from '@igt/domain';
import { Hono } from 'hono';
import type { HonoEnv } from '../env.js';
import { authMiddleware } from '../middleware/auth.js';
import { assistantMembers, coverageAnswer } from '../services/assistant.js';

/**
 * Read-only answers for an on-device voice assistant (the iOS App Intents in
 * `apps/mobile/ios/Runner/AssistantIntents.swift`). Mounted at `/assistant`
 * under a bare session, NOT family-scoped: a person asking Siri about "Felix"
 * doesn't say which family, so both endpoints span every family the user is in
 * and resolve tenancy from the member id.
 */
export const assistantRoutes = new Hono<HonoEnv>();
assistantRoutes.use('*', authMiddleware);

/** Everyone the assistant can be asked about, for Siri's name resolution. */
assistantRoutes.get('/members', async (c) => {
  const members = await assistantMembers(getDb(c.env.DB), c.get('user').id);
  return c.json({ members });
});

/** "Who's picking up Felix tomorrow?" — structured tasks plus the sentence to speak. */
assistantRoutes.get('/coverage', async (c) => {
  const parsed = AssistantCoverageQuery.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);
  }
  const answer = await coverageAnswer(
    getDb(c.env.DB),
    c.get('user').id,
    parsed.data,
    new Date(),
  );
  if (!answer) return c.json({ error: 'not_found' }, 404);
  return c.json(answer);
});
