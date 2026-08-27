provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

locals {
  suffix = var.environment == "production" ? "prod" : "staging"
}

# Durable infra owned by Terraform. Worker CODE + bindings are deployed by
# Wrangler (apps/api); keep binding names in sync with apps/api/wrangler.jsonc.
#
# Phase 0 provisions the D1 database. Queues, KV (sessions), R2, Email Routing
# + the inbound Email Worker, and the KEK secret are added as later phases need
# them (resource schemas should be checked against the pinned provider version
# before `terraform apply`).

resource "cloudflare_d1_database" "primary" {
  account_id = var.cloudflare_account_id
  name       = "${var.name_prefix}-${local.suffix}"
  read_replication = {
    mode = "disabled"
  }
}

# --- Delivery queue (durable, retry-backed calendar reconcile) -----------
#
# The Worker enqueues reconcile jobs (binding DELIVERY_QUEUE) and consumes them
# with built-in retries/backoff; exhausted messages land in the dead-letter
# queue. The binding + consumer config live in apps/api/wrangler.jsonc — keep
# the queue names in sync (igt-delivery-<env> / -dlq). Confirm the resource
# schema against the pinned cloudflare provider version before apply.

resource "cloudflare_queue" "delivery" {
  account_id = var.cloudflare_account_id
  queue_name = "${var.name_prefix}-delivery-${local.suffix}"
}

resource "cloudflare_queue" "delivery_dlq" {
  account_id = var.cloudflare_account_id
  queue_name = "${var.name_prefix}-delivery-${local.suffix}-dlq"
}

# --- Outbound email (Cloudflare Email Service) ---------------------------
#
# The Worker sends iMIP invites via the `send_email` binding (apps/api ->
# wrangler.jsonc, binding name EMAIL). For that to deliver to arbitrary
# recipients you need a VERIFIED SENDING DOMAIN on the account:
#
#   1. Add/verify the sending domain in Email Service (Dashboard → Email, or the
#      REST API). Cloudflare issues SPF / DKIM / DMARC records.
#   2. If the domain's DNS is on Cloudflare, publish those records here, e.g.:
#
#      resource "cloudflare_dns_record" "email_dkim" {
#        zone_id = var.cloudflare_zone_id
#        name    = "cf2024-1._domainkey"
#        type    = "CNAME"
#        content = "cf2024-1._domainkey.<your-domain>.cloudflareemail.com"
#        proxied = false
#        ttl     = 1
#      }
#      # ...plus the SPF (TXT) and DMARC (TXT) records Cloudflare provides.
#
#   3. Set ORGANIZER_EMAIL (wrangler var) to an address on that domain.
#
# NOTE: Email Service is in public beta; confirm the exact provider resource for
# registering the sending domain against your pinned cloudflare provider version
# (it may still need a one-time Dashboard/API step). The DNS records above are
# standard `cloudflare_dns_record` resources.

# --- Edge rate limiting (issue #142) --------------------------------------
#
# App-layer per-identity limiting, refresh cooldowns, and magic-link issuance
# caps already live in the Worker (apps/api/src/routes/auth.ts's
# MagicLinkCapExceededError, apps/api/src/routes/feeds.ts's 60s manual-refresh
# cooldown); this adds a cheap edge-layer backstop that rejects abusive
# traffic by source IP before it ever reaches the Worker. Zone-scoped (unlike
# the account-scoped resources above) — needs a Zone · Zone WAF · Edit
# permission on the API token in addition to the account scopes in
# docs/DEPLOYMENT.md §1. Confirm the resource schema against the pinned
# provider version before apply.
#
# Only ONE rule, covering ONLY auth — not one per endpoint group, and not
# both combined. This zone's plan is more restrictive than the "1 rule"
# ceiling the earlier comment (and Cloudflare's own error text) suggested:
#
# - The http_ratelimit phase really does cap at 1 rule zone-wide (confirmed:
#   the phase has no entrypoint ruleset at all — GET
#   /zones/:id/rulesets/phases/http_ratelimit/entrypoint 404s — and the
#   zone's/account's full ruleset listings are empty for this phase, so
#   nothing pre-existing was ever competing for that slot).
# - But an `or`-combined expression spanning two unrelated match conditions
#   (the original auth-or-feed-refresh rule) still gets rejected with that
#   same "2 out of 1" error even as a single JSON rules[] entry — verified by
#   testing directly against the Rulesets API: a rule with only the auth
#   condition (no `or`) passed the count check outright, where the
#   OR'd version never did. Cloudflare's rate-limit counting apparently needs
#   a separate counter per distinct match branch, and this plan's "1 rule"
#   entitlement is really "1 counter" — so the two endpoint groups can't
#   share one rule via `or` any more than they could as two separate rules.
# - `period` and `mitigation_timeout` are further pinned to exactly 10
#   (seconds) on this plan — confirmed via the same direct-API test, which
#   400'd on period=60 ("not entitled to use the period 60, can only use a
#   period among [10]") and succeeded once both were set to 10.
#
# That leaves room for exactly one simple rule, so auth gets it (the more
# exposure-prone target for an IP-based backstop: credential-stuffing/
# enumeration spread across many different accounts from one IP isn't
# something apps/api/src/routes/auth.ts's per-identity MagicLinkCapExceededError
# alone catches). Feed-refresh relies entirely on
# apps/api/src/routes/feeds.ts's 60s manual-refresh cooldown — already an
# IP-agnostic, per-feed limit tighter than anything the edge could add here.
# requests_per_period is scaled down from the original 5/60s intent to the
# nearest whole number for a 10s window (5 * 10/60 ≈ 0.83 → 1), landing on
# roughly 6/min instead of 5/min.

resource "cloudflare_ruleset" "rate_limiting" {
  zone_id     = var.cloudflare_zone_id
  name        = "${var.name_prefix}-rate-limiting-${local.suffix}"
  description = "Edge rate limit backstop for auth endpoints (issue #142)."
  kind        = "zone"
  phase       = "http_ratelimit"

  rules = [
    {
      description = "Auth endpoints: ~6 requests/min/IP"
      expression  = "(http.request.method eq \"POST\" and starts_with(http.request.uri.path, \"/api/auth/\"))"
      action      = "block"
      enabled     = true
      # Matches the Worker's own 429 shape (apps/api/src/routes/auth.ts) so a
      # client can't tell an edge block from an app-layer rejection.
      action_parameters = {
        response = {
          status_code  = 429
          content_type = "application/json"
          content      = jsonencode({ error = "too_many_requests" })
        }
      }
      ratelimit = {
        # cf.colo.id is required alongside ip.src: rate-limit counting on this
        # API only happens at the colocation level, and a characteristics list
        # without it is rejected outright (400, code 20155) rather than
        # falling back to some default scope.
        characteristics     = ["ip.src", "cf.colo.id"]
        period              = 10
        requests_per_period = 1
        mitigation_timeout  = 10
      }
    }
  ]
}
