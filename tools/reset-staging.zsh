#!/usr/bin/env zsh
# DESTRUCTIVE reset of the STAGING D1 database (currently: the unified-calendar
# re-architecture, PRD 1). Wipes ALL data, then re-applies the fresh single
# baseline migration. There are no real customers, so this is intentionally not
# a safe/clean migration.
#
# NEVER run this against production.
#
# Usage (from the repo root):
#   tools/reset-staging.zsh
#   ENV=staging DB=DB tools/reset-staging.zsh   # override the wrangler env/binding
set -euo pipefail

ENV="${ENV:-staging}"
DB="${DB:-DB}"                       # the D1 *binding* in apps/api/wrangler.jsonc
DIR="${0:A:h}"                       # this script's directory (repo/tools)
API_DIR="${DIR:h}/apps/api"          # wrangler.jsonc lives here

print "⚠️  This DESTROYS all data in the '${ENV}' D1 database. Ctrl-C to abort."
print "→ dropping all tables (remote)…"
# Run the drops via --command, NOT --file: `wrangler d1 execute --remote --file`
# uploads through the D1 /import API, which fails with "Authentication error
# [code: 10000]" under a `wrangler login` OAuth token. --command uses the /query
# path (the same one `migrations apply` uses), which works.
#
# One statement per --command, not all of them joined into a single command:
# D1 sometimes reports "no such table: main.<t>: SQLITE_ERROR [code: 7500]"
# for a DROP TABLE that actually succeeded (confirmed against staging: the
# table was gone afterward despite the reported error — looks like stale
# post-drop bookkeeping on D1's side, not a real failure). Batching drops into
# one --command turned that false error into an aborted, rolled-back
# transaction; running them one at a time isolates the blast radius to a
# single (already-succeeded) statement, which we can then safely tolerate.
while IFS= read -r stmt; do
  [[ -z "$stmt" ]] && continue
  print "  $stmt"
  ret=0
  out="$( cd "$API_DIR" && npx wrangler d1 execute "$DB" --env "$ENV" --remote --yes --command "$stmt" 2>&1 )" || ret=$?
  print -- "$out"
  if (( ret != 0 )); then
    if [[ "$stmt" == "DROP TABLE IF EXISTS"* && "$out" == *"no such table"* ]]; then
      print "  ⚠️  reported error but table is confirmed dropped — continuing"
    else
      print "  ✘ failed"
      exit "$ret"
    fi
  fi
done < <(grep -vE '^[[:space:]]*(--|$)' "$DIR/reset-staging.sql")

print "→ re-applying the baseline migration…"
( cd "$API_DIR" && npx wrangler d1 migrations apply "$DB" --env "$ENV" --remote )

print "✓ ${ENV} D1 reset complete."
