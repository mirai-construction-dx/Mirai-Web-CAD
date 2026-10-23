#!/usr/bin/env bash
# Staging DBでmigrationをリハーサルする(適用＋seed＋適用後状態の確認)。
#
# 目的: 本番・MVPへmigrationを反映する前に、使い捨てのStaging DBで
#   1. `npm run db:verify`(migrationの適用＋seeds/demo.sqlの投入)
#   2. `npm run db:check`(読み取りのみの適用後状態の確認)
# を通し、migrationと検証手順そのものが成立することを確かめる。
#
# 安全境界(このスクリプトが守ること):
#   - 対象DBは `staging.env` の `DATABASE_URL` をsedで1変数だけ取り出して決める
#     (`source`しない。JSON値等が壊れるため)。値は**絶対に表示しない**。
#   - 接続先DB名が `mirai_web_cad_staging` でなければ、何も実行せずに中止する。
#     本番(`mirai_web_cad`)・MVPのDBへ `db:verify` を流さないための最後の砦。
#   - systemdの再起動・停止、`current` symlinkの切替、デプロイは一切行わない。
#     失敗しても稼働中のStagingの配信物とプロセスは変わらない(変わるのはDBだけ)。
#   - 実行前後にStagingの `/api/health` を確認し、結果だけを表示する(本文は出さない)。
#
# 前提: `migrations/` はadditiveかつ後方互換のみ(AGENTS.md §4)。Stagingは使い捨てデータで、
# 本番・MVP・MCIP・CDEへは送らない。手順と判定は
# docs/runbooks/staging-migration-rehearsal.md を参照。
#
# 使い方:
#   bash scripts/rehearse-staging-migration.sh            # 実行
#   bash scripts/rehearse-staging-migration.sh --dry-run  # 予定だけ表示(実行しない)
#
# 環境変数(通常は変更しない):
#   STAGING_ENV_FILE   対象envファイル(既定: ~/.config/mirai-web-cad/staging.env)
#   STAGING_DB_NAME    期待するDB名(既定: mirai_web_cad_staging)
#   STAGING_PORT       healthの待受ポート(既定: 18814)
#   STAGING_HEALTH_TIMEOUT_SECONDS  health取得のタイムアウト秒(既定: 5)
set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

env_file="${STAGING_ENV_FILE:-$HOME/.config/mirai-web-cad/staging.env}"
expected_db="${STAGING_DB_NAME:-mirai_web_cad_staging}"
port="${STAGING_PORT:-18814}"
health_url="http://127.0.0.1:${port}/api/health"
health_timeout="${STAGING_HEALTH_TIMEOUT_SECONDS:-5}"

dry_run=0

usage() {
  awk 'NR > 1 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "$0"
}

die() {
  echo "Staging migrationリハーサルを中止します: $*" >&2
  exit 1
}

# envファイルから1変数の値だけを取り出す。systemdと同じく値の外側の引用符は外す。
# ファイルを`source`しない(ACCESS_ROLE_MAP等のJSON値が壊れるため)。
# 取り出した値(DATABASE_URL)は絶対にechoしない。
read_env_value() {
  local key="$1" value=""
  value="$(sed -n "s/^${key}=//p" "$env_file" | head -n 1)"
  if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then
    value="${BASH_REMATCH[1]}"
  fi
  printf '%s' "$value"
}

# 接続URLからDB名(クエリと末尾スラッシュを除いたパス末尾)だけを取り出す。
url_database_name() {
  local url="$1"
  [[ -n "$url" ]] || { printf ''; return 0; }
  printf '%s' "${url%%\?*}" | sed 's#/$##' | sed 's#.*/##'
}

# health応答から1フィールドだけを取り出す。"key": "value" / true / false に対応する。
health_field() {
  local key="$1" body="$2"
  printf '%s' "$body" \
    | grep -oE "\"${key}\"[[:space:]]*:[[:space:]]*(\"[^\"]*\"|true|false)" \
    | head -n 1 \
    | sed -E 's/^[^:]+:[[:space:]]*//; s/^"//; s/"$//' || true
}

