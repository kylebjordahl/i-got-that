# tools

Build/codegen + dev-data utilities.

## Reset & seed (wipe-and-restart)

No data is precious pre-launch; these make a clean slate cheap:

- `reset-local.zsh` — wipe the local D1 (removes `apps/api/.wrangler`) and
  re-apply the migration baseline.
- `reset-staging.zsh` — DESTRUCTIVE staging wipe + baseline re-apply. Keep the
  drop list in `reset-staging.sql` in sync with `libs/db/src/schema.ts`.
  Never run against production.
- `seed-dev.zsh` — drive the live local API to build a demo family: exception
  school feed + baseline + override rules, synthesized events, claimable tasks
  (one pre-claimed so Plan shows the recursion), and pending decisions from
  unmatched feed events. Update it when API request shapes change.

## OpenAPI → Dart client (planned)

The TS API (`apps/api`) publishes an **OpenAPI spec generated from the Zod
schemas in `libs/domain`** (the single source of truth for the contract). The
Flutter client's typed API layer is generated from that spec into
`apps/mobile/lib/api/generated/` (git-ignored).

Intended pipeline (wired up in Phase 1 alongside the first real endpoints):

1. Emit `openapi.json` from `libs/domain` Zod schemas (e.g. `zod-to-openapi`).
2. Generate the Dart client (e.g. `openapi-generator-cli` with the `dart-dio`
   generator, matching the app's `dio` dependency).

Since TS and Dart can't share source, this codegen is the bridge.
