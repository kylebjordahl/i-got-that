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
source_events + link(baseline + link_rules)  → SYNTHESIS (schedule) → calendar_events + pending_decisions
target calendar → READ-BACK → calendar_events (provenance 'human')
calendar_events + member task_rules → TASK-GEN (typing) → tasks (transition = drop-off+pickup, or attendance; claim-only)
claim → a 'claimed_task' event on each CLAIMER's unified calendar (the recursion)
calendar_events (synthesized|claimed) → MIRROR → the member's one target calendar
```

**Two rule pipelines** (round-6 review split): `link_rules` are the feed's
SCHEDULE overrides (`cancel_day`/`modify_day`/`ignore` on the baseline day an
exception event covers, or `add_event` to put the feed event on the calendar
*beside* an untouched baseline day — a school's community dinner; plus `keep`,
which on a **routed** feed claims the event for that link's member);
`task_rules` are the per-member TYPING pipeline (`transition` vs `attendance`
+ drop-off/pickup windows, scoped `this_calendar`/`all_calendars`, with a
terminal default per calendar on the link + member). Task type is resolved at
task-gen time, keyed by the event's source calendar (`calendar_events.linkId`;
null ⇒ the member's own unified/direct calendar). A member's
`generatesFamilyTasks=false` pauses task generation (rules/defaults kept).

Every member (child or caretaker) can have a unified calendar: the DB
(`calendar_events`) is canonical; an optional per-member external target
(CalDAV/iCloud or Google, `member_calendars`) is a write-through mirror whose
human-authored events are read back in. Events the pipeline can't place become
**pending decisions** — the system never guesses. Two kinds: an unmatched
exception-feed event (`kind: 'exception'`), and an event on a routed shared
family calendar that no member's `keep` rules claimed (`kind: 'routing'`).

- Product spec: PRD 1 (unified calendars & task generation); `docs/original-plan.md` is the superseded original plan
- Deploy: `docs/DEPLOYMENT.md` · Auth: `docs/AUTH.md`

## Stack & layout

Nx monorepo (TypeScript) + a plain Flutter app (not Nx-managed).

```
apps/
  api/        Cloudflare Worker — Hono API, Cron, Queue consumer (+ static web assets in deployed envs)
  mobile/     Flutter app (iOS + Android + web), Riverpod + dio
libs/
  domain/     Zod schemas / shared types — the API contract source of truth
  db/         Drizzle schema + D1 migrations
  ical/       ical.js / ical-generator / tsdav wrappers
  classification/  pure engine: synthesis (override pipeline + baseline) + task generation
  delivery/   DeliveryProvider interface + CalDAV/Google providers + iMIP email (email outputs)
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
  `pubspec.yaml`'s floor is Dart 3.12 / Flutter 3.44 — that floor *is* the
  language version `dart format` reads, so it also selects the formatter's
  style. CI runs `dart format --set-exit-if-changed`, so an unformatted file
  fails the build; run `fvm dart format lib test` before committing.
- **`defaultTargetPlatform` is `TargetPlatform.android` under `flutter test`.**
  So a widget test gets the *Android* branch of any platform check unless it
  asks otherwise — which is the right way round now that Android is a target,
  but it does mean the iOS branch needs
  `variant: TargetPlatformVariant.only(TargetPlatform.iOS)` to be covered at
  all (`test/widget_test.dart`). Assigning `debugDefaultTargetPlatformOverride`
  and clearing it in `tearDown` does *not* work: the framework asserts
  foundation debug vars are unset at the end of the test body, before
  teardown runs.
