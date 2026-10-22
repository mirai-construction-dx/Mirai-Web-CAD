#!/usr/bin/env bash
# Staging公開URLのCloudflare Access境界を読み取り専用で検査する。
# - 未認証アクセスが302でAccessログインへ遷移すること
# - /api/health もAccessの内側にあり、未認証では302になること(bypassが無いこと)
# - 本番(/api/health)とMVP(/)が従来どおりであること(変更検知用)
# 秘密値・トークンは使わない。ネットワークはCloudflareの公開エンドポイントだけに触れる。
set -euo pipefail

STAGING_URL="${E2E_STAGING_URL:-https://mirai-web-cad-stg.mirai-dx-platform.com}"
PRODUCTION_HEALTH_URL="${E2E_PRODUCTION_HEALTH_URL:-https://mirai-web-cad.mirai-dx-platform.com/api/health}"
MVP_URL="${E2E_MVP_URL:-https://mirai-web-cad-mvp.mirai-dx-platform.com/}"
TIMEOUT="${E2E_HTTP_TIMEOUT:-15}"

fail=0
probe() {
  # stdout: "<status> <redirect_url>" を1行で返す。本文は出さない。
  local url="$1"
  curl -sS --max-time "$TIMEOUT" -o /dev/null -w '%{http_code} %{redirect_url}' "$url"
}

check_staging_access() {
  local url="$1" label="$2" result status redirect
  result="$(probe "$url")"
  status="${result%% *}"
  redirect="${result#* }"
  if [[ "$status" == "302" && "$redirect" == *"cloudflareaccess.com"* ]]; then
    echo "[OK]   ${label}: 302 Accessログイン (${url})"
    return 0
  fi
  echo "[FAIL] ${label}: 期待=302 Accessログイン, 実際=${status} ${redirect} (${url})" >&2
  fail=1
}

check_status() {
  local url="$1" expected="$2" label="$3" result status
  result="$(probe "$url")"
  status="${result%% *}"
  if [[ "$status" == "$expected" ]]; then
    echo "[OK]   ${label}: ${status} (${url})"
    return 0
  fi
  echo "[FAIL] ${label}: 期待=${expected}, 実際=${status} (${url})" >&2
  fail=1
}

echo "Staging公開境界チェック (read-only)"
check_staging_access "${STAGING_URL}/" "Staging root"
check_staging_access "${STAGING_URL}/api/health" "Staging /api/health"
check_status "$PRODUCTION_HEALTH_URL" "200" "本番 /api/health"
check_staging_access "$MVP_URL" "MVP root"

if [[ "$fail" -ne 0 ]]; then
  echo "Staging公開境界チェック: 失敗があります。" >&2
  exit 1
fi
echo "Staging公開境界チェック ok: Stagingは302(Access)、本番は200、MVPは302。"
