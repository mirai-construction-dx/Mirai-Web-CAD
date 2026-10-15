# Conditional import blocks prevent duplicate resources. They remain inactive
# until enable_management=true and all existing resource IDs pass inventory checks.

import {
  for_each = var.enable_management && local.inventory_ready ? { existing = var.tunnel_id } : {}
  to       = cloudflare_zero_trust_tunnel_cloudflared.mirai_web_cad[0]
  id       = "${var.account_id}/${each.value}"
}

import {
  for_each = var.enable_management && local.inventory_ready ? merge(
    {
      mvp        = var.mvp_dns_record_id
      production = var.production_dns_record_id
    },
    local.staging_inventory_ready ? { staging = var.staging_dns_record_id } : {}
  ) : {}
  to = cloudflare_dns_record.tunnel[each.key]
  id = "${var.zone_id}/${each.value}"
}

import {
  for_each = var.enable_management && local.inventory_ready ? { existing = var.mvp_access_application_id } : {}
  to       = cloudflare_zero_trust_access_application.mvp[0]
  id       = "accounts/${var.account_id}/${each.value}"
}
