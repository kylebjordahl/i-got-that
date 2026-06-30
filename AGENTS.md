# AGENTS.md

Guidance for AI agents (and humans) working in this repo. This is the canonical
instructions file; other tool-specific files (`CLAUDE.md`, `GEMINI.md`,
`.cursorrules`, `.github/copilot-instructions.md`) just point here.

## What this is

**i-got-that** — a Caretaker Calendar Platform. It ingests calendar feeds (e.g. a
school ICS), classifies events into pickup/drop-off/attendance **tasks**, lets
caretakers claim/own tasks, and reflects owned tasks onto each caretaker's
calendars (CalDAV/iCloud, Google, email/iMIP). A **family is the tenant**.

- Product plan: `docs/original-plan.md`
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
  classification/  rule engine (explicit + exception/baseline)
  delivery/   DeliveryProvider interface + Email/CalDAV/Google providers
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

- **Delivery is a reconcile model** (`syncMember`/`syncFamily` in
  `apps/api/src/services/delivery.ts`): a caretaker's owned tasks are continuously
  reflected onto their calendar targets; `delivery.payloadHash` skips unchanged
  events. Route handlers schedule reconciles via `enqueueReconcile(c, job)` →
  Cloudflare **Queue** (deployed) or inline `waitUntil` (local/tests). Never
  `await` a full reconcile in a request path (it blocks on slow CalDAV/Google
  writes — that caused the member-edit hang).
- **CalDAV** does a direct authenticated `PUT`/`DELETE` to the discovered
  collection URL (`libs/delivery/src/caldav.ts`), not tsdav's create-only helper.
- **Credentials** are envelope-encrypted (KEK → DEK) into the `secret` table and
  never returned by the API. The OAuth client secret stays in `apps/api`; the
  Google provider gets an injected refresher, so `libs/delivery` never sees it.
- **Auth**: magic-link (returns a `devToken` outside production), Sign in with
  Apple (server done; client wiring TODO), and member-claim invites
  (`/invites/:token/accept` links an existing user to a pre-created member).
- **Deployed staging is single-origin**: one Worker on
  `staging.igt.kylebjordahl.com` serving `/api/*` (API, prefix stripped),
  `/app/*` (Flutter web via the `ASSETS` binding), and `/` → `/app/`. Gated on the
  `ASSETS` binding so local/dev/tests serve the API at the root.
- **Permissions** are enforced server-side: caretakers edit only their own
  calendar targets (admins any); feeds + family structure + role flags are
  admin-only.

## Working agreement

- **Branch + PR per change** (see `CONTRIBUTING.md`). Do not push to `main`.
- Match the surrounding code's style/idioms; keep changes focused.
- Update `docs/` when you change deploy/auth/config behaviour.
- Outstanding work is tracked as GitHub issues — check open issues before starting.
