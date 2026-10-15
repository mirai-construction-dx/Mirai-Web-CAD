output "managed_tunnel_id" {
  description = "Imported tunnel ID when management is enabled."
  value       = try(cloudflare_zero_trust_tunnel_cloudflared.mirai_web_cad[0].id, null)
}

output "mvp_access_aud" {
  description = "MVP Access audience tag used by the application server."
  value       = try(cloudflare_zero_trust_access_application.mvp[0].aud, null)
}

output "staging_access_aud" {
  description = "Staging Access audience tag used by the application server."
  value       = try(cloudflare_zero_trust_access_application.staging[0].aud, null)
}

output "managed_hostnames" {
  description = "Hostnames routed through the local tunnel."
  value       = var.enable_management ? sort([for record in cloudflare_dns_record.tunnel : record.name]) : []
}
