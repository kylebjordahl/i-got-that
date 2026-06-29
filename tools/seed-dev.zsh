#!/usr/bin/env zsh
# Seed a local dev family with the real school feed so the client dashboard has
# tasks to claim. Requires: jq, a running `wrangler dev` (nx run @igt/api:dev)
# with the local D1 migrated (nx run @igt/api:db-migrate-local).
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
  -d '{"relationName":"child","requiresCaretaker":true}' | jq -r '.member.id')
print "→ child member $child"

feed=$(curl -fsS "$BASE/families/$fam/feeds" -H "$auth" -H "$CT" \
  -d "{\"url\":\"$FEED_URL\",\"mode\":\"exception\"}" | jq -r '.feed.id')
print "→ exception feed $feed"

curl -fsS "$BASE/families/$fam/feeds/$feed/member-links" -H "$auth" -H "$CT" -d "$(jq -nc \
  --arg m "$child" \
  '{familyMemberId:$m, weekdayMask:31, dayStart:"08:00", dayEnd:"15:00", generatesTypes:["dropoff","pickup"], defaultAttendance:"any"}')" >/dev/null
print "→ baseline link (Mon–Fri 08:00→15:00, dropoff+pickup)"

curl -fsS "$BASE/families/$fam/classification-rules" -H "$auth" -H "$CT" -d "$(jq -nc \
  --arg f "$feed" \
  '{feedId:$f, priority:10, matchField:"summary", matchOp:"contains", matchValue:"Closed", effect:"cancel"}')" >/dev/null
print "→ rule: summary contains 'Closed' → cancel the day"

print "→ refreshing feed (ingest + build tasks)…"
curl -fsS "$BASE/families/$fam/feeds/refresh-all" -H "$auth" -H "$CT" -d '{}' | jq '.build'

unowned=$(curl -fsS "$BASE/families/$fam/tasks?status=unowned" -H "$auth" | jq '.tasks | length')
print "✓ done — $unowned unowned task(s). Refresh the app to see them."
