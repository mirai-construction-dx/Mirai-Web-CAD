#!/usr/bin/env bash
# 本番ドメイン(mirai-web-cad.mirai-dx-platform.com)の可用性と公開境界の監視。
# systemd timer(mirai-web-cad-prod-monitor.timer)から実行される想定。
#
# 背景(改善台帳P0-85、2026-09-18の独立監査で確定):
#   本番(127.0.0.1:18812)を常時監視するunitが無く、可用性の検知をGitHub Actionsの
#   schedule(15分間隔)に100%依存していた。Actionsは分数予算で動くため、超過時には
#   監視・CI・Dependabotが同時に沈黙する。本スクリプトはホスト内で完結する監視を提供する。
#
# 検査内容(MVPのcheck-mvp-health.shと異なる点に注意):
#   1. ローカルAPIのhealthが ok / postgres connected / migrated
#   2. 接続先DBが期待どおり(EXPECTED_DATABASE、既定mirai_web_cad)
#   3. 公開パス(/)が200で応答する(本番はSPAと公開デモが匿名閲覧可。MVPと異なり302ではない)
#   4. 未認証の書込み(POST /api/drawings)が200/201にならない
#      (エッジ層のAccessで302、アプリ層到達で401。どちらでもよいが「成功」は不可)
#
# このスクリプトは読み取り専用で、監査ログへの書き込みも行わない。
set -euo pipefail

local_url="${LOCAL_URL:-http://127.0.0.1:18812}"
public_url="${PUBLIC_URL:-https://mirai-web-cad.mirai-dx-platform.com}"
expected_database="${EXPECTED_DATABASE:-mirai_web_cad}"
pg_bin="${PG_BIN:-$(pg_config --bindir)}"
write_probe_path="${WRITE_PROBE_PATH:-/api/drawings}"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "production health check FAILED: DATABASE_URL is required" >&2
  exit 2
fi

# 1) ローカルAPIとDBの稼働確認
health_json="$(curl --fail --silent --show-error --max-time 15 "${local_url}/api/health")"
HEALTH_JSON="$health_json" node -e '
  const health = JSON.parse(process.env.HEALTH_JSON);
  const valid = health.status === "ok" && health.db?.provider === "postgres" &&
    health.db?.mode === "connected" && health.db?.migrated === true;
  if (!valid) process.exit(1);
' || {
  echo "production health check FAILED: local API or database probe is unhealthy" >&2
  exit 1
}

# 2) 接続先DB名の検証(取り違え検知)
actual_database="$(timeout 15 "${pg_bin}/psql" "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atqc "select current_database()")"
if [[ "$actual_database" != "$expected_database" ]]; then
  echo "production health check FAILED: expected database ${expected_database}, got ${actual_database}" >&2
  exit 1
fi

# 3) 公開パスが200で応答する(サイト全体が停止していない)
public_status="$(curl --silent --show-error --max-time 20 --output /dev/null --write-out '%{http_code}' "${public_url}/")"
if [[ "$public_status" != "200" ]]; then
  echo "production health check FAILED: public SPA is not 200 (status=${public_status})" >&2
  exit 1
fi

# 4) 未認証の書込みが成功しない(公開境界の維持)。302(Accessログイン)または401を許容する。
write_status="$(curl --silent --show-error --max-time 20 --output /dev/null \
  --write-out '%{http_code}' -X POST -H 'content-type: application/json' \
  -d '{}' "${public_url}${write_probe_path}")"
# 未認証の書込みはエッジ層のAccessで302(ログインリダイレクト)、アプリ層到達で401が期待値。
# 403(認証済みだが権限不足)は匿名リクエストでは想定外のため、synthetic-monitor.ymlと判定を
# 統一して302/401のみを許容する(独立レビュー 2026-10-02)。
case "$write_status" in
  302|401) : ;;
  *) echo "production health check FAILED: unauthorized write returned ${write_status} (expected 302/401)" >&2
     exit 1 ;;
esac

echo "production health check ok: local API, database=${actual_database}, public SPA=${public_status}, unauthorized write=${write_status}"
