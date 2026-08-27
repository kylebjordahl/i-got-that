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
# One rule, not one per endpoint group: this zone's plan caps the
# http_ratelimit phase at 1 custom rule (Cloudflare rejects a 2nd with 400,
# code 50001, "exceeded the maximum number of rules in the phase
# http_ratelimit: 2 out of 1") — a plan-tier limit, not something Terraform
# config can route around. So this single rule takes the less-restrictive
# threshold (auth's 5/min) across both endpoint groups, and leans on the
# Worker's own app-layer limits above for the tighter per-endpoint
# enforcement (feed-refresh's 60s cooldown is already stricter than 5/min, so
# in practice the app layer catches refresh abuse first and this rule is a
# coarse backstop for both).

resource "cloudflare_ruleset" "rate_limiting" {
  zone_id     = var.cloudflare_zone_id
  name        = "${var.name_prefix}-rate-limiting-${local.suffix}"
  description = "Edge rate limit backstop for auth + feed-refresh endpoints (issue #142)."
  kind        = "zone"
  phase       = "http_ratelimit"

  rules = [
    {
      description = "Auth + feed-refresh endpoints: 5 requests/min/IP"
      expression  = "(http.request.method eq \"POST\" and (starts_with(http.request.uri.path, \"/api/auth/\") or http.request.uri.path matches \"^/api/families/[^/]+/feeds/.*refresh.*$\"))"
      action      = "block"
      enabled     = true
      # Matches the Worker's own generic 429 shape (apps/api/src/routes/auth.ts)
      # so a client can't tell an edge block from an app-layer rejection. Feed
      # refresh's app-layer cooldown returns a different, friendlier shape
      # (refresh_cooldown) — this rule shouldn't usually be the one a
      # feed-refresh client actually hits, per the comment above.
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
        period              = 60
        requests_per_period = 5
        mitigation_timeout  = 60
      }
    }
  ]
}
