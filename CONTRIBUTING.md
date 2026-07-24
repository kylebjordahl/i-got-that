# Contributing

This repo is worked on by multiple parallel sessions/contributors, so **all work
goes through branches and pull requests** — `main` is protected by convention
(don't commit to it directly).

For dev setup, commands, and architecture, see **[AGENTS.md](AGENTS.md)**.

## Workflow

1. **Pick or open an issue.** Outstanding work is tracked as GitHub issues; check
   open issues before starting so two sessions don't collide.

2. **Branch off `main`**, named `<issue#>-short-slug`:
   ```bash
   git switch main && git pull
   git switch -c 39-apple-client
   ```

3. **Make the change.** Keep it focused on one issue. Match the surrounding
   style. Add/update tests for behaviour changes.

4. **Verify before pushing** (see AGENTS.md for the exact commands):
   - Backend: `pnpm nx run-many -t typecheck test --projects=tag:language:typescript`
   - Client: `cd apps/mobile && fvm flutter analyze && fvm flutter test`
   - If you changed `libs/db/src/schema.ts`, run `pnpm db:generate` and commit the
     new `libs/db/migrations/*`.

5. **Open a PR** against `main`, linking the issue so it auto-closes on merge:
   ```bash
   git push -u origin HEAD
   gh pr create --base main --fill --body "Closes #39"
   ```
   CI (`.github/workflows/ci.yml`) runs backend + Flutter checks on every PR.
   **If the change affects the UI** (mobile app screens/widgets or any
   user-facing web view), include screenshots of the updated UI in the PR
   description — before/after if it helps reviewers. The screenshots don't
   need to be committed to the repo; just paste/drag them into the PR
   description (GitHub hosts them).

6. **Merge** once CI is green and the PR is reviewed. Merging to `main`
   auto-deploys to **staging** (`.github/workflows/deploy-staging.yml`).
   Production deploys only when a GitHub **Release** is published.

## Conventions

- **Commits / PR titles use [Conventional Commits](https://www.conventionalcommits.org/)**:
  `type(scope): summary` — short imperative summary, scope optional (e.g.
  `feat(delivery): …`, `fix(auth): …`, `ci: …`, `chore(api): …`). This isn't just
  style: `deploy.yml`'s `testflight` job parses commit subjects since the last
  tag to pick the next staging version (`feat` → minor, `fix`/anything else →
  patch, `!` after the type/scope or a `BREAKING CHANGE` footer → major), so a
  merge commit that doesn't follow the convention just falls out of that
  detection (staging then falls back to the plain `git describe` form) rather
  than breaking the build — but use the convention anyway so the staging
  version stays meaningful. Explain the *why* in the body for non-trivial
  changes.
- **One concern per PR.** If you spot unrelated work, open an issue instead of
  expanding the PR.
- **Don't commit secrets.** Credentials are envelope-encrypted server-side;
  per-env secrets (KEK, OAuth secrets) are set via `wrangler secret put`. The
  committed KEK in `wrangler.jsonc` is dev-only.
- **Keep docs current**: update `docs/DEPLOYMENT.md` / `docs/AUTH.md` when deploy
  or auth behaviour changes.

## Parallel-session etiquette

- Comment on / assign yourself the issue you're working so others see it's taken.
- Rebase on `main` before opening the PR to minimize conflicts.
- Prefer small, frequently-merged PRs over long-lived branches.
