#!/usr/bin/env bash
set -euo pipefail

local_url="${LOCAL_URL:-http://127.0.0.1:18814}"
public_url="${PUBLIC_URL:-https://mirai-web-cad-stg.mirai-dx-platform.com}"
expected_database="${EXPECTED_DATABASE:-mirai_web_cad_staging}"
require_access_redirect="${REQUIRE_ACCESS_REDIRECT:-yes}"
pg_bin="${PG_BIN:-$(pg_config --bindir)}"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "Staging health check FAILED: DATABASE_URL is required" >&2
  exit 2
fi

health_json="$(curl --fail --silent --show-error --max-time 15 "${local_url}/api/health")"
HEALTH_JSON="$health_json" node -e '
  const health = JSON.parse(process.env.HEALTH_JSON);
  const valid = health.status === "ok" && health.db?.provider === "postgres" &&
    health.db?.mode === "connected" && health.db?.migrated === true;
  if (!valid) process.exit(1);
' || {
  echo "Staging health check FAILED: local API or database probe is unhealthy" >&2
  exit 1
}

actual_database="$("${pg_bin}/psql" "$DATABASE_URL" -Atqc 'select current_database()')"
if [[ "$actual_database" != "$expected_database" ]]; then
  echo "Staging health check FAILED: expected database ${expected_database}, got ${actual_database}" >&2
  exit 1
fi

if [[ "$require_access_redirect" == "yes" ]]; then
  headers_file="$(mktemp)"
  trap 'rm -f "$headers_file"' EXIT
  public_status="$(curl --silent --show-error --max-time 20 --output /dev/null \
    --dump-header "$headers_file" --write-out '%{http_code}' "${public_url}/")"
  if [[ "$public_status" != "302" ]] || ! grep -Eiq '^location: https://[^/]+\.cloudflareaccess\.com/' "$headers_file"; then
    echo "service health check FAILED: public endpoint is not protected by Cloudflare Access (status=${public_status})" >&2
    exit 1
  fi
elif [[ "$require_access_redirect" != "no" ]]; then
  echo "service health check FAILED: REQUIRE_ACCESS_REDIRECT must be yes or no" >&2
  exit 2
fi

echo "service health check ok: local API, database=${actual_database}, Access redirect required=${require_access_redirect}"
