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
