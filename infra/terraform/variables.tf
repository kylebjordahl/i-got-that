variable "cloudflare_api_token" {
  type        = string
  sensitive   = true
  description = "Cloudflare API token with D1/Queues/Workers/Email permissions."
}

variable "cloudflare_account_id" {
  type        = string
  description = "Cloudflare account ID."
}

variable "environment" {
  type        = string
  description = "Deployment environment (staging | production)."
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be 'staging' or 'production'."
  }
}

variable "name_prefix" {
  type        = string
  default     = "igt"
  description = "Resource name prefix."
}

variable "cloudflare_zone_id" {
  type        = string
  description = "Zone ID for the legacy domain the API was first served from (kylebjordahl.com, backing igt.kylebjordahl.com / staging.igt.kylebjordahl.com — see docs/DEPLOYMENT.md §7). Those hostnames still serve /api to older app builds. Rate limiting rules are zone-scoped, unlike the account-scoped resources above."
}

variable "cloudflare_igt_fyi_zone_id" {
  type        = string
  description = "Zone ID for igt.fyi, backing the app + site hostnames (app.igt.fyi, www.igt.fyi, app.staging.igt.fyi, … — see docs/DEPLOYMENT.md §7)."
}
