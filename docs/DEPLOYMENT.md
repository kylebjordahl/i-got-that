# Deployment & CI/CD

This project deploys the **API Worker** (Cloudflare Workers + D1) through GitHub
Actions:

| Trigger | Workflow | Target |
| --- | --- | --- |
| Every push to `main` (after CI passes; docs-only skipped) | `.github/workflows/deploy-staging.yml` | **staging** |
| A GitHub **Release** is *published* | `.github/workflows/deploy-production.yml` | **production** |
| Push / PR | `.github/workflows/ci.yml` | tests only (no deploy) |

Both deploy workflows call the reusable `deploy.yml`, which builds the Flutter
web client, applies Terraform (durable infra), applies the D1 migrations, then
`wrangler deploy`s the Worker for that environment. The **test gate lives
upstream**, not in `deploy.yml`: staging only runs after the `CI` workflow
succeeds for the commit (`deploy-staging.yml` keys off `workflow_run` and deploys
that exact SHA), and production re-verifies that both `CI` **and** the staging
deploy went green for the release commit before deploying
(`deploy-production.yml`'s `verify` job).

Wrangler owns the Worker **code + bindings** (`apps/api/wrangler.jsonc`);
Terraform owns the **durable infra** (the D1 database today; Queues / Email
Routing / KV later). Keep binding names in sync between the two.

---

## One-time setup

### 1. Cloudflare account + API token

1. Create / sign in to a Cloudflare account. Copy your **Account ID** (Dashboard
   → Workers & Pages → right sidebar, or any zone's overview).
2. Create an **API token** (My Profile → API Tokens → Create Token → *Custom*)
   with these permissions on your account:
   - **Account · Workers Scripts · Edit** (deploy the Worker)
   - **Account · D1 · Edit** (create DBs + apply migrations)
   - **Account · Queues · Edit** (delivery queue + dead-letter queue)
   - **Account · Workers R2 Storage · Edit** (Terraform state bucket; see §4)
   - **Account · Email Routing · Edit** *(only once you wire inbound RSVP email)*
   - **Zone · DNS · Edit** + **Zone · Workers Routes · Edit** *(only if you put
     the API on a custom domain — see §6)*
   Scope it to your account (and the specific zone, if using a custom domain).

### 2. GitHub repository secrets

Repo → Settings → Secrets and variables → Actions → **New repository secret**:

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | the token from §1 |
| `CLOUDFLARE_ACCOUNT_ID` | your account ID |

### 3. GitHub Environments (protection + the prod gate)

Repo → Settings → **Environments** → create **`staging`** and **`production`**.
- On **`production`**, add yourself under **Required reviewers**. Publishing a
  release then pauses the prod deploy until you approve it in the Actions run.
- (Optional) restrict each environment's deployment branches to `main`.

### 4. Terraform state backend (R2)

Terraform state lives in an R2 bucket via the S3-compatible backend.

1. Create the bucket once: `wrangler r2 bucket create igt-tfstate`
   (or Dashboard → R2). You also need an **R2 access key** (R2 → Manage API
   Tokens) for Terraform's S3 backend auth — export them in the Actions env as
   `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (add as repo secrets and pass
   them through if you enable the backend).
2. Uncomment the `backend "s3"` block in `infra/terraform/versions.tf` and set
   `<ACCOUNT_ID>`.
3. Create `infra/terraform/backend.staging.hcl` and `backend.production.hcl`
   (git-ignored) with the per-env state key, e.g. staging:
   ```hcl
   key = "envs/staging/terraform.tfstate"
   ```
   and production:
   ```hcl
   key = "envs/production/terraform.tfstate"
   ```

> Starting out, you can skip R2 and use **local state** (omit the backend block
> and the `-backend-config` flag). Fine for a solo prototype; move to R2 before
> collaborators or multiple CI runners touch the same state.

### 5. Create the D1 databases and record their IDs

The Worker binds D1 **by id**, so each environment's `database_id` must be a real
value in `apps/api/wrangler.jsonc` (the id is **not** secret — commit it).

1. Copy `staging.tfvars.example` → `staging.tfvars` and
   `production.tfvars.example` → `production.tfvars` (both git-ignored), filling
   `cloudflare_account_id`. (`cloudflare_api_token` comes from the
   `TF_VAR_cloudflare_api_token` env in CI.)
2. Create the databases:
   ```bash
   cd infra/terraform
   export TF_VAR_cloudflare_api_token=<token>
   terraform init            # add -backend-config=backend.staging.hcl if using R2
   terraform apply -var-file=staging.tfvars
   terraform output d1_database_id      # → paste below
   # repeat with production.tfvars (use a separate state / workspace)
   ```
   (Or create them by hand: `wrangler d1 create igt-staging`.)
3. Paste each id into `apps/api/wrangler.jsonc`, replacing
   `REPLACE_WITH_TERRAFORM_OUTPUT` under `env.staging` and `env.production`.
   Commit.

### 6. The KEK and other Worker secrets

Credentials (CalDAV passwords, Google tokens) are envelope-encrypted with a
**KEK**. `wrangler.jsonc` ships a **dev-only** KEK in `vars`; production must use
a real secret that overrides it:

```bash
# 32 random bytes, base64 — generate locally, never commit:
openssl rand -base64 32

cd apps/api
echo "<that-value>" | pnpm wrangler secret put KEK --env staging
echo "<another>"    | pnpm wrangler secret put KEK --env production
```

A `wrangler secret` takes precedence over the `vars` KEK at runtime. Use a
**different** KEK per environment.

### 7. Single-subdomain layout (one Worker serves API + web + redirect)

Staging is configured to host everything on **one** subdomain
(`staging.igt.kylebjordahl.com`), served by the API Worker:

| Path | Serves |
| --- | --- |
| `/api/*` | the API (the Worker strips the `/api` prefix) |
| `/app/*` | the Flutter **web client** (static assets, with SPA deep-link fallback) |
| `/` (and anything else) | redirect → `/app/` |

This is wired in `apps/api/wrangler.jsonc` under `env.staging`:
- a **custom-domain route** (`staging.igt.kylebjordahl.com`), and
- an **`assets`** binding (`directory: ./public`, `binding: ASSETS`). CI runs
  `flutter build web --base-href /app/ --dart-define=API_BASE_URL=/api` and
  stages it into `apps/api/public/app/` before `wrangler deploy`, so the web
  client calls the API on the **same origin** at `/api`.

The routing is gated on the `ASSETS` binding, so local `wrangler dev` and the
tests (no binding) still serve the API directly at the root.

**Prerequisites:**
1. The parent zone (`kylebjordahl.com`, or a delegated `igt.kylebjordahl.com`)
   must be on **Cloudflare** — `custom_domain: true` provisions the
   `staging.igt.kylebjordahl.com` DNS record + TLS cert automatically.
2. The API token needs **Zone · DNS · Edit** + **Zone · Workers Routes · Edit**
   on that zone (in addition to the account scopes in §1).
3. **Native (iOS) clients** aren't same-origin — build them with
   `--dart-define=API_BASE_URL=https://staging.igt.kylebjordahl.com/api`.

> To put **production** on its own subdomain later, mirror the `routes` +
> `assets` blocks under `env.production` (e.g. `igt.kylebjordahl.com`). Until
> then prod has no `ASSETS` binding and serves the API at the root.

---

## Day-to-day flow

- **Staging**: merge to `main` → once `CI` passes, `Deploy staging` runs
  automatically (build web → Terraform → migrate → deploy).
- **Production**: when staging looks good, cut a release:
  ```bash
  git tag v0.2.0 && git push origin v0.2.0
  ```
  then **Releases → Draft a new release → choose the tag → Publish**. That fires
  `Deploy production`, which waits for your approval (if you set required
  reviewers) before deploying.
- **Rollback**: re-run a previous successful `Deploy production` run, or
  `cd apps/api && pnpm wrangler rollback --env production`.

## Verifying a deploy

```bash
curl https://staging.igt.kylebjordahl.com/api/health   # → { ok: true, ... }
curl -sI https://staging.igt.kylebjordahl.com/         # → 302 to /app/
open https://staging.igt.kylebjordahl.com/app/         # the web client
cd apps/api && pnpm wrangler tail --env staging        # live logs
```

## Notes / gotchas

- **Migrations** are applied by `wrangler d1 migrations apply` against the
  `d1_migrations` table — additive and idempotent. Generate new ones with
  `pnpm db:generate` (Drizzle) and commit `libs/db/migrations/*`.
- **Email is disconnected** (`send_email` commented in `wrangler.jsonc`). Until a
  paid plan + verified sending domain are set up, magic-link login can't email in
  a deployed env — use **Sign in with Apple** or the **invite link** flow for
  onboarding. See `infra/terraform/main.tf` for the sending-domain DNS notes.
- The **web client** is built in CI and served by the same Worker under `/app`
  (see §7) — no separate Pages project. Production gets it once you add the
  `routes` + `assets` blocks under `env.production`.
- **Docs-only pushes skip deploy**: a push to `main` touching only `**/*.md`,
  `docs/**`, or `LICENSE` doesn't run `CI`, so the CI-gated staging deploy
  doesn't fire — a docs edit won't redeploy the Worker. PRs still run full CI.
  One consequence: don't cut a **release** off a docs-only commit — the
  production `verify` job requires a successful `CI` run for the tagged SHA and
  will (safely) refuse it. Tag a commit that went through CI.
- **Build caching**: CI and deploy share `.github/actions/pnpm-install`, which
  caches the pnpm store (keyed on `pnpm-lock.yaml`); the Flutter SDK is cached
  via `subosito/flutter-action`. The deploy additionally caches the built web
  client, keyed on the `apps/mobile` sources — a backend/infra-only deploy
  restores the last bundle instead of rebuilding Flutter. Changing anything
  under `apps/mobile` busts that cache and forces a rebuild.
