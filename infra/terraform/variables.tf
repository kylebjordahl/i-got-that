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

variable "staging_hostname" {
  type        = string
  default     = "staging.igt.kylebjordahl.com"
  description = "Staging hostname (must match the custom_domain route in apps/api/wrangler.jsonc)."
}

variable "access_allowed_emails" {
  type        = list(string)
  default     = []
  description = <<-EOT
    Emails allowed through Cloudflare Access on the staging web client (/app).
    Empty (the default) ⇒ no Access resources are provisioned at all, so nothing
    changes for anyone who hasn't opted in. Ignored outside staging.
  EOT
}
