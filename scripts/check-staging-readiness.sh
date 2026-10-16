#!/usr/bin/env bash
# Staging readinessの読み取り専用チェッカー(ADR-0005)。
#
# このスクリプトは**ホストを一切変更しない**。sudo・systemctl start/enable・DNS/Access変更・
# DB作成は行わず、`systemctl cat/is-enabled/is-active`・`stat`・`curl`・`psql`の読取り系だけで
# 現状を報告する。**秘密値(envファイルの値)は絶対に出力しない**。キー名は
# `grep -o '^[A-Z_]*='`で示し、値は画面へ出さない(staging-bringup.md §2の警告に合わせる)。
#
# 目的: オーナーY/N後にStagingを構築する前後で「何が済んでいて何が未了か」を何度でも安全に
# 確認できるようにする。構築前(未構築)はexit 0で「未構築」を報告し、構築を始めた後に
# 必須項目が欠けている場合だけexit 1で失敗する。
#
# 検査対象は次の6点。
#   (1) systemdユニットが設置され、enable/activeであること
#   (2) envファイルが存在しmode 0600であること(キー名のみ表示)
#   (3) アプリDBと復元用隔離DBが存在すること(sedで解決したURLで接続、sourceはしない)
#   (4) ローカルhealth(18814)が ok / db.mode=connected / 接続DB名=mirai_web_cad_staging
#   (5) 公開URLがAccessログインへ302すること
#   (6) deploy-local.shがStaging(3系統目)へ対応していること
#
# 依存: bash + curl + psql のみ(jq/node不要)。
set -Eeuo pipefail
cd "$(dirname "$0")/.."

# 固定値(ADR-0005 §2 / docs/runbooks/staging-bringup.md と同じ値を使う)。
service="mirai-web-cad-staging.service"
port="18814"
host="mirai-web-cad-stg.mirai-dx-platform.com"
app_db="mirai_web_cad_staging"
recovery_db="mirai_web_cad_staging_recovery"
app_env="$HOME/.config/mirai-web-cad/staging.env"
backup_env="$HOME/.config/mirai-web-cad/staging-backup.env"
deploy_script="scripts/deploy-local.sh"

fail=0
provisioned=0
ok() { echo "  [OK]   $*"; }
skip() { echo "  [SKIP] $*"; }
warn() { echo "  [WARN] $*"; }
# 必須項目の未達を記録する(集約カウンタ)。構築開始後はこれが1つでもあればexit 1。
# 項目ごとのPASS/FAILが前後しても読みやすいよう、報告行はstdoutへ出す(順序が崩れない)。
fail_item() { echo "  [FAIL] $*"; fail=1; }

# envファイルから1変数の値だけを取り出す。systemdと同じく、値の外側の引用符は外す。
# ファイルを`source`しない(ACCESS_ROLE_MAP等のJSON値が壊れる。deploy-local.shと同じ方式)。
read_env_value() {
  local file="$1" key="$2" value=""
  [[ -r "$file" ]] || { printf ''; return 0; }
  value="$(sed -n "s/^${key}=//p" "$file" | head -n 1)"
  if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then
    value="${BASH_REMATCH[1]}"
  fi
  printf '%s' "$value"
}

# 接続URLからDB名(クエリを除いたパス末尾)だけを取り出す。
url_database_name() {
  local url="$1"
  [[ -n "$url" ]] || { printf ''; return 0; }
  printf '%s' "${url%%\?*}" | sed 's#/$##' | sed 's#.*/##'
}

# 利用可能なツールを解決する(無くても失敗にせず、その旨をWARNで残す)。
curl_bin="$(command -v curl || true)"
psql_bin="$(command -v psql || true)"
if [[ -z "$psql_bin" ]] && command -v pg_config >/dev/null 2>&1; then
  psql_bin="$(pg_config --bindir 2>/dev/null)/psql"
fi

echo "Staging readinessチェック (read-only / ホスト変更なし)"

# (1) systemdユニットの設置・enable・active。
echo "1) systemdユニット: $service"
installed=0
if command -v systemctl >/dev/null 2>&1 && systemctl cat "$service" >/dev/null 2>&1; then
  installed=1
  provisioned=1
  ok "ユニット設置済み"
  if [[ "$(systemctl is-enabled "$service" 2>/dev/null || true)" == "enabled" ]]; then
    ok "enabled"
  else
    fail_item "enabledではありません(systemctl enableが必要。Human Gate 5)"
  fi
  if [[ "$(systemctl is-active "$service" 2>/dev/null || true)" == "active" ]]; then
    ok "active"
  else
    fail_item "activeではありません(未起動または起動失敗)"
  fi
