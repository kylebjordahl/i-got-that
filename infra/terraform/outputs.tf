output "d1_database_id" {
  value       = cloudflare_d1_database.primary.id
  description = "Paste into apps/api/wrangler.jsonc (env.<env>.d1_databases[].database_id)."
}

output "d1_database_name" {
  value = cloudflare_d1_database.primary.name
}

output "access_protected_path" {
  value       = one(cloudflare_zero_trust_access_application.staging_web[*].domain)
  description = "Hostname + path guarded by Cloudflare Access; null when Access isn't provisioned."
}
