#!/usr/bin/env zsh
# DESTRUCTIVE local reset: wipe the local D1 (miniflare sqlite under
# apps/api/.wrangler) and re-apply the migration baseline. Use after a schema
# squash, or whenever you want a clean slate; follow with tools/seed-dev.zsh.
#
# Usage:  tools/reset-local.zsh
set -euo pipefail

repo_root="${0:a:h:h}"
cd "$repo_root"

print "→ removing local wrangler state (apps/api/.wrangler)"
rm -rf apps/api/.wrangler

print "→ applying migrations to a fresh local D1"
pnpm nx run @igt/api:db-migrate-local

print "✓ local database reset. Start the API (nx run @igt/api:dev) and run tools/seed-dev.zsh."
