#!/usr/bin/env zsh
# Seed a local dev family exercising the unified-calendar pipeline end to end:
# an exception school feed with a baseline + override pipeline (cancel / modify
# / annotate), synthesized events, generated tasks, one claimed task (so the
# recursion shows on Plan), and — courtesy of unmatched feed events — pending
# decisions on Home. Requires: jq, a running `wrangler dev` (nx run
# @igt/api:dev) with the local D1 migrated (tools/reset-local.zsh).
#
# Usage:
#   tools/seed-dev.zsh
#   BASE=http://localhost:8787 EMAIL=you@test.dev tools/seed-dev.zsh
set -euo pipefail

BASE="${BASE:-http://localhost:8787}"
EMAIL="${EMAIL:-you@test.dev}"
FEED_URL="${FEED_URL:-https://calendar.google.com/calendar/ical/childrenshousepdx.com_n3jg0ga7tlc5gs8mkg4rvvua20%40group.calendar.google.com/public/basic.ics}"
CT='content-type: application/json'

command -v jq >/dev/null || { print -u2 "error: jq is required"; exit 1; }

print "→ requesting magic link for $EMAIL"
dev_token=$(curl -fsS "$BASE/auth/magic-link/request" -H "$CT" \
  -d "{\"email\":\"$EMAIL\"}" | jq -r '.devToken // empty')
[[ -n "$dev_token" ]] || { print -u2 "error: no devToken (is ENVIRONMENT=production, or API down?)"; exit 1; }

token=$(curl -fsS "$BASE/auth/magic-link/verify" -H "$CT" \
  -d "{\"token\":\"$dev_token\"}" | jq -r '.sessionToken')
auth="Authorization: Bearer $token"

# Reuse the first family the user belongs to, else create one.
fam=$(curl -fsS "$BASE/me" -H "$auth" | jq -r '.families[0].family.id // empty')
if [[ -z "$fam" ]]; then
  fam=$(curl -fsS "$BASE/families" -H "$auth" -H "$CT" \
    -d '{"name":"My Family"}' | jq -r '.family.id')
  print "→ created family $fam"
else
  print "→ using existing family $fam"
fi

child=$(curl -fsS "$BASE/families/$fam/members" -H "$auth" -H "$CT" \
  -d '{"relationName":"Theo","requiresCaretaker":true}' | jq -r '.member.id')
print "→ child member $child"

partner=$(curl -fsS "$BASE/families/$fam/members" -H "$auth" -H "$CT" \
  -d '{"relationName":"Partner","isCaretaker":true}' | jq -r '.member.id')
print "→ second caretaker $partner"

feed=$(curl -fsS "$BASE/families/$fam/feeds" -H "$auth" -H "$CT" \
  -d "{\"url\":\"$FEED_URL\",\"mode\":\"exception\"}" | jq -r '.feed.id')
print "→ exception feed $feed"

link=$(curl -fsS "$BASE/families/$fam/feeds/$feed/member-links" -H "$auth" -H "$CT" -d "$(jq -nc \
  --arg m "$child" \
  '{familyMemberId:$m, weekdayMask:31, dayStart:"08:30", dayEnd:"14:45",
    location:"School", generatesTypes:["dropoff","pickup"], defaultAttendance:"any"}')" \
  | jq -r '.link.id')
print "→ baseline link $link (Mon–Fri 08:30→14:45, dropoff+pickup)"

rules="$BASE/families/$fam/feeds/$feed/member-links/$link/rules"
curl -fsS "$rules" -H "$auth" -H "$CT" -d "$(jq -nc \
  '{matchField:"summary", matchOp:"regex", matchValue:"/no school|closed/i", outcome:"cancel_day"}')" >/dev/null
print "→ rule 0: /no school|closed/i → cancel day"
curl -fsS "$rules" -H "$auth" -H "$CT" -d "$(jq -nc \
  '{matchField:"summary", matchOp:"contains", matchValue:"Early", outcome:"modify_day", params:{dayEnd:"12:00"}}')" >/dev/null
print "→ rule 1: contains 'Early' → modify day (ends 12:00)"
curl -fsS "$rules" -H "$auth" -H "$CT" -d "$(jq -nc \
  '{matchField:"summary", matchOp:"contains", matchValue:"Photo", outcome:"annotate", params:{text:"Photo Day"}}')" >/dev/null
print "→ rule 2: contains 'Photo' → annotate"

print "→ refreshing feeds (ingest → synthesize → generate tasks)…"
curl -fsS "$BASE/families/$fam/feeds/refresh-all" -H "$auth" -H "$CT" -d '{}' | jq -c '.synthesis'

# Claim the first unowned task so Plan shows the recursion (a claimed task is
# an event on the claimer's unified calendar).
first_task=$(curl -fsS "$BASE/families/$fam/tasks?status=unowned" -H "$auth" | jq -r '.tasks[0].id // empty')
if [[ -n "$first_task" ]]; then
  curl -fsS "$BASE/families/$fam/tasks/$first_task/assign" -H "$auth" -H "$CT" -d '{}' >/dev/null
  print "→ claimed task $first_task for $EMAIL"
fi

unowned=$(curl -fsS "$BASE/families/$fam/tasks?status=unowned" -H "$auth" | jq '.tasks | length')
events=$(curl -fsS "$BASE/families/$fam/calendar-events" -H "$auth" | jq '.events | length')
pending=$(curl -fsS "$BASE/families/$fam/pending-decisions" -H "$auth" | jq '.decisions | length')
print "✓ done — $events calendar event(s), $unowned unowned task(s), $pending pending decision(s)."
print "  Open the app: Home shows decisions + claimable tasks; Plan shows the calendars."
