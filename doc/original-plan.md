# Caretaker Calendar Platform — Product Development Plan

## Context

The user is building a lightweight, standards-based (CalDAV/iCalendar) platform that, on
reflection, comprises **two distinct features** sharing the same calendar plumbing:

1. **Family logistics planner** *(v1)* — coordinate which caretaker is responsible for each
   child's events (school pickup/drop-off, appointments, attendance), and write the resulting
   "logistics events" onto caretaker calendars.
2. **Calendar "firewall"** *(v2)* — 1-way or 2-way synchronization between calendars that
   exposes only obfuscated busy-blocks, not event details (e.g. personal ↔ work, or a
   caretaker's work calendar surfaced to a spouse as opaque blocks). This is the generalized
   form of the block-only/detail-stripping machinery the planner already needs.

This plan covers **Feature 1 in full for v1** and scopes Feature 2 to **v2** (see the v2
section). The shared calendar primitives (event abstraction, delivery providers) are built in
v1; the **detail-stripping / "busy-block" / travel-padding** machinery is deliberately **NOT
in v1** — it belongs with Feature 2 (and the v1.1 block-only output), so v1 writes
**full-detail events only**.

The Feature 1 core problem: a family ingests external calendar feeds (e.g. a school's ICS
feed), turns events into actionable **tasks** (pickup / drop-off / attendance), assigns an
**owner**, and pushes the result onto each caretaker's personal calendar **in full detail**
(privacy-stripped busy-blocks are a later concern — see v1.1/v2).

It must be a **safe multi-tenant** system where a **family is the unit of tenancy** and a user
can belong to multiple families. Member capabilities are modeled as **independent boolean
flags** (caretaker, admin) rather than a single role enum — so an extended-family helper is
simply a caretaker without admin rights, with no schema change needed. Backend runs on
**Cloudflare** (TypeScript). The client is a **Flutter** app targeting **iOS and web in v1**
(Android later).
Everything lives in **one Nx monorepo** (Nx manages the TypeScript projects; the Flutter app
lives in the repo as a plain Flutter project, not Nx-managed). Goal: ship a usable prototype
for the user's own family fast, then iterate.

### Decisions locked with the user
- **Calendar output**: abstraction with pluggable delivery providers. **v1 ships email/iMIP
  invites, CalDAV-write (iCloud + generic), AND Google Calendar (OAuth + Calendar API)** —
  full-detail only. The client provides a **guided, per-provider connect flow** (iCloud
  app-specific password is the primary case; Google is OAuth consent; generic CalDAV is
  URL+credentials). A **per-caretaker ICS feed** provider and block-only output come later.
- **Feed modes**: each input feed is configured as either **`explicit`** (events on the feed
  ARE the things that happen) or **`exception`/inverted** (the feed describes deviations from a
  configured standard recurring baseline, e.g. "school every Mon–Fri" — feed events are
  no-school / early-dismissal exceptions, and purely informational events like "picture day"
  must NOT be mistaken for a no-school day). **Required in v1.**
- **Classification**: keyword/pattern **rules with manual override**. On `exception` feeds the
  rule *effect* is inverted — a matched event cancels/shifts baseline tasks (or is explicitly
  ignored) rather than creating tasks.
- **Auth**: **Sign in with Apple + email magic link** for app login. *(Google OAuth also
  appears in v1, but only as a per-calendar-target authorization for the Google Calendar
  provider — it is not a login method.)*
- **Monorepo**: **Nx for the TypeScript projects only**; the Flutter app lives in the repo as
  a **plain Flutter project, invoked via the `flutter` CLI** (optionally wrapped in Nx
  `run-commands` for unified CI, but not Nx-managed). No `nx-flutter`, no Nx version pin, no
  Melos.
- **Data layer**: **Cloudflare D1 + Drizzle**, row-level family scoping. *(Drizzle over
  TypeORM/Prisma because it's edge-native: no decorators/`reflect-metadata` or codegen engine,
  tiny bundle + fast cold starts in the Workers V8 isolate, and a first-class D1 driver.
  TypeORM's decorator/reflection model is awkward on Workers; Prisma's edge story is heavier.
  Drizzle is SQL-first with strong TS inference, which suits D1's plain SQLite.)*
- **v1 scope**: feed ingest+refresh (explicit + exception modes), classification rules,
  manual claim + one-off swap + unowned view, **full-detail email iMIP and CalDAV-write
  delivery**. **Recurring ownership rules and block-only output move to v1.1** → v1 assignment
  is manual and output is always full-detail.
- **v2 scope**: the standalone calendar **firewall** (bidirectional obfuscated sync).
- **Libraries**: use well-supported OSS, not hand-rolled protocol code — **ical.js** +
  **ical-generator** for iCalendar, **tsdav** for CalDAV, Google **Calendar REST API** for
  Google (see "Third-party libraries").
- **Secrets**: CalDAV passwords / OAuth tokens stored via **app-level envelope encryption**
  (see "Secrets & credentials") — never plaintext in D1.
- **Access**: **no public signup.** Account/family creation is **invite-gated** (`invite`
  table) to support a private beta of a few families, including invites to **start a new
  family** (not only join an existing one).
- **Deploy/IaC**: **Terraform (Cloudflare provider)** for infra resources + **Wrangler** for
  Worker code/versions and D1 migrations, with **staging→prod** environments and E2E gating
  (see "Deployment, IaC & CI/CD").
- **Reference feed**: the user's real school feed (Children's House PDX, a Google-hosted public
  `.ics`) is **`exception`-mode** (it lists closures/in-service/informational events over an
  assumed Mon–Fri baseline) and is the canonical dev/test fixture.

### Reality checks done during planning
- Outbound email uses **Cloudflare Email Service** (all-in-one-vendor; no third party). Its
  50-recipient-per-send cap is irrelevant here — every invite is single-recipient. It supports
  **raw RFC 5322 MIME** (Workers `EmailMessage` binding / `send_raw` REST), so we hand-build the
  `text/calendar; method=REQUEST` part and full MIME ourselves. It's in public beta — acceptable
  for a prototype; the `delivery` abstraction keeps a swap to another sender mechanical if
  needed. (Workers are V8/no-TCP, so SMTP libs are out regardless.)
- **Inbound RSVP** (accept/decline) arrives as iMIP `METHOD:REPLY` email → handle via
  **Cloudflare Email Routing + an Email Worker** that parses `PARTSTAT`.
- `@nxrocks/nx-flutter` is stale (`10.0.1`, Nx 19–21 only) — so we **deliberately do not run
  Flutter through Nx**. The single Flutter app uses the plain `flutter` CLI, removing any Nx
  version coupling. (Revisit a Dart workspace tool only if multiple Dart packages emerge.)
- v1 output is **full-detail only**, via two providers: a CalDAV write (event written straight
  to the chosen calendar) or an email/iMIP invite (adds RSVP accept/decline, which drives
  reassignment). A caretaker can target multiple calendars. Block-only / privacy-stripped
  output (with travel padding) is intentionally deferred — see v1.1/v2; the `delivery`
  abstraction is built so it drops in later without reworking callers.

---

## Architecture Overview

### Monorepo layout (Nx)
```
/apps
  api/            Cloudflare Worker — HTTP API (Hono), Cron, Queue consumers
  email-worker/   Cloudflare Email Worker — inbound iMIP REPLY parsing
  mobile/         Flutter app (plain Flutter project, not Nx-managed); iOS + web (v1)
/libs
  domain/         Shared TS types + Zod schemas (source of truth for API contract)
  db/             Drizzle schema + D1 migrations + tenant-scoped query helpers
  ical/           thin wrappers over OSS (NOT hand-rolled): ical.js (parse + RRULE expansion),
                  ical-generator (VEVENT REQUEST/CANCEL MIME), tsdav (CalDAV client)
  classification/ Rule engine: SourceEvent -> Task[] for explicit feeds; baseline+exception
                  resolver (no-school cancels, early-dismissal shifts, informational ignored)
                  for inverted feeds
  delivery/       DeliveryProvider interface + EmailImipProvider + CalDavProvider (tsdav;
                  iCloud/generic) + GoogleCalendarProvider (Google Calendar REST API) — all v1;
                  IcsFeedProvider later
/tools            Codegen (OpenAPI -> Dart client), scripts
```
TS and Dart cannot share code directly → the TS API publishes an **OpenAPI spec generated
from the Zod schemas in `libs/domain`**, and the Flutter client is **code-generated** from it.

### Cloudflare stack
- **Worker (Hono)** — REST API, auth, session validation, tenant guard middleware.
- **D1 + Drizzle** — primary store; every tenant-scoped table carries `family_id` and every
  query goes through a helper that injects the caller's authorized `family_id`.
- **Cron Triggers** — poll subscribed ICS feeds on a schedule; enqueue parse jobs.
- **Queues** — (a) feed-parse jobs, (b) delivery dispatch (send/update/cancel invites). Keeps
  Cron fast and makes delivery retryable.
- **Email Routing + Email Worker** — inbound iMIP REPLY → update Delivery RSVP state.
- **Cloudflare Email Service** — outbound, raw MIME message carrying the `text/calendar`
  invite part (single-recipient).
- **KV or D1** — session/magic-link token storage (short TTL).
- (Later) **Durable Object per family** — real-time fan-out + push coordination.

> **Flutter & Nx**: the Flutter app is **not** routed through Nx — it's a plain Flutter
> project driven by the `flutter` CLI (build/test/analyze). This avoids the stale
> `nx-flutter` plugin and any Nx version pin. CI runs the Flutter steps as their own job (or a
> thin Nx `run-commands` wrapper if we want one `nx` entrypoint). No Melos. If the
> OpenAPI-generated client/models later become multiple Dart packages, prefer **Dart pub
> workspaces** for resolution.

### Secrets & credentials (CalDAV passwords, Google OAuth tokens)
- **Envelope encryption, app-level.** A long-lived **KEK** lives in a Worker secret / Cloudflare
  Secrets Store (never in D1). Each credential gets a random **DEK**; we AES-256-GCM encrypt the
  credential with the DEK (WebCrypto, available in Workers), wrap the DEK with the KEK, and store
  `{ciphertext, iv, wrapped_dek, key_version}` in the `secret` table. Decryption happens only
  in-Worker at delivery time. `key_version` supports KEK rotation.
- Prefer the **least-privileged credential** per provider: iCloud **app-specific passwords**
  (revocable, not the Apple ID password); Google **OAuth refresh tokens** scoped to
  `calendar.events` only. Plaintext credentials are never logged or returned by the API.

### Third-party libraries — use OSS, don't hand-roll
- **ical.js** (parse + RRULE expansion) and **ical-generator** (VEVENT REQUEST/CANCEL) — both
  pure-JS, Workers-friendly. **tsdav** for CalDAV (confirmed to run on Workers; auto-uses native
  `fetch`; supports iCloud + Google). **Google Calendar** uses the **REST API directly via
  `fetch`** (the official `googleapis` SDK is Node-oriented and heavy for Workers) plus a small
  OAuth-refresh helper. Risk control: a Phase-0 spike confirms ical.js / ical-generator / tsdav
  all run under `workerd`; the `delivery`/`ical` wrappers keep any swap localized.

---

## Data Model (D1 / Drizzle)

Tenancy via `family_id` on every family-owned row. A single unified **family_member** table
replaces the old separate member/child tables: capabilities are independent boolean flags,
dependents (children) are flagged rather than a distinct type, and a member **without a
`user_id` simply cannot log in** (a child, or a caretaker who's tracked but doesn't use the app).

- **user** — `id, username, display_name, created_at`
  *(login accounts only. No email on the user — a user may not recall which email backs a given
  login; email lives on login identities and, separately, on email delivery targets)*
- **identity** — `id, user_id, provider(apple|magic_link), provider_ref, created_at`
  *(login methods; `provider_ref` = Apple subject, or the email used for magic-link login.
  This login email is intentionally distinct from any calendar-invite delivery address)*
- **family** — `id, name, created_at` *(tenant root)*
- **family_member** — `id, family_id, user_id?, relation_name, is_caretaker, is_admin,
  requires_caretaker, created_at`
  *(one row per person in the family. `user_id` null ⇒ cannot log in. `relation_name` is
  freeform — "mom", "dad", "child", "uncle". `is_caretaker` ⇒ can be assigned/own tasks;
  `is_admin` ⇒ can manage the family; flags independent (an extended-family helper is
  `is_caretaker=true, is_admin=false`). `requires_caretaker=true` ⇒ a dependent (a child) whose
  events need a caretaker — replaces the old `child` table)*
- **feed** *(input source)* — `id, family_id, kind(ics), url, refresh_minutes (configurable;
  sane default ~360), etag, last_synced_at, last_refresh_requested_at?, status,
  mode(explicit|exception)`
  *(`explicit` = feed events create tasks directly; `exception` = feed events are deviations
  from the baselines on its `family_member_feed` links)*
- **family_member_feed** — `id, family_id, feed_id, family_member_id, weekday_mask?, day_start?,
  day_end?, generates_types?, default_attendance?, active`
  *(the always-present association linking a feed to the dependent(s) it covers — one feed →
  many members (e.g. one school feed → two kids). For `exception` feeds it also carries that
  member's **baseline** (Mon–Fri 08:00→15:00 → a pickup+dropoff task per weekday), which may
  differ per child. For `explicit` feeds the baseline columns are unused. Folds in the old
  `baseline_schedule`)*
- **source_event** — `id, feed_id, family_id, ical_uid, recurrence_id, dtstart, dtend,
  summary, location, raw, content_hash, tasks_built_hash?`
  *(normalized occurrences after RRULE expansion. `tasks_built_hash` = the `content_hash` the
  tasks were last generated from; an event needs (re)processing iff `tasks_built_hash !=
  content_hash`, so we never rebuild unchanged events and always rebuild changed ones)*
- **classification_rule** — `id, family_id, feed_id?, priority, match_field(summary|location|...),
  match_op(contains|regex|equals), match_value, effect(create|cancel|shift|ignore),
  produces_types(pickup|dropoff|attendance...), default_attendance(specific|any|both),
  shift_to_time?, default_owner_member_id?`
  *(`feed_id` is optional on purpose: **null = family-global rule** applied to every feed (e.g.
  "anything containing 'Closed' cancels"), **set = scoped to one feed**. Feed-scoped rules win
  over global on ties via `priority`. `effect=create` for explicit feeds. For exception feeds:
  `cancel` = no-school suppresses that day's baseline; `shift` = early-dismissal moves baseline
  pickup to `shift_to_time`; `ignore` = informational ("picture day") explicitly does NOT
  affect the baseline. Unmatched events on an exception feed default to `ignore` — baseline
  still runs — so an unrecognized event never accidentally cancels school)*
- **task** *(unit of ownership)* — `id, family_id, source_event_id?, family_member_id, type,
  attendance_requirement, dtstart, dtend, location, status(unowned|owned), owner_member_id?,
  created_via(rule|baseline|manual)` *(`family_member_id` = the dependent the task is for;
  one event can yield multiple tasks)*
- **calendar_target** — `id, member_id, name, method(email|caldav|google), provider_hint
  (icloud|google|generic_caldav|...), address_or_url, credentials_ref?, external_calendar_id?,
  active`
  *(per caretaker output config. `method=email` → `address_or_url` IS the delivery email (invite
  addresses live here, not on `user`). `method=caldav` → `address_or_url` is the CalDAV
  collection URL, `credentials_ref` → encrypted app-specific password (iCloud) / user-pass.
  `method=google` → `credentials_ref` → encrypted OAuth refresh token, `external_calendar_id` →
  the chosen Google calendar. `provider_hint` drives the guided onboarding UX. v1 full-detail
  only; `detail_level` + travel-buffer columns arrive in v1.1)*
- **secret** — `id, family_id?, ciphertext, iv, wrapped_dek, key_version, created_at`
  *(envelope-encrypted credential store that `calendar_target.credentials_ref` points at — see
  "Secrets & credentials" below; raw credentials never sit in plaintext columns)*
- **delivery** — `id, task_id, calendar_target_id, method, status(pending|sent|updated|
  cancelled|failed), external_ref, ical_uid, sequence, rsvp_status(none|accepted|declined),
  sent_at`
  *(tracks the issued invite so updates bump `sequence` and cancellations send `METHOD:CANCEL`.
  A `declined` reply from the owning caretaker unassigns the task — see Core Flows)*
- **invite** — `id, type(new_family|join_family), family_id?, issued_by_member_id?, email?,
  token, grant_is_caretaker, grant_is_admin, status(pending|accepted|revoked|expired),
  expires_at, created_at`
  *(no public signup — account/family creation is invite-gated. `new_family` (operator-issued
  for the private beta) lets someone create a brand-new family; `join_family` adds them to an
  existing `family_id` with the granted flags)*
- **ownership_rule** *(fast-follow, modeled now)* — `id, family_id, filter, weekday_mask /
  RRULE, owner_member_id, active`

---

## Core Flows

1. **Ingest** — Cron fires on a short tick → for each `feed` due per its `refresh_minutes`,
   fetch ICS (ETag/conditional GET) → enqueue parse → `libs/ical` expands RRULEs within a
   rolling window → upsert `source_event` rows by `(ical_uid, recurrence_id)` + `content_hash`
   (detect changes/cancellations). A client can also **force an immediate refresh** of one feed
   or all family feeds (`POST /feeds/:id/refresh`, `POST /feeds/refresh-all`), which enqueues
   the same parse job out of band and reports status back.
2. **Classify** — only events needing work (`tasks_built_hash != content_hash`) are processed;
   after building tasks, set `tasks_built_hash = content_hash`. Branch on `feed.mode`:
   - **explicit**: run `classification_rule`s (`effect=create`, global + feed-scoped) by
     priority → generate `task`s (a rule may emit pickup + drop-off), one per associated
     `family_member` via `family_member_feed`. Unmatched events go to an "unclassified" bucket
     for manual tagging. Manual override always wins.
   - **exception/inverted**: for each `family_member_feed` carrying a baseline, expand that
     member's baseline over the window → candidate tasks per school day. Then apply matched
     exception rules per day: `cancel` removes that day's baseline tasks, `shift` adjusts the
     baseline pickup time, `ignore` (and any unmatched event) leaves the baseline intact — so
     "picture day" / "MCH Fundraiser" stay normal school days. Net result is the same `task`
     rows, derived baseline-minus-exceptions.
3. **Assign** — v1 is manual: caretaker claims an unowned task or swaps a single occurrence.
   Unowned dashboard = `tasks WHERE status='unowned'`. (Recurring `ownership_rule` auto-assign
   is the fast-follow.)
4. **Deliver** — owning a task enqueues a delivery job → `DeliveryProvider.upsert(task,
   target)` for each active `calendar_target` of the owner, dispatched by `method`:
   - **EmailImipProvider** (`method=email`) — renders a full-detail `VEVENT` (`METHOD:REQUEST`,
     `ORGANIZER`=service address, `ATTENDEE`=caretaker) as a raw MIME message and sends via
     **Cloudflare Email Service**. Updates bump `SEQUENCE`; unassigning sends `METHOD:CANCEL`.
   - **CalDavProvider** (`method=caldav`) — PUTs a full-detail event directly to an iCloud /
     generic-CalDAV calendar. Updates re-PUT the same UID; unassigning DELETEs it.
   - **GoogleCalendarProvider** (`method=google`) — creates/updates/deletes the event via the
     Google Calendar API using the caretaker's stored OAuth token.
   *(CalDAV/Google paths have no RSVP semantics — use an email target when accept/decline and
   the decline→unassign flow are wanted.)*
5. **RSVP** — caretaker accepts/declines in their calendar → reply email hits the Email Worker →
   parse `PARTSTAT` → update `delivery.rsvp_status`. **On `declined` by the owning caretaker**:
   clear `task.owner_member_id`, set `task.status='unowned'`, send `METHOD:CANCEL` for that
   task's other outstanding deliveries, and resurface the task in the unowned dashboard for
   reassignment (push/notify the family once notifications land).

---

## Scope: v1 / v1.1 / v2

**v1 — Family logistics planner (prototype for the user's family)**
- Apple + magic-link auth; one family; **unified `family_member` management** (caretakers +
  dependents, freeform `relation_name`, no-login members). The user's own family is seeded
  directly for the prototype; invite-gated onboarding lands in v1.1.
- Subscribe to school ICS feed(s); **configurable per-feed refresh interval (sane default
  ~6h)** plus **client-triggered force-refresh of one feed or all**; normalized occurrences.
- **Both feed modes**: `explicit` and `exception`/inverted (baseline schedule + cancel/shift/
  ignore exception rules; informational events never cancel school).
- Classification rules + manual override; task generation.
- Unowned dashboard; manual claim; one-off swap.
- **Three delivery providers, full-detail only**: `EmailImipProvider` (invites, send/update/
  cancel, inbound RSVP), `CalDavProvider` (iCloud + generic CalDAV), `GoogleCalendarProvider`
  (OAuth + Calendar API). A caretaker can target multiple calendars.
- **Guided per-provider calendar-connect flow** in the client (iCloud app-specific password,
  Google OAuth consent, generic CalDAV URL+credentials), incl. discovering/selecting the
  target calendar and verifying write access.
- **Flutter app for iOS and web** covering the above.

**v1.1 — Fast-follows (designed-for, not in the first cut)**
- Recurring **ownership rules** (Mon/Wed/Fri patterns) with auto-assign + conflict surfacing.
- **Block-only / privacy-stripped output**: `detail_level` + travel-buffer columns on
  `calendar_target`, stripped CalDAV writes, **fixed configurable buffer** first.
- **Per-caretaker ICS-feed** delivery provider (an alternative to CalDAV write).
- **Maps-based travel time** (replace the fixed buffer); home/origin model.
- **Push notifications** (APNs) via Durable Object fan-out.
- **Invite-gated onboarding for a private beta** (`invite` table): operator-issued
  **new-family** invites (create a brand-new family unit, no public signup) and **join-family**
  invites granting `is_caretaker`/`is_admin` (incl. inviting a non-admin extended-family
  caretaker).
- Multi-family UX polish (family switcher).

**v2 — Calendar "firewall" (separate feature, reuses v1 plumbing)**
- General 1-way / 2-way sync between arbitrary calendars exposing only obfuscated busy-blocks,
  not event details (personal ↔ work; a caretaker's work schedule shown to a spouse as opaque
  blocks so they can suggest lunch / book a kid's appointment around it).
- Reuses the v1 CalDAV/ICS delivery primitives and the v1.1 detail-stripping / travel-padding;
  adds a bidirectional sync engine, loop/echo prevention, and per-direction privacy policy.
- Not a family-scoped concept only — a "firewall link" is between two calendar endpoints owned
  by one or more users; data model for this is deferred to the v2 design.

---

## Build Phases

- **Phase 0 — Scaffold & platform**: Nx workspace for TS projects, `apps/api` (Hono on Workers),
  D1 + Drizzle migrations, `apps/mobile` plain Flutter shell (iOS + web), OpenAPI→Dart codegen;
  **Terraform skeleton (staging + prod envs)**; **KEK/secrets bootstrap**; **`workerd` spike
  confirming ical.js / ical-generator / tsdav run**; CI with **vitest-pool-workers** + a Flutter
  job.
- **Phase 1 — Identity & tenancy**: user / identity / family / **family_member** (unified
  caretaker+dependent model); Apple + magic-link; session middleware; tenant-guard query helpers
  (the security backbone).
- **Phase 2 — Feed ingest**: `feed` CRUD (incl. `mode` + configurable `refresh_minutes`);
  `family_member_feed` CRUD (associations + per-member baselines); Cron tick + Queue;
  **force-refresh endpoints** (`/feeds/:id/refresh`, `/feeds/refresh-all`); `libs/ical` (ical.js)
  parse + RRULE expansion; `source_event` upsert with `content_hash`/`tasks_built_hash` change
  detection.
- **Phase 3 — Classify & assign**: `classification_rule` CRUD + engine for **both** explicit
  (`create`) and exception (`cancel`/`shift`/`ignore` over baseline) modes, incl. global +
  feed-scoped rules; task generation per associated member; unowned dashboard; manual
  claim/swap APIs.
- **Phase 4 — Delivery & calendar connect**: `calendar_target` CRUD + **per-provider connect
  flows** (iCloud app-password, Google OAuth, generic CalDAV); `delivery` package with
  **`EmailImipProvider` (Cloudflare Email Service, raw MIME)**, **`CalDavProvider` (`libs/ical`
  CalDAV client)**, and **`GoogleCalendarProvider` (Calendar API)**; send/update/cancel
  (SEQUENCE for email, re-PUT/DELETE for CalDAV, insert/patch/delete for Google); Email Worker
  inbound RSVP + decline→unassign.
- **Phase 5 — Client (iOS + web)**: Flutter surfaces for feeds (+ force-refresh), rules,
  dashboard, claim/swap, calendar-connect onboarding, RSVP status; run on iOS simulator and in
  a browser.

---

## Deployment, IaC & CI/CD

**Split of responsibility (the recommended Cloudflare pattern):**
- **Terraform (official `cloudflare/cloudflare` provider)** owns durable **infra**: D1 databases,
  Queues, KV namespaces, R2 (fixtures/state), Email Routing rules + the Email Worker, Cron
  triggers, custom domains/DNS, Pages (web build) and Access policies, and the **KEK** secret.
  State in an **R2 backend** (or Terraform Cloud). This is also the user's Terraform-learning
  surface, and it's an appropriate use of Terraform for Cloudflare.
- **Wrangler** owns **Worker code**: `wrangler versions upload` / `deploy`, binding wiring from
  `wrangler.jsonc`, and **D1 migrations** (`wrangler d1 migrations apply`, which tracks state in
  a `d1_migrations` table). Wrangler is authoritative for code; Terraform for the resources it
  binds to. (Keep binding definitions consistent between `wrangler.jsonc` and Terraform.)

**Environments:** `staging` and `prod` as separate Cloudflare environments/resources, fully
parameterized in Terraform.

**Pipeline (GitHub Actions):**
1. **Lint + unit** (TS via Nx affected; Flutter `analyze`/`test`).
2. **Integration** in-runtime via **`@cloudflare/vitest-pool-workers`** — real D1/KV/Queue
   bindings under `workerd`, no live account needed; runs on every PR.
3. **Deploy to staging** — `terraform apply` (staging) + `wrangler d1 migrations apply` +
   `wrangler deploy`.
4. **E2E against staging** — black-box API tests (feed→tasks→delivery), plus the email/CalDAV/
   Google loops against test calendars. This is the **validation stage** that gates promotion.
5. **Promote to prod** — same steps against prod, using `wrangler versions` for gradual
   rollout; manual approval gate.

So yes — E2E is fully doable on Cloudflare: most of it runs locally-in-CI via vitest-pool-workers,
and the rest runs against a real **staging** deploy before prod promotion.

---

## Key Risks & Mitigations
- **Flutter/Nx coupling** → avoided entirely: Flutter runs via the `flutter` CLI, not Nx, so
  there is no plugin/version coupling and no Nx pin. Cost is a separate CI lane for Flutter
  (acceptable). Revisit a Dart workspace tool only if multiple Dart packages emerge.
- **Provider interop & credentials** → iCloud via CalDAV + app-specific password (primary,
  do first); Google via **Calendar API + OAuth** (not legacy CalDAV — cleaner and what we ship
  in v1); generic CalDAV later. Encrypt all secrets via `credentials_ref`; verify write/delete
  round-trips against real iCloud and Google calendars early. Google OAuth needs a verified
  consent screen + `calendar.events` scope; budget for the Google verification process.
- **Cloudflare Email Service (beta) + raw MIME** → confirm it accepts a hand-built
  `text/calendar; method=REQUEST` MIME message that real clients treat as an invite; keep the
  `delivery` abstraction so an alternate sender is a drop-in if the beta disappoints.
- **Exception/inverted feed correctness** → the failure mode is an unrecognized event canceling
  school. Mitigate: unmatched events default to `ignore` (baseline runs), only explicit
  `cancel`/`shift` rules alter the day; cover with fixture tests (no-school, early-dismissal,
  picture-day).
- **iMIP client fragmentation** (Apple/Google/Outlook render invites differently) → snapshot-
  test generated VEVENTs; test against real Apple + Google calendars early.
- **Tenancy leakage** → no raw cross-table queries; everything through `family_id`-scoped
  helpers; add tests that assert one family cannot read another's rows.
- **Recurring-event correctness** (RRULE, EXDATE, cancellations) → rolling expansion window +
  idempotent upsert keyed on `(ical_uid, recurrence_id, content_hash)`; `tasks_built_hash`
  prevents redundant rebuilds and guarantees changed events are reprocessed.
- **OSS lib Workers compat** → ical.js/ical-generator are pure-JS, tsdav is fetch-based and
  confirmed on Workers; a Phase-0 `workerd` spike de-risks it; thin wrappers localize any swap.
- **IaC config drift** → bindings duplicated between `wrangler.jsonc` and Terraform can diverge;
  Wrangler is authoritative for code, Terraform for resources; a CI check diffs the two.
- **Credential compromise** → envelope encryption, least-privilege (iCloud app-passwords /
  scoped Google OAuth), KEK rotation via `key_version`, secrets never logged or returned.

---

## Verification
- **Unit**: explicit classification (event → expected tasks); **exception resolver** fixtures —
  no-school cancels the day's baseline, early-dismissal shifts the pickup, "picture day"
  (and any unmatched event) leaves a normal school day; `libs/ical` VEVENT generation snapshots
  for REQUEST/CANCEL and the full-detail CalDAV PUT body.
- **Integration (in-runtime, CI)**: **`@cloudflare/vitest-pool-workers`** with real D1/KV/Queue
  bindings under `workerd`; seed the **real Children's House PDX `.ics`** (exception mode) plus a
  synthetic explicit feed; assert feed→(baseline±exceptions)→task→delivery and that
  `tasks_built_hash` gating skips unchanged events; assert tenant isolation across two families.
- **E2E (staging)**: black-box API run against a real staging deploy (the CI **validation
  stage** that gates prod promotion).
- **Email loop**: send a real iMIP invite to a test inbox; confirm it lands in **Apple Calendar
  and Google Calendar**; reply accept/decline → confirm Email Worker updates
  `delivery.rsvp_status`, and **decline returns the task to unowned**.
- **CalDAV loop**: connect a real iCloud calendar via app-specific password through the guided
  flow; write a **full-detail** event; confirm summary/location appear; update + delete.
- **Google loop**: run the OAuth connect flow; create/patch/delete a full-detail event on a
  real Google calendar via the Calendar API.
- **Force-refresh**: trigger `/feeds/:id/refresh` and `/feeds/refresh-all` from the client and
  confirm new feed changes appear out of band.
- **Client (iOS + web)**: Flutter widget tests + manual run on iOS simulator **and in a
  browser** against `wrangler dev`.
- **Manual prototype acceptance**: subscribe the real school feed (inverted mode), define the
  Mon–Fri baseline + a no-school/early-dismissal rule, see unowned tasks, claim one, confirm a
  full-detail invite/event hits the chosen calendar (iCloud or Google).