- **Toasts must clear the floating nav pill — don't hand-roll a SnackBar's
  position.** `PersistentAppNav` floats *over* screen content (it's a sibling
  of the content Navigator in `_AuthedRoot`, not a `bottomNavigationBar`), so a
  floating SnackBar at Flutter's default inset lands behind it. This shipped
  broken repeatedly (#220, then the email-invites sheet) because each call site
  had to remember `margin: snackBarMarginAboveNav(context)`. Now
  `SnackBarsAboveNav` (in `widgets/app_bottom_nav.dart`) sets that as the
  theme's `insetPadding` for everything under the signed-in shell, so a plain
  `ScaffoldMessenger.of(context).showSnackBar(SnackBar(...))` is correct —
  including one raised from a root-navigator bottom sheet. So: never pass a
  smaller `margin:`, never mount another `Theme` or `MaterialApp` between
  `_AuthedRoot` and a screen that resets `snackBarTheme`, and keep
  `test/snackbar_above_nav_test.dart` passing. Pre-login screens (welcome,
  onboarding) have no nav and correctly use the default.
- **Android builds need the Android SDK, which a cloud agent session doesn't
  have** (`dl.google.com` is blocked by the egress proxy). `flutter create`,
  `analyze`, `test` and `dart format` all work there; `flutter build apk` does
  not. The `Android (compile)` job in `ci.yml` is the gate that actually
  compiles Gradle, the manifest merge and both flavors — treat a green CI run,
  not a local check, as proof an Android change builds.

## Commands

```bash
# Backend: typecheck + integration tests (all TS projects)
pnpm nx run-many -t typecheck test --projects=tag:language:typescript
# Just the API worker tests
node_modules/.bin/vitest run --root apps/api
# DB: generate a migration after editing libs/db/src/schema.ts
pnpm db:generate                 # then commit libs/db/migrations/*
# Flutter (always before committing client changes)
cd apps/mobile && fvm dart format lib test && fvm flutter analyze && fvm flutter test
# Android sanity check (needs the Android SDK; CI's `Android (compile)` job is
# the real gate — see apps/mobile/README.md)
cd apps/mobile && fvm flutter build apk --debug --flavor staging
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
- **A routed feed (`feeds.routed`) is the shared family calendar**: one input
  calendar carrying several members' events, split back out per member. It's the
  only mode whose engine pass runs across *all* of a feed's links at once
  (`synthesizeRouted` in `libs/classification`) — each link's `keep` rules filter
  the same occurrence set, so an event can land on several calendars and one no
  link keeps is unrouted. Routing is a property of the FEED, not of a link: flip
  it from any member's copy of the calendar and every linked member routes.
  Unrouted occurrences raise a `routing` pending decision **per link** (one
  question per member, sharing a `sourceEventId`); the client groups them into
  one card and `POST /pending-decisions/:id/resolve` answers the whole group —
  `routeToLinkIds` get the event, the rest are dismissed. With `rule` it also
  appends a `keep` rule to each chosen link (admin-only, and it must match the
  event it came from) instead of writing one-off `pd:` events. Standard/exception
  is still the mode; `routed` only applies to `standard` and is cleared if the
  mode moves off it.
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
- **The cron fans out one queue message per family; it never runs a pipeline
  itself.** A cron invocation gets a single CPU / subrequest budget (30 s CPU,
  10,000 subrequests — every D1 query counts) shared by every family, and past
  it the whole invocation dies mid-pipeline. So `scheduled()` does only the
  global sweeps (orphaned secrets, reauth alerts, digests) and `sendBatch`es a
  `family-pipeline` job per family (≤100 per call) onto `DELIVERY_QUEUE`; the
  consumer runs `runFamilyTick` (`services/pipeline.ts`: ingest → synthesis →
  read-back → conflicts → task-gen → claims → mirror → email) in an invocation with its own
  budget (`limits.cpu_ms` is raised in `wrangler.jsonc` for exactly this). A
  stage that throws is logged and the later ones still run; the message is
  acked, not retried (the next tick is the retry) — only a tick that couldn't
  start is `retry()`d. With no queue bound (local dev / tests) the cron runs
  each family inline under `waitUntil`, as it always did. `runFamilyTick` runs
  under the family's lease (below), so an overlapping tick or a queue
  redelivery skips instead of running the family twice.
- **A family's cron tick runs under a lease; every pipeline insert is
  idempotent.** Pipeline stages are snapshot-read → diff → write and overlap
  freely (cron, the route handlers' inline resynthesize → conflicts → task-gen,
  the queue consumer), so the *writes* must converge: `calendar_events` inserts
  upsert on `(familyMemberId, synthKey)`, `conflicts`/`task_owners`/
  `pending_decisions` inserts are `onConflictDoNothing`, and generated tasks are
  one-per-`(calendarEventId, type)` via the partial unique index
  `tasks_generated_event_type_uq` — give any new pipeline insert the same
  treatment. Only `runFamilyTick` takes the lease (`services/family-lease.ts`,
  ~14 min TTL, released only by the tick that took it) to skip a doubled-up
  tick; request paths stay unleased so a user's edit never waits on a
  background tick.
- **Every path that runs the pipeline is a thin call to `runPipeline`**
  (`services/pipeline.ts`): the cron tick, `resynthesizeFeed`, both refresh
  routes and the conflict / routing-decision routes. Its docblock holds the one
  canonical stage order and the "entry point → scope/options" table — add a stage
  there (isolated per feed / member, like the rest), never as another hand-rolled
  copy in a caller.
- **Recurring passes work over the *active horizon*, not a family's history.**
  Nothing prunes finished rows (`calendar_events`, `tasks`, `event_mirrors`,
  `source_events` only grow), yet the mirror, the travel-origin lookup, the
  claim true-up, task rebuilds and read-back's feed dedupe run on every family
  tick *and* every reconcile job — so each cuts off the PAST at
  `activeHorizon().start` (`services/synthesis.ts`: the synthesis window's start
  less 30 days; read-back uses its own window) via `endsAtOrAfter` /
  `overlapsWindow`. Only the past: everything from there forward is reconciled,
  however far ahead (a claim 45 days out mirrors at once; an event moved far
  ahead is updated, not left stale). A finished event's remote copy and claim
  are simply left as they were; only an event that no longer exists (or moved
  to another caretaker) is cancelled, whatever its age. A new recurring pass
  that reads "all of a member's events/tasks" is a cost that grows every day,
  so bound it the same way. There is deliberately no
  retention sweep yet. Specs whose fixtures use literal dates pin "now" with
  `pinClockTo` (`test/helpers.ts`) so they stay on the horizon.
- **Owned tasks are never deleted by reconciliation** (`services/task-gen.ts`):
  only unowned tasks are removed/swept, and user-converted (`createdVia:
  'manual'`) tasks are healed, never reclassified.
- **A task's owner is a SET, not a column** (`task_owners`, written only through
  `setTaskOwners` in `services/task-owners.ts`). An attendance task is regularly
  several people's — both parents at the recital — so `POST
  /tasks/:id/assign` takes `memberIds` and *replaces* the set, and
  `unassign` takes an optional `memberId` to step one caretaker off a task the
  others keep. A drop-off/pickup is one person's trip, so more than one owner on
  one is refused (`not_multi_assignable`). `tasks.status` is the set's summary
  (`owned` iff somebody is on it) and the API adds `ownerMemberIds` to every task
  it returns. The claim recursion follows: `syncClaimEvents` keeps **one
  `claimed_task` event per owner**, all sharing the `task:<taskId>` synthKey
  (unique per member), moving a row rather than recreating it when a
  single-owner task is reassigned — a recreated claim would cancel and re-add
  the remote VEVENT and lose its travel-time override. Assignment rules still
  own a task alone, and the rule stamp moved to the owner row
  (`task_owners.auto_assigned_rule_id`); any human ownership action clears every
  stamp in the set, on top of `manualOwnerOverride`.
- **Migration 0019 empties `tasks.owner_member_id` instead of dropping it**, and
  the column is gone from `libs/db/schema.ts` either way — treat it as not
  existing. SQLite refuses `DROP COLUMN` on a column named in a table `FOREIGN
  KEY` clause, and the table rebuild Drizzle generates for that is *not* safe on
  D1: its `PRAGMA foreign_keys=OFF` is a no-op inside the implicit transaction a
  migration runs in (and `defer_foreign_keys` defers violation checks, not
  actions), so `DROP TABLE tasks` would cascade every `claimed_task` calendar
  event — and its `travel_time_override_min` — out of the database. Any future
  migration that wants to rebuild a table with children has the same problem.
- **`tasksBuiltHash` is a *skip* stamp, so anything that removes an event's
  tasks behind task-gen's back has to clear it.** Task-gen's dirty query is
  `maskedAt IS NULL AND tasksBuiltHash != contentHash`, so an event whose
  content never changed is skipped forever. Conflict masking sweeps the loser's
  unowned tasks (its `cf:` segments carry them); un-masking therefore clears the
  stamp too (`services/conflicts.ts`) or the event returns to the calendar
  permanently bare. Two more ways an event ends up with nothing claimable are
  *by design* and stay that way: a dismissal is sticky (the row is kept and
  healed, never resurrected), and a `convert` freezes the type set. `POST
  /calendar-events/:id/tasks` is the operator escape hatch for all of them — it
  restores dismissed rows, clears the stamp, and re-runs the member's pipeline.
  It refuses the three cases where having no tasks is the *rule* (paused member,
  `fb:` busy block, `claimed_task`), which `/calendar-events` also reports per
  event as `taskIneligibleReason` so the client can say which it is.
- **A feed that can't be read must never go quiet.** Everything downstream of
  `source_events` keeps working off the rows already there, so a feed that has
  stopped ingesting looks *healthy* — the calendar is full, it just silently
  stops growing, and what you notice missing is whatever you added most
  recently. Four things keep that from happening, and all four are
  load-bearing: `ingestFeed` records every attempt on the row
  (`lastAttemptedAt`, `consecutiveFailures`, `lastErrorMessage`) so a stuck
  feed can say why; the cron polls **every** feed that `isFeedDue` says is due
  — an `error` feed on a growing backoff off `lastAttemptedAt`, since
  `lastSyncedAt` doesn't move on a failure — so a transient blip can't park a
  feed forever; and one feed's failure is caught per-feed in `runPipeline`
  (`services/pipeline.ts`) so it can't cost the family the
  read-back/task-gen/mirror passes that don't depend on it; and **synthesis does
  not wait on ingest** — it is what turns time into calendar days (the 30-day
  window, an exception feed's `bl:` baseline days, dated baseline-hour
  changes), so the tick's `synthesis` stage runs `synthesizeFeed` for every
  non-paused feed every tick, due or not, whether or not its ingest worked
  (an unchanged synthesis is reads only), and `POST .../feeds/:feedId/refresh`
  reports a failed ingest in its 200 response (`ingest.error`) instead of
  throwing past synthesis and task-gen. Without that a feed broken for days
  loses a day of horizon per day. Only `paused` (a user's decision) is ever
  skipped outright. The mirror image is a read that *succeeds* but is
  incomplete (an empty VCALENDAR from a publisher outage, a CalDAV 207 with no
  objects): `deleteStaleSourceEvents` holds any sweep that would remove all of a
  feed's in-window rows (of ≥3) or over half (of ≥10) until the third
  consecutive such fetch *and* six hours after the first (a Refresh-button
  cooldown is 60 s, so the count alone is no evidence of an outage), recording
  `suspicious fetch: …` in `lastErrorMessage` and counting
  `feeds.suspicious_sweep_count` / `suspicious_since` — via the reader's
  `feedPatch`, since `ingestFeed`'s success `UPDATE` would clear a separate
  write — and never sweeps rows of CalDAV objects that failed to parse.
- **A target calendar that can't be read or written must never go quiet
  either.** `member_calendars` carries the same durable bookkeeping per
  direction — `readBackAttemptedAt` / `readBackFailures` / `lastReadBackError`
  and `mirrorAttemptedAt` / `mirrorFailures` / `lastMirrorError` (attempt
  stamp on every try, failure count incremented in SQL and cleared by the next
  good pass, message capped like a feed's) — written by the `readBackMember` and
  `syncMemberMirror` wrappers, so no path (a throw, a missing credential, a
  wrong-kind credential) can fail without leaving a reason. A dead Google grant
  on a *target* account raises the same `externalAccounts.authFailedAt` reconnect
  prompt a failing feed does (`lib/account-health.ts` is the one helper both
  use), and a good read-back lowers it. The mirror also remembers per event
  (`event_mirrors.failureCount` / `lastError` / `failedPayloadHash`): content the
  target *rejects* (`DeliveryHttpError.rejectedPayload` — a 4xx about the
  payload, not auth, a missing resource, or load) `MIRROR_REJECTION_LIMIT`
  times in a row is held back until the payload changes instead of failing the
  whole member job on every tick forever. Only rejections count — a 5xx,
  network error or dead credential is the target's state, and counting it would
  freeze every unchanged event after a few bad ticks. A held event is not a
  `SyncResult` error (the queue would retry the job) but still counts as a
  failed pass on the member calendar, so it stays visible. A new event whose
  first write fails gets a `status: 'failed'` row with no `sentAt`/`externalRef`
  to hold the failure (both providers' cancel treats "not there" as success, so
  it cancels harmlessly if the event goes away). Read-back never prunes a human
  event it merely failed to *parse* (`failedUids`), and skips the prune
  entirely when an unparseable object had no readable UID.
- **Nothing on the outbound path may be served from cache.** A Worker's
  `fetch()` is not a bare socket — a cacheable GET comes from Cloudflare's
  cache, honouring the origin's `Cache-Control`, and that entry answers our
  conditional `If-None-Match` too. Calendar publishers routinely put hours of
  `max-age` on their `.ics`, which is enough for an event added last night to
  stay invisible all morning however many times someone presses "Refresh
  feeds". `createGuardedFetch` sends every hop `cache: 'no-store'` (which is
  why `cache_option_enabled` is in the compat flags), and a user-pressed
  refresh additionally passes `force` to `ingestFeed`, which drops
  `If-None-Match` and sends `Cache-Control: no-cache` so no intermediary can
  answer it either. The background poll still uses the stored ETag — being
  told "nothing changed" is exactly what it's for — but only while the last
  full parse's expansion still covers the synthesis window: `source_events`
  holds only the RRULE instances expanded inside that parse's window, so a
  publisher with a stable ETag would otherwise answer 304 until the series ran
  dry. `feeds.expanded_through` records the horizon, and `ingestIcsFeed` goes
  unconditional (no `If-None-Match`, but no `no-cache` either) once fewer than
  45 days of it remain. Account and busy feeds re-fetch their window every poll
  and don't use it.
- **D1 binds at most 100 parameters per statement, and the tests won't tell
  you.** The 101st comes back as `too many SQL variables: SQLITE_ERROR` — a
  500. Every `inArray(col, ids)` binds one per id, so any query that fans out
  over a list which grows with a family's *data* (its tasks, its events, its
  source events) eventually trips it: `GET /tasks` started 500ing on staging
  the day the family's 101st task appeared, because decorating the list with
  its owners was one `inArray` over every task id. Nothing catches this before
  a deploy — the API tests run on miniflare's local D1, plain SQLite with
  `SQLITE_MAX_VARIABLE_NUMBER` in the tens of thousands, so an over-cap query
  passes locally and in CI and fails only on the edge. Route such lists through
  `apps/api/src/lib/d1.ts` (`selectChunked` / `runChunked` / `chunkForD1`,
  whose `reserved` argument accounts for the parameters the rest of the
  statement binds — Drizzle binds comparison values too). Lists bounded by the
  size of a *family* (its members, a member's feeds, a task's owners) are fine
  unchunked. `test/d1-limits.spec.ts` puts the real cap back in front of the
  local database, which is the only way a regression here is catchable.
- **Pipeline stages send their writes as `db.batch()`, never as a loop of
  `await`ed single statements — and never rewrite a row that didn't change.**
  Every D1 call is a round trip *and* a subrequest (10,000 per queue-consumer
  invocation, shared by everything the tick does), and D1 bills rows written,
  so a per-row loop over a month of events costs that on every tick. Drizzle
  builders are lazy: build the statements without `await`, collect them, and
  send them with `batchChunked(db, statements)` (`lib/d1.ts`, 50 per batch;
  a batch is one call and one implicit transaction, all-or-nothing per chunk,
  and results come back in statement order — a `.returning()` in the list is
  read from them). Skip unchanged rows before writing (`contentHash` compare,
  as synthesis and read-back do) or in SQL (ingest's upsert is
  `ON CONFLICT … DO UPDATE … WHERE content_hash <> excluded.content_hash`).
  Reads that fan out over events are loaded once per chunk and looked up in a
  Map (task-gen's tasks and owners), not selected per event. `test/d1-counter.ts`
  wraps a D1 binding to count round trips / statements / rows written (and to
  enforce the 100-parameter cap); `test/batched-pipeline.spec.ts` pins the
  budget on a 2-feeds x 30-days family. `source_events.synthesized_hash` is
  deprecated and unwritten — don't build on it.
- **A feed event's DESCRIPTION is for matching, never for showing.** Rules can
  match on `description` / `any_text`, so ingest reads the VEVENT `DESCRIPTION`
  (Google `description`) into `source_events.description`, cut to
  `MAX_DESCRIPTION_CHARS` (2000, `@igt/ical`), and `hashOccurrence` covers it.
  It deliberately goes no further: `calendar_events.description` stays null for
  a feed event (`occurrenceEvent` in `libs/classification`), because that column
  feeds the mirror, claimed attendance events and email invites, and a feed body
  (often a newsletter) shouldn't land on a calendar or in an inbox without its
  own decision. Link rules see it through `toOccurrence`; task-gen looks it up
  by `sourceEventId` (one chunked read per event chunk) and hands it to the
  matcher only. Because `contentHash` is also task-gen's dirty stamp,
  `intentStatement` folds the source text into the hash (`hashCalendarEvent`'s
  `matchText`) so a description-only edit re-types the event's tasks even though
  nothing on the row changed. Read-back is the one place the column *is* filled
  (a human event's own description, so task rules can match it), and
  `claimPayload` therefore refuses to copy a `human` event's description onto
  an attendance claim. Don't add a new reader of `calendar_events.description`
  that sends it anywhere without deciding that on purpose.
- **The app-icon badge can only ever go *up* unless something takes it down.**
  APNs sets it from the payload and nothing expires it, so a digest's badge
  outlives the work it counted: claim the pickup and iOS still shows the 3.
  Two mechanisms answer that, and both are load-bearing. What the badge counts
  is `UserDigest.actionable`, not `total` — `my_tasks` is a *reminder* of work
  you've already taken on, so counting it would leave a badge that no amount of
  claiming can clear (claiming moves a task into that bucket). And the number is
  re-derivable at any time from `GET /notifications/badge`
  (`currentBadgeCount`, over the union of the user's enabled schedules'
  windows): the client rewrites the badge from it on foreground and after
  anything that could have emptied the queue (`lib/state/badge.dart`, wired to
  the providers every claim/decision/conflict path invalidates rather than to
  the call sites), and a scheduled digest that finds nothing outstanding sends a
  silent badge-only push rather than nothing at all. A new digest category has
  to decide which side of `actionable` it's on.
- **Email invite outputs are a second, filtered mirror — and every write is
  a mail a person reads.** `email_outputs` (several per member, one per
  address) send iMIP invites for the slice of the member's unified calendar
  their `filters` pick (`claimed_task` / `schedule` / `busy`, narrowed by task
  type and source link); `services/email-outputs.ts` reconciles them after the
  target mirror in the same queue job and cron tick. Three things keep it from
  becoming a spam cannon, and all are load-bearing: nothing goes to an address
  until someone opens the verification link mailed to it (GET only shows a
  confirm button — mail scanners prefetch links — and the POST verifies); a user
  may cause at most `EMAIL_VERIFICATION_DAILY_CAP` verification mails per
  rolling day (`email_verifications` has no FK to the output so deleting one
  doesn't refund it); and a reconcile only invites events that haven't ended
  and start within `EMAIL_INVITE_HORIZON_DAYS`, at most
  `EMAIL_INVITE_SENDS_PER_RUN` per output, nearest first. A finished event is
  forgotten, never cancelled. Every mail carries an unsubscribe link (plus one-click
  `List-Unsubscribe` headers) keyed to the address in `email_recipients`; an
  opted-out address gets nothing from any output — cancellations included —
  and can't be sent a new verification, so check `recipientFor` before any
  new kind of send. The whole path is skipped unless the `EMAIL`
  binding exists (`emailEnabled`): with a capture-only outbox the rows would
  record invites as sent that never left. Header values in `libs/delivery`'s
  MIME builder are sanitised there because subjects are feed-controlled.
- **"Email school" absence notices are computed server-side and sent by the
  phone.** A `resolved` conflict whose loser is a `bl:` baseline day, on a
  school link with at least one `absence_notice_settings` recipient, is
  *eligible* (`services/absence-notices.ts` is the one place that decides, times
  and wording included). Pending, dismissed or reopened conflicts are not — a
  moved event reopens its conflict, so the notice disappears until someone
  re-resolves it. The gap is winner start minus `travelBeforeMin` to winner end
  plus `travelAfterMin`, clamped to the school day and read in the school
  *feed's* timezone; a skipped half becomes "arriving at" / "leaving at …, not
  returning", both skipped "absent all day". One notice per child + link +
  school date, so two conflicts on a day are merged into one email. The server
  never sends: the app opens a `mailto:` and, when the app returns to the
  foreground, asks "Did you send it?" — only Yes calls `POST
  /calendar-events/:id/absence-notice/sent`, which stores `absence_notices`
  (who, when, and a `gapStamp` snapshot of the gaps). A current gap that differs
  from the stamp is `needs_update` and outstanding again, and the new body says
  it replaces the earlier one. The feature is **off for a link with no
  recipients** (no button, card or digest line). Settings are admin-only; any
  `isCaretaker` member may view, compose and mark sent. The digest category
  `absence_notices` counts toward `actionable`, so the badge includes it *for
  users whose schedule selects that category* (the badge only unions the
  categories of enabled schedules; migration 0026 added it to every existing
  schedule) and the client re-syncs the badge when `absenceNoticesProvider`
  settles. A notice that was sent and whose absence then disappears (appointment
  cancelled or moved off the day, or the conflict dismissed) resurfaces as
  `needs_update` on the `bl:` day — "will now attend the full day", quoting the
  earlier times — unless the conflict is pending again or the school day is
  gone. The default templates live only in `libs/domain` (settings GET returns
  them).
- **CalDAV** does a direct authenticated `PUT`/`DELETE` to the discovered
  collection URL (`libs/delivery/src/caldav.ts`), not tsdav's create-only helper.
- **Travel time is coordinate-driven, end to end.** `locationGeo` rides from the
  source event (its `GEO`/`X-APPLE-STRUCTURED-LOCATION`, parsed in `@igt/ical`)
  or the link's pinned place → `calendar_events` → `tasks` → the claimed event →
  the mirrored VEVENT, where a geocode emits `GEO` +
  `X-APPLE-STRUCTURED-LOCATION`. Apple needs *both* that structured location and
  `X-APPLE-TRAVEL-DURATION` before it draws a travel block —
  `X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC` alone only governs the "time to
  leave" alert. Drop `locationGeo` anywhere along that chain and travel time
  silently stops working, which is why every content hash on the path folds it
  in. The duration itself is derived in `mirror.ts` for every claimed event —
  drop-off, pickup and attendance alike, since all three are a trip the
  caretaker makes, while a synthesized event is the child's day and never
  gets one: it finds where the caretaker is coming *from* — the last thing on
  their own calendar (human read-back events included), or
  `family_members.home_location_geo` when the gap is long enough that they've
  plainly been elsewhere — and runs `estimateTravelMinutes` (pure, in
  `@igt/classification`: haversine × road factor ÷ a distance-dependent speed).
  There is no routing service server-side and no traffic; it's a seed of about
  the right size, which is all Apple needs to draw the block and then recompute
  the leave-by time itself. With no origin at all a transition falls back to the
  family's drop-off/pickup window; an attendance claim, whose span is the event
  rather than the journey, takes a flat 15-minute default. A human's own answer
  (`calendar_events.travel_time_override_min`, set from the event's detail
  sheet) beats all of that — `0` means no block, null hands it back to the
  estimate — and it lives outside `contentHash` on purpose, so healing an event
  never disturbs it. The same estimator seeds the conflict sheet's travel
  buffers (`suggestedTravelMin` on `GET /conflicts`, from the two events'
  geocodes).
- **Credentials** are envelope-encrypted (KEK → DEK) into the `secret` table and
  never returned by the API. Accounts are **user-owned** (reused across
  families); the OAuth client secret stays in `apps/api`; the Google provider
  gets an injected refresher, so `libs/delivery` never sees it.
- **Auth**: magic-link (returns a `devToken` only when the `ALLOW_DEV_TOKENS`
  binding is `'true'` — top-level `vars` only, so local dev + tests; never a
  deployed env, where it would be login-as-anyone), Sign in with
  Apple (server done; client wiring TODO), and member-claim invites
  (`/invites/:token/accept` links an existing user to a pre-created member).
- **Never show `users.displayName` to a person.** It's the part of the sign-up
  email before the @ — and for a Sign in with Apple account behind Hide My
  Email that's a random relay alias (`hp26rvm9sd`). The name people recognise
  is the family member's `relationName` (what the family calls them, set in
  the app); use that, as the email-output verification mail does.
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
- **UI changes need screenshots in the PR description** (see `CONTRIBUTING.md`)
  — not committed to the repo, just pasted into the description.
- Match the surrounding code's style/idioms; keep changes focused.
- Update `docs/` when you change deploy/auth/config behaviour.
- Outstanding work is tracked as GitHub issues — check open issues before starting.
- **Agents: open the PR and mark it ready for review yourselves.** Once the
  work is actually done — tests/typecheck pass and the change is verified —
  open the PR (draft is fine while work is in progress) and flip it out of
  draft (`gh pr ready <PR#>`) rather than leaving it sitting as a draft. Do
  this proactively; don't wait for the user to ask.
- **Sync with `main` before marking ready.** This repo requires branches to be
  up-to-date with `main` before merge, so an out-of-date branch blocks merging
  even once marked ready. Update the branch first — `gh pr update-branch
  <PR#>` (or `git fetch origin && git merge origin/main` and push) — then run
  `gh pr ready <PR#>`.
- **Never write a literal NUL byte (`\0`) into a source file** — e.g. as a
  string/template-literal separator. A NUL makes git treat the whole file as
  binary (no line diff, `Bin X -> Y bytes` in stat, "Cannot merge binary
  files" on the next conflicting merge). Use an ordinary separator character
  instead (this codebase's convention is `:`, as in `synthKey`s like
  `bl:<linkId>:<date>`). If a merge conflict ever reports a source file as
  binary, that's the smell to check for first — see PR #118 for a case where
  this had already landed on `main` and had to be cleaned up mid-merge.