else
  skip "ユニット未設置(Human Gate 5: /etc/systemd/system への配置とenable)"
fi

# (2) envファイルの存在とmode 0600。値は出さず、キー名だけを表示する。
echo "2) envファイル(存在・mode 0600・キー名のみ表示)"
app_env_present=0
backup_env_present=0
for entry in "app:$app_env" "backup:$backup_env"; do
  label="${entry%%:*}"
  file="${entry#*:}"
  if [[ -f "$file" ]]; then
    if [[ "$label" == "app" ]]; then app_env_present=1; else backup_env_present=1; fi
    provisioned=1
    mode="$(stat -c '%a' "$file" 2>/dev/null || true)"
    if [[ "$mode" == "600" ]]; then
      ok "$file が存在し mode=0600"
    else
      fail_item "$file のmodeが0600ではありません(mode=${mode:-unknown})"
    fi
    keys="$(grep -o '^[A-Z_]*=' "$file" 2>/dev/null | sed 's/=$//' | tr '\n' ' ' || true)"
    echo "         キー名: ${keys% }"
  else
    skip "$file は未作成(Human Gate 3)"
  fi
done

# (3) アプリDBと復元用隔離DBの存在。接続先はsedで解決し、sourceはしない。
echo "3) DB存在: $app_db / $recovery_db"
app_url="$(read_env_value "$app_env" DATABASE_URL)"
backup_url="$(read_env_value "$backup_env" DATABASE_URL)"
restore_url="$(read_env_value "$backup_env" RESTORE_DATABASE_URL)"
# pg_databaseは共有カタログのため、どのDBへ接続しても両DBの存在を確認できる。
# 接続にはアプリURLを優先し、無ければbackup URLを使う(いずれも読取り専用クエリのみ)。
check_url="${app_url:-$backup_url}"
if [[ -z "$check_url" ]]; then
  if [[ "$provisioned" -eq 1 ]]; then
    fail_item "DATABASE_URLを解決できません(env未作成またはキー欠落)"
  else
    skip "DATABASE_URLを解決できないためDB存在を未確認"
  fi
elif [[ -z "$psql_bin" || ! -x "$psql_bin" ]]; then
  warn "psqlが見つからないためDB存在を確認できません"
else
  resolved_app_name="$(url_database_name "$app_url")"
  resolved_restore_name="$(url_database_name "$restore_url")"
  if [[ -z "$resolved_app_name" ]]; then
    skip "staging.env の DATABASE_URL 未設定"
  elif [[ "$resolved_app_name" == "$app_db" ]]; then
    ok "staging.env の DATABASE_URL のDB名 = $app_db"
  else
    fail_item "staging.env の DATABASE_URL のDB名が $app_db ではありません(=$resolved_app_name)"
  fi
  if [[ -n "$resolved_restore_name" && "$resolved_restore_name" != "$recovery_db" ]]; then
    fail_item "staging-backup.env の RESTORE_DATABASE_URL のDB名が $recovery_db ではありません(=$resolved_restore_name)"
  fi
  for db in "$app_db" "$recovery_db"; do
    exists="$(PGCONNECT_TIMEOUT=5 "$psql_bin" "$check_url" -Atqc "select 1 from pg_database where datname='$db'" 2>/dev/null || true)"
    if [[ "$exists" == "1" ]]; then
      ok "DB存在: $db"
    else
      fail_item "DB未作成: $db(Human Gate 4)"
    fi
  done
fi

# (4) ローカルhealth(18814)。ok / db.mode=connected / 接続DB名の一致を確認する。
echo "4) ローカルhealth: http://127.0.0.1:${port}/api/health"
health_json=""
if [[ -n "$curl_bin" ]]; then
  health_json="$("$curl_bin" -fsS --max-time 5 "http://127.0.0.1:${port}/api/health" 2>/dev/null || true)"
