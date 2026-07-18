# Free/busy work-calendar feeds (the calendar-firewall input)

The first shipped slice of the **calendar "firewall"** feature anticipated in
[original-plan.md](original-plan.md) (§Context feature 2, and the v1.1
"block-only" fast-follows): a family member's **work Google Calendar**
availability appears on their unified calendar as opaque **"Busy" blocks**,
without any company event details ever reaching the platform.

## Mechanism & trust boundaries

```
┌─ Company Google Workspace ────────────────┐
│  work calendar (full detail)              │
│      │ share: "See only free/busy         │
│      │  (hide details)" → personal acct   │
└──────┼────────────────────────────────────┘
       │  Google-enforced ACL boundary: freeBusyReader
       ▼
personal Google account ── OAuth (calendar.freebusy scope) ──► platform Worker
       │                                                          │
       │  freebusy.query → busy intervals ONLY                    ▼
       │  (no titles, attendees, locations — stripped BY GOOGLE)  D1: source_events
       └──────────────────────────────────────────────────────────┘  → calendar_events ("Busy")
```

The load-bearing property: **detail-stripping is enforced by Google's ACL, not
by our code.** The platform authenticates as the member's *personal* account,
which holds only `freeBusyReader` access to the work calendar. Google's
`freebusy.query` endpoint returns start/end intervals and nothing else for such
calendars — there is no code path on our side that could leak details, because
the details never cross the Workspace boundary. No code is deployed inside the
company's Workspace, and the platform never holds a corporate credential.

**What the company exposes:** busy intervals (start/end pairs) for one
calendar, to one named external account, visible and revocable in standard
Google sharing controls that the Workspace admin can audit. The default
Workspace external-sharing policy ("Only free/busy information") permits
exactly this and nothing more.

**What the platform stores:** the intervals (`source_events` rows keyed
`fb:<start>/<end>`, all text fields null) and a user-chosen label for the
blocks (e.g. "Busy (work)", stored as the feed's `sourceCalendarName`). Nothing
else exists to store.

**Kill switch:** unshare the calendar at work (or have the admin do it). The
next sync's `freebusy.query` fails per-calendar (`notFound` — Google
deliberately doesn't distinguish "unshared" from "nonexistent"), the feed flips
to `status: 'error'`, and no further reads occur. Deleting the feed removes all
stored intervals (FK cascades), and the next mirror reconcile cancels any
mirrored copies.

## Setup (per member)

1. **At work** (once): work calendar → Settings and sharing → *Share with
   specific people* → add your personal Gmail address with permission **"See
   only free/busy (hide details)"**. If this is blocked, your Workspace's
   external-sharing policy is stricter than Google's default — see
   [Fallback](#fallback-if-external-sharing-is-fully-blocked).
2. **In the app**: connect your personal Google account (accounts connected
   before the freebusy scope was added must be **reconnected once** — the old
   refresh token lacks `calendar.freebusy`), then add a calendar with mode
   **busy**, entering your **work email address** as the calendar id. The work
   calendar never appears in your personal account's calendar list, so it is
   typed, not picked. Creation probes `freebusy.query` immediately and fails
   with `freebusy_unavailable` + the Google reason if the share isn't in place,
   so a mis-setup surfaces at creation, not at the first sync.

## How it flows through the pipeline

Busy feeds are ordinary input feeds (`kind: 'google'`, `mode: 'busy'`) and ride
the existing cron/refresh machinery. The differences, end to end:

- **Read** — `fetchGoogleFreeBusy` (libs/ical) POSTs `freebusy.query` over a
  ~35-day window (synthesis consumes 30) instead of `events.list`.
- **Ingest** (`apps/api/src/services/ingest.ts`) — intervals upsert into
  `source_events` with `icalUid = 'fb:<startISO>/<endISO>'`. Free/busy carries
  no event identity, so the interval *is* the identity — and therefore ingest
  also **delete-reconciles** the fetched window: any row whose key isn't in
  the fresh set is stale (a moved/merged/split block) and is removed, which
  cascades its synthesized event. Other feed kinds are upsert-only; busy feeds
  cannot be, or every moved meeting would leave a ghost block.
- **Synthesis** — `synthesizeBusy` (libs/classification) emits detail-free
  intents keyed `fb:<linkId>:<sourceEventId>`, labeled with the feed's name
  (`'Busy'` fallback), location/description always null. No override rules, no
  pending decisions.
- **Task-gen** — `fb:` events are explicitly skipped: availability is not
  family logistics, so busy blocks never spawn claimable tasks, even for
  members with `generatesFamilyTasks` on.
- **Mirror** — busy blocks are `provenance: 'synthesized'` like any other
  generated event, so they mirror to the member's target calendar (the point:
  a spouse sees the opaque block). Mirrored copies use `igt-` UIDs, which
  read-back skips, so there is no echo loop.
- **Immutability** — a feed cannot change mode into or out of `busy`
  (`busy_mode_immutable`): the interval-derived keyspace is incompatible with
  the UID-keyed pipelines. Recreate the feed instead.

## Alternatives considered (and why not)

- **Secret iCal address**: Google's per-calendar secret ICS URL is full-detail
  — every title/attendee/location would leave the Workspace and reach our
  servers, relying on *our* code to strip after the fact. It is also disabled
  by default in Workspace and commonly kept that way. Weakest privacy posture;
  rejected.
- **Workspace add-on / Apps Script web app**: a small script inside the
  Workspace serving a token-protected busy-only ICS. Auditable (short script,
  execution logs) and it works even when external sharing is fully blocked —
  but the stripping is enforced by script code running under a broad
  `calendar.readonly` grant, not by Google, and the token lives in a URL.
  Strictly weaker guarantees than the ACL approach; kept as the fallback.

### Fallback if external sharing is fully blocked

Some Workspaces prohibit even free/busy sharing to external addresses. The
documented fallback is the Apps Script web app above: deployed *by the
employee* (or IT) inside the Workspace, code-reviewed by the admin, emitting
only busy intervals as ICS behind a high-entropy token, consumed by the
platform as a plain `ics` feed in `busy`-like fashion. Not implemented; design
notes live here so the trade-off (our-code-enforced stripping vs.
Google-enforced) is on record.

## Future extensions

- **VFREEBUSY / tokened ICS export** — the outbound half of the firewall: the
  platform *serving* a member's availability as a secret-URL feed (v1.1
  "per-caretaker ICS-feed delivery provider"; token-hash pattern already
  established by `invites.token` / `authTokens`).
- **`detail_level` + travel buffers** on mirror targets (v1.1) — stripped
  *output*, the mirror-side sibling of this feature.
- **General bidirectional busy-block sync** with per-direction privacy policy
  (v2) — this feature's ingest/synthesis path is the one-way foundation.
- **An `availability`/`transparency` column** on `calendar_events`, deferred
  until something consumes it; today the `fb:` synthKey prefix identifies busy
  blocks.