# healthのdb.modeだけを取り出す。単純な`health_field mode`ではauth.mode(access)を
# 先に拾ってしまうため、dbオブジェクトの中のmodeに限定する。
db_mode_field() {
  local body="$1"
  # healthは整形済みJSON(複数行)なので、改行を除いてからdbオブジェクト内のmodeを探す。
  printf '%s' "$body" \
    | tr -d '\n' \
    | sed -n 's/.*"db"[[:space:]]*:[[:space:]]*{[^}]*"mode"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -n 1
}

# Stagingのhealthを確認し、秘密を含まない要約だけを表示する。
# health本文には(匿名healthでは)利用者情報も含まれ得るため、本文は表示しない。
health_summary() {
  local phase="$1" body ok dist db_mode
  body="$(curl -fsS --max-time "$health_timeout" "$health_url" 2>/dev/null || true)"
  if [[ -z "$body" ]]; then
    echo "[health:${phase}] ${health_url} を取得できませんでした" >&2
    return 1
  fi
  ok="$(health_field ok "$body")"
  dist="$(health_field distCommit "$body")"
  db_mode="$(db_mode_field "$body")"
  echo "[health:${phase}] ok=${ok:-unknown} distCommit=${dist:-unknown} db.mode=${db_mode:-unknown}"
  [[ "$ok" == "true" ]]
}

for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    -h | --help) usage; exit 0 ;;
    *) die "不明な引数です: ${arg}(使用可能: --dry-run, --help)" ;;
  esac
done

[[ -r "$env_file" ]] || die "Stagingのenvファイルを読めません: ${env_file}"
staging_database_url="$(read_env_value DATABASE_URL)"
[[ -n "$staging_database_url" ]] || die "${env_file} に DATABASE_URL がありません。"

resolved_db="$(url_database_name "$staging_database_url")"
[[ "$resolved_db" == "$expected_db" ]] \
  || die "staging.env の DATABASE_URL のDB名が ${expected_db} と一致しません(値は表示しません)。本番・MVPのDBを対象にdb:verifyは実行しません。"
unset resolved_db

if [[ "$dry_run" == "1" ]]; then
  echo "[dry-run] 実行せずに予定だけを表示します。"
  echo "対象DB: ${expected_db}"
  echo "envファイル: ${env_file}"
  echo "1. health確認(前): curl -fsS --max-time ${health_timeout} ${health_url}"
  echo "2. DATABASE_URL=<非表示> npm run db:verify   # migration適用＋seed"
  echo "3. DATABASE_URL=<非表示> npm run db:check    # 適用後状態の読み取り検証"
  echo "4. health確認(後): curl -fsS --max-time ${health_timeout} ${health_url}"
  echo "[dry-run] 実行していません。"
  exit 0
fi

echo "Staging migrationリハーサル開始: DB=${expected_db}(値は表示しません)"

echo "=== 1/4 実行前のStaging health確認 ==="
if ! health_summary before; then
  echo "  警告: 実行前のhealthを確認できませんでした。DB検証は続行します(サービスは再起動しません)。" >&2
fi

echo "=== 2/4 db:verify (migration適用＋seed) ==="
if ! DATABASE_URL="$staging_database_url" npm run db:verify; then
  echo "Staging migrationリハーサル失敗: db:verify が失敗しました。" >&2
  echo "  所有権不足・Staging DBへの接続不可・migration不整合のいずれかの可能性があります。" >&2
  echo "  Stagingサービスは再起動していません。DBの状態は変わり得るため、docs/runbooks/staging-migration-rehearsal.md を参照してください。" >&2
  health_summary after || true
  exit 1
fi

echo "=== 3/4 db:check (適用後状態の確認) ==="
if ! DATABASE_URL="$staging_database_url" npm run db:check; then
  echo "Staging migrationリハーサル失敗: db:check が失敗しました。" >&2
  echo "  migrationは適用済みの可能性があります。Stagingサービスは再起動していません。" >&2
  echo "  docs/runbooks/staging-migration-rehearsal.md「失敗時の扱い」に従ってください。" >&2
  health_summary after || true
  exit 1
fi

echo "=== 4/4 実行後のStaging health確認 ==="
if ! health_summary after; then
  echo "Staging migrationリハーサル失敗: db:verify/db:checkは成功しましたが、実行後のhealthを確認できませんでした。" >&2
  echo "  Stagingサービス自体は再起動していません。起動状態を確認してください。" >&2
  exit 1
fi

unset staging_database_url
echo "Staging migrationリハーサル成功: DB=${expected_db} db:verify=ok db:check=ok"