fi
if [[ -n "$health_json" ]]; then
  if printf '%s' "$health_json" | grep -qE '"ok"[[:space:]]*:[[:space:]]*true'; then
    ok "ok=true"
  else
    fail_item "ok=trueではありません(status=degraded/503の可能性)"
  fi
  # healthは整形済み(複数行)JSONで返るため、改行を除去してから部分一致で取り出す(改善: 複数行JSONでdb.modeを取り違えない)。
  health_flat="$(printf '%s' "$health_json" | tr -d '\n')"
  db_json="$(printf '%s' "$health_flat" | grep -oE '"db"[[:space:]]*:[[:space:]]*\{[^}]*\}' | head -n 1 || true)"
  db_mode="$(printf '%s' "$db_json" | grep -oE '"mode"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/' || true)"
  db_name_health="$(printf '%s' "$db_json" | grep -oE '"database"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/' || true)"
  if [[ "$db_mode" == "connected" ]]; then
    ok "db.mode=connected"
  else
    fail_item "db.mode=connectedではありません(mode=${db_mode:-unknown})"
  fi
  if [[ -n "$db_name_health" ]]; then
    if [[ "$db_name_health" == "$app_db" ]]; then
      ok "db.database=$app_db"
    else
      fail_item "db.databaseが $app_db ではありません(=$db_name_health)"
    fi
  elif [[ -n "$check_url" && -n "$psql_bin" && -x "$psql_bin" ]]; then
    # 未認証のhealth応答ではdb.databaseが伏せられるため、psqlで実接続名を確認する。
    current_db="$(PGCONNECT_TIMEOUT=5 "$psql_bin" "$check_url" -Atqc 'select current_database()' 2>/dev/null || true)"
    if [[ "$current_db" == "$app_db" ]]; then
      ok "接続DB名=$app_db(psqlで確認)"
    else
      fail_item "接続DB名が $app_db ではありません(=${current_db:-unknown})"
    fi
  fi
elif [[ "$provisioned" -eq 1 ]]; then
  fail_item "health応答なし(サービス未起動/ポート${port}未待受)"
else
  skip "health応答なし(サービス未起動。構築前は想定内)"
fi

# (5) 公開URLがAccessログインへ302すること(Human Gate 7)。
echo "5) 公開URLのAccess境界: https://${host}/"
if [[ -z "$curl_bin" ]]; then
  warn "curlが見つからないため公開URLを確認できません"
else
  headers_file="$(mktemp)"
  trap 'rm -f "$headers_file"' EXIT
  public_status="$("$curl_bin" --silent --show-error --max-time 20 --output /dev/null \
    --dump-header "$headers_file" --write-out '%{http_code}' "https://${host}/" 2>/dev/null || true)"
  if [[ "$public_status" == "302" ]] && grep -Eiq '^location: https://[^/]+\.cloudflareaccess\.com/' "$headers_file"; then
    ok "未認証アクセスが302でAccessログインへ"
  elif [[ -z "$public_status" || "$public_status" == "000" ]]; then
    if [[ "$provisioned" -eq 1 ]]; then
      fail_item "公開URLへ到達できません(DNS/Access/ingressを確認。Human Gate 1・2・7)"
    else
      skip "公開URLへ到達できません(DNS/Access未設定。構築前は想定内)"
    fi
  else
    fail_item "Access境界が302ではありません(status=${public_status:-unknown})"
  fi
fi

# (6) deploy-local.shがStaging(3系統目)へ対応していること(コード側は既に完了済み)。
echo "6) deploy-local.shのStaging対応"
if [[ -f "$deploy_script" ]] \
  && grep -q "18814" "$deploy_script" \
  && grep -q "mirai-web-cad-staging\.service" "$deploy_script"; then
  ok "$deploy_script が $service とポート${port} に対応"
else
  fail_item "$deploy_script がStaging($service/ポート${port})へ未対応"
fi

echo
if [[ "$provisioned" -eq 0 ]]; then
  echo "Staging環境は未構築です(オーナーY/N待ちの想定状態)。"
  echo "systemdユニット・envファイルはいずれも未作成で、サービスは未起動です。構築は docs/runbooks/staging-bringup.md の Human Gate 1〜7 に従ってください。"
  exit 0
fi

if [[ "$fail" -ne 0 ]]; then
  echo "Staging readiness: 必須項目に未達があります。" >&2
  exit 1
fi
echo "Staging readiness ok: ユニット・env(0600)・DB・health・Access境界・deploy-local.sh対応を確認しました。"
