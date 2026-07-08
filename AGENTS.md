# AGENTS.md

Guidance for AI agents (and humans) working in this repo. This is the canonical
instructions file; other tool-specific files (`CLAUDE.md`, `GEMINI.md`,
`.cursorrules`, `.github/copilot-instructions.md`) just point here.

## What this is

**i-got-that** — a family-logistics coordination layer built on one recursive
primitive, the **unified calendar** (PRD 1). Two decoupled transforms, a
**family is the tenant**:

```
feeds → ingest → source_events
source_events + link(baseline + link_rules) → SYNTHESIS → calendar_events + pending_decisions
target calendar → READ-BACK → calendar_events (provenance 'human')
calendar_events → TASK-GEN → tasks (pickup/drop-off/attendance, claim-only)
claim → a 'claimed_task' event on the CLAIMER's unified calendar (the recursion)
calendar_events (synthesized|claimed) → MIRROR → the member's one target calendar
```

Every member (child or caretaker) can have a unified calendar: the DB
(`calendar_events`) is canonical; an optional per-member external target
(CalDAV/iCloud or Google, `member_calendars`) is a write-through mirror whose
human-authored events are read back in. Unmatched exception-feed events become
**pending decisions** — the system never guesses.

- Product spec: PRD 1 (unified calendars & task generation); `docs/original-plan.md` is the superseded original plan
- Deploy: `docs/DEPLOYMENT.md` · Auth: `docs/AUTH.md`

## Stack & layout

Nx monorepo (TypeScript) + a plain Flutter app (not Nx-managed).

```
apps/
  api/        Cloudflare Worker — Hono API, Cron, Queue consumer (+ static web assets in deployed envs)
  mobile/     Flutter app (iOS + web), Riverpod + dio
libs/
  domain/     Zod schemas / shared types — the API contract source of truth
  db/         Drizzle schema + D1 migrations
  ical/       ical.js / ical-generator / tsdav wrappers
  classification/  pure engine: synthesis (override pipeline + baseline) + task generation
  delivery/   DeliveryProvider interface + CalDAV/Google providers (email parked, unregistered)
infra/terraform/  durable Cloudflare infra (D1, queues)
.github/workflows/  CI + staging/production deploy
```

Backend: Cloudflare Workers + Hono + D1 + Drizzle. Client: Flutter (Riverpod, dio).

## Toolchain quirks (read before running anything)

- **Node 24** (see `.nvmrc`, currently 24.18.0). A stale **system `node` may be
  v14** and will fail — use nvm. On this dev machine prepend:
  `export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"`.
- **pnpm 9**: `corepack enable && corepack prepare pnpm@9 --activate`, then `pnpm install`.
- **Vitest is pinned** to `3.2.6` + `@cloudflare/vitest-pool-workers@0.8.71` (pnpm
  overrides). Do **not** bump vitest to 4 — the newer pool dropped
  `defineWorkersConfig`. API tests run inside `workerd` with real D1 bindings.
- `tsconfig.base` sets `declaration:false, noEmit:true` (no build step; packages
  consume each other via `@igt/*` source path-mapping). `.npmrc` uses
  `shamefully-hoist=true`.
- **Flutter via `fvm`** (Flutter 3.44.x). Don't call bare `flutter` for local work.

## Commands

```bash
# Backend: typecheck + integration tests (all TS projects)
pnpm nx run-many -t typecheck test --projects=tag:language:typescript
# Just the API worker tests
node_modules/.bin/vitest run --root apps/api
# DB: generate a migration after editing libs/db/src/schema.ts
pnpm db:generate                 # then commit libs/db/migrations/*
# Flutter (always before committing client changes)
cd apps/mobile && fvm flutter analyze && fvm flutter test
```

**Always** run the relevant typecheck/tests before committing. Add or update tests
for behaviour changes (the suite is the safety net for the reconcile/auth/CalDAV
paths in particular).

## Architecture notes that bite

- **`synthKey` is the idempotency backbone** of `calendar_events`
  (`apps/api/src/services/synthesis.ts`): synthesis computes the desired key
  set per link+window and upserts/deletes by `(familyMemberId, synthKey)` with
  a `contentHash` skip — rule/config changes resynthesize without duplicating.
  Key forms: `bl:<linkId>:<date>`, `ev:<linkId>:<sourceEventId>`,
  `pd:<decisionId>`, `task:<taskId>`, `ext:<uid>:<recurrenceId>`.
- **Two recursion guards** keep the claim loop from echoing: task-gen never
  generates from `claimed_task` events (`libs/classification`), and read-back
  never imports events whose UID starts with `igt-`
  (`apps/api/src/services/readback.ts`). Don't weaken either.
- **The mirror is a reconcile model** (`syncMemberMirror`/`syncFamilyMirror` in
  `apps/api/src/services/mirror.ts`): a member's synthesized + claimed events
  are continuously reflected onto their one target calendar;
  `event_mirrors.payloadHash` skips unchanged events. `event_mirrors` has **no
  FK to calendar_events on purpose** — mirror rows must outlive their events so
  the next reconcile can cancel the remote copy. Route handlers schedule
  reconciles via `enqueueReconcile(c, job)` → Cloudflare **Queue** (deployed)
  or inline `waitUntil` (local/tests). Never `await` a full reconcile in a
  request path (it blocks on slow CalDAV/Google writes).
- **Owned tasks are never deleted by reconciliation** (`services/task-gen.ts`):
  only unowned tasks are removed/swept, and user-converted (`createdVia:
  'manual'`) tasks are healed, never reclassified.
- **CalDAV** does a direct authenticated `PUT`/`DELETE` to the discovered
  collection URL (`libs/delivery/src/caldav.ts`), not tsdav's create-only helper.
- **Credentials** are envelope-encrypted (KEK → DEK) into the `secret` table and
  never returned by the API. Accounts are **user-owned** (reused across
  families); the OAuth client secret stays in `apps/api`; the Google provider
  gets an injected refresher, so `libs/delivery` never sees it.
- **Auth**: magic-link (returns a `devToken` outside production), Sign in with
  Apple (server done; client wiring TODO), and member-claim invites
  (`/invites/:token/accept` links an existing user to a pre-created member).
- **Deployed staging is single-origin**: one Worker on
  `staging.igt.kylebjordahl.com` serving `/api/*` (API, prefix stripped),
  `/app/*` (Flutter web via the `ASSETS` binding), and `/` → `/app/`. Gated on the
  `ASSETS` binding so local/dev/tests serve the API at the root.
- **Permissions** are enforced server-side: a member's calendar target draws
  only from the **caller's own** connected accounts, and a member linked to a
  different user keeps their target private even from admins; feeds + family
  structure + role flags are admin-only.
- **Wipe-and-reseed tooling**: `tools/reset-local.zsh` (local D1),
  `tools/reset-staging.zsh` (staging; keep `tools/reset-staging.sql`'s drop
  list in sync with the schema), `tools/seed-dev.zsh` (demo family via the
  live API — update it when API shapes change).

## Working agreement

- **Branch + PR per change** (see `CONTRIBUTING.md`). Do not push to `main`.
- Match the surrounding code's style/idioms; keep changes focused.
- Update `docs/` when you change deploy/auth/config behaviour.
- Outstanding work is tracked as GitHub issues — check open issues before starting.
