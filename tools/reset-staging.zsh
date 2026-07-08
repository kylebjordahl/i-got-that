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
# path (the same one `migrations apply` uses), which works. Strip SQL comments +
# blank lines so they don't swallow the now-single-line command, keeping
# reset-staging.sql as the readable source of truth for the drop list.
DROP_SQL="$(grep -vE '^[[:space:]]*(--|$)' "$DIR/reset-staging.sql" | tr '\n' ' ')"
( cd "$API_DIR" && npx wrangler d1 execute "$DB" --env "$ENV" --remote --yes --command "$DROP_SQL" )

print "→ re-applying the baseline migration…"
( cd "$API_DIR" && npx wrangler d1 migrations apply "$DB" --env "$ENV" --remote )

print "✓ ${ENV} D1 reset complete."
