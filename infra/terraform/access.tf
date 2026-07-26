# --- Cloudflare Access on the staging web client -------------------------
#
# Defense-in-depth in front of the Flutter web client at
# `https://<staging_hostname>/app`. Staging is a public internet host carrying
# real connected calendar accounts, so the login page shouldn't be a thing you
# stumble onto.
#
# SCOPED TO /app ON PURPOSE — do NOT widen this to the bare hostname. The same
# Worker serves an /api surface with callers that can never complete an Access
# login:
#
#   /api/auth/apple/callback        Apple form-POSTs here cross-site; Access
#                                   would answer with a login redirect and drop
#                                   the POST body, breaking web Sign in with Apple.
#   /api/auth/google/callback       Google's redirect back, same shape.
#   /api/auth/apple/notifications   Apple's out-of-band server-to-server events
#                                   (revoke / delete). Trust is the JWS signature;
#                                   the caller is a machine with no browser.
#   /.well-known/apple-app-site-association
#                                   Fetched by Apple's CDN for Universal Links.
#   /api/*                          The native staging app — no browser, so it
#                                   would need service-token headers baked in.
#
# The web login round-trip still works with /app protected: the browser clears
# Access once at /app, the callbacks land on unprotected /api paths, and the
# 302 back to /app/#session=… rides the CF_Authorization cookie already set.
#
# This gates the UI, not the data — /api stays reachable. It's a speed bump
# against drive-by discovery, not an authorization boundary. The authorization
# boundary is the API's own session auth.
#
# Resource schemas confirmed against cloudflare provider 5.21.1 (see
# .terraform.lock.hcl). Requires Zero Trust enabled on the account and an API
# token with Access edit rights — see docs/DEPLOYMENT.md §8.

locals {
  # Staging only, and only once someone is actually allow-listed: an empty list
  # would otherwise provision an application that locks everyone out. Production
  # is excluded outright — this same config is applied per-env.
  access_enabled = var.environment == "staging" && length(var.access_allowed_emails) > 0
}

resource "cloudflare_zero_trust_access_policy" "staging_web" {
  count      = local.access_enabled ? 1 : 0
  account_id = var.cloudflare_account_id
  name       = "${var.name_prefix}-staging-web"
  decision   = "allow"

  # Email allow-list, verified by the built-in one-time PIN login method — no
  # identity provider to configure. Add an `email_domain` rule instead if this
  # ever needs to cover a whole domain.
  include = [for email in var.access_allowed_emails : { email = { email = email } }]
}

resource "cloudflare_zero_trust_access_application" "staging_web" {
  count      = local.access_enabled ? 1 : 0
  account_id = var.cloudflare_account_id
  name       = "${var.name_prefix} staging web client"
  type       = "self_hosted"
  # `domain` is hostname + path prefix; everything outside /app is untouched.
  domain           = "${var.staging_hostname}/app"
  session_duration = "24h"

  policies = [{
    id         = cloudflare_zero_trust_access_policy.staging_web[0].id
    precedence = 1
  }]
}
