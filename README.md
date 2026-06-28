# Caretaker Calendar Platform

Family logistics planner (v1): ingest school/calendar feeds, classify events
into pickup / drop-off / attendance **tasks**, assign a caretaker owner, and
push full-detail events to caretaker calendars (email/iMIP, CalDAV, Google).
Multi-tenant (a **family** is the tenant). Backend on Cloudflare; client in
Flutter (iOS + web). See the full plan in
`~/.claude/plans/i-want-to-develop-valiant-puffin.md`.

## Layout

```
apps/
  api/         Cloudflare Worker — Hono API + Cron + Queue (D1 via Drizzle)
  mobile/      Flutter app (iOS + web) — plain flutter project, NOT Nx-managed
libs/
  domain/      Zod schemas + shared types (OpenAPI contract source of truth)
  db/          Drizzle schema + D1 migrations + tenancy helpers
  ical/        ical.js (parse/RRULE) + ical-generator (VEVENT) + tsdav (CalDAV)
  classification/  rule engine (explicit create + exception cancel/shift/ignore)
  delivery/    DeliveryProvider interface + registry (providers land in Phase 4)
infra/terraform/ Cloudflare infra (Terraform); Wrangler owns worker code
tools/         OpenAPI → Dart client codegen
```

## Prerequisites

- **Node 22** (`.nvmrc` → 22.23.1): `nvm install && nvm use`
- **pnpm 9** via corepack: `corepack enable && corepack prepare pnpm@9 --activate`
- **Flutter SDK** (for `apps/mobile`) — see `apps/mobile/README.md`
- **Terraform ≥ 1.9** (for `infra/terraform`)

## Common commands

```bash
pnpm install                       # install workspace deps

pnpm nx run-many -t typecheck      # typecheck all TS projects
pnpm nx run-many -t test           # unit + workerd integration tests
pnpm nx run @igt/db:generate       # regenerate D1 migrations from schema

pnpm nx run @igt/api:dev           # wrangler dev (local API)
pnpm nx run @igt/api:db-migrate-local   # apply migrations to local D1
```

## Status

- **Phase 0 (scaffold & platform):** ✅ monorepo, API worker + D1/Drizzle,
  classification engine, OSS-lib workerd spike, Flutter shell, Terraform
  skeleton, CI pipeline.
- **Phase 1 (identity & tenancy):** ✅ magic-link auth + sessions, unified
  `family_member` model, `family_id` tenant-guard middleware, families/members
  endpoints. (Sign in with Apple verifier scaffolded.)
- **Phase 2 (feed ingest):** ✅ feed + `family_member_feed` CRUD, ICS
  parse/RRULE + idempotent `source_event` upsert, force-refresh endpoints, Cron
  scheduled ingest.
- **Phase 3 (classify & assign):** ✅ classification-rule CRUD, task generation
  (explicit create + exception baseline cancel/shift/ignore), unowned dashboard,
  claim/release with idempotent rebuilds.
- **Phase 4 (delivery):** ✅ calendar-target CRUD, envelope-encrypted secrets
  (AES-256-GCM), delivery orchestration + providers (Email iMIP, CalDAV/tsdav,
  Google REST). Email send wiring to Cloudflare Email Service + live CalDAV/
  Google verification are the remaining production hookups.

31 tests passing across 6 projects; all 6 typecheck. Next: Phase 5 (Flutter
client — needs the Flutter SDK).

> Note: the Flutter SDK and Terraform CLI are not provisioned by the Node
> toolchain; install them to run `apps/mobile` and `infra/terraform` locally.
> CI installs Flutter via `subosito/flutter-action`.
