locals {
  tunnel_hostname = "${var.tunnel_id}.cfargotunnel.com"
  inventory_ready = (
    can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.mvp_access_application_id)) &&
    can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.mvp_access_policy_id)) &&
    can(regex("^[0-9a-f]{32}$", var.mvp_dns_record_id)) &&
    can(regex("^[0-9a-f]{32}$", var.production_dns_record_id)) &&
    !startswith(var.mvp_access_application_id, "00000000-") &&
    !startswith(var.mvp_access_policy_id, "00000000-") &&
    var.mvp_dns_record_id != "00000000000000000000000000000000" &&
    var.production_dns_record_id != "00000000000000000000000000000000"
  )
  # Stagingは独立に棚卸しする。MVP/本番のIDだけで管理を有効化しても、Stagingの
  # 資源が同時に作られないよう別ゲートにする。
  staging_inventory_ready = (
    can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.staging_access_application_id)) &&
    can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.staging_access_policy_id)) &&
    can(regex("^[0-9a-f]{32}$", var.staging_dns_record_id)) &&
    !startswith(var.staging_access_application_id, "00000000-") &&
    !startswith(var.staging_access_policy_id, "00000000-") &&
    var.staging_dns_record_id != "00000000000000000000000000000000"
  )
  base_tunnel_dns_records = {
    mvp = {
      name = "mirai-web-cad-mvp.mirai-dx-platform.com"
    }
    production = {
      name = "mirai-web-cad.mirai-dx-platform.com"
    }
  }
  staging_tunnel_dns_records = {
    staging = {
      name = "mirai-web-cad-stg.mirai-dx-platform.com"
    }
  }
  # Staging CNAMEは棚卸し完了までルーティング表へ入れない。部分的なIDで
  # 既存CNAMEを二重作成しないための安全装置。
  tunnel_dns_records = merge(
    local.base_tunnel_dns_records,
    local.staging_inventory_ready ? local.staging_tunnel_dns_records : {}
  )
}

resource "terraform_data" "management_guard" {
  count = var.enable_management ? 1 : 0
  input = true

  lifecycle {
    precondition {
      condition     = !var.enable_management || local.inventory_ready
      error_message = "Refusing management until all existing Access and DNS IDs have been inventoried."
    }
  }
}

# The ingress rules remain in deploy/cloudflared/mirai-web-cad-config.example.yml
# because this existing tunnel is locally managed by cloudflared/systemd.
resource "cloudflare_zero_trust_tunnel_cloudflared" "mirai_web_cad" {
  count = var.enable_management && local.inventory_ready ? 1 : 0

  account_id = var.account_id
  name       = "mirai-web-cad"
  config_src = "local"

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_dns_record" "tunnel" {
  for_each = var.enable_management && local.inventory_ready ? local.tunnel_dns_records : {}

  zone_id = var.zone_id
  name    = each.value.name
  type    = "CNAME"
  content = local.tunnel_hostname
  proxied = true
  ttl     = 1
  comment = "Managed by Mirai Web CAD Terraform; routes to the local cloudflared tunnel"

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_zero_trust_access_application" "mvp" {
  count = var.enable_management && local.inventory_ready ? 1 : 0

  account_id                 = var.account_id
  name                       = "mirai-web-cad-mvp"
  domain                     = "mirai-web-cad-mvp.mirai-dx-platform.com"
  type                       = "self_hosted"
  session_duration           = "24h"
  app_launcher_visible       = false
  auto_redirect_to_identity  = false
  http_only_cookie_attribute = true
  options_preflight_bypass   = false

  policies = [{
    id         = var.mvp_access_policy_id
    precedence = 1
  }]

  lifecycle {
    prevent_destroy = true

    precondition {
      condition     = lower(trimspace(var.mvp_allowed_email)) == "kensan1969@gmail.com"
      error_message = "Refusing to broaden MVP Access beyond kensan1969@gmail.com."
    }
  }
}

# StagingはMVPと同じホスト全体保護とし、許可はkensan1969@gmail.comのみ。
# 既存policy本文を書き換えないよう、棚卸ししたpolicy UUIDとprecedenceだけを参照する。
# Access Applicationはimport blockの対象外(guardrailがMVP/本番に固定)のため、
# 取り込みはオーナーがimport-only planでterraform importする(README参照)。
resource "cloudflare_zero_trust_access_application" "staging" {
  count = var.enable_management && local.inventory_ready && local.staging_inventory_ready ? 1 : 0

  account_id                 = var.account_id
  name                       = "mirai-web-cad-staging"
  domain                     = "mirai-web-cad-stg.mirai-dx-platform.com"
  type                       = "self_hosted"
  session_duration           = "24h"
  app_launcher_visible       = false
  auto_redirect_to_identity  = false
  http_only_cookie_attribute = true
  options_preflight_bypass   = false

  policies = [{
    id         = var.staging_access_policy_id
    precedence = 1
  }]

  lifecycle {
    prevent_destroy = true

    precondition {
      condition     = lower(trimspace(var.staging_allowed_email)) == "kensan1969@gmail.com"
      error_message = "Refusing to broaden Staging Access beyond kensan1969@gmail.com."
    }
  }
}
