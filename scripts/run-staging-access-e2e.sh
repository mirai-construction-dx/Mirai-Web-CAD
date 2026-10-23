#!/usr/bin/env bash
# Staging公開URLのE2Eを、Cloudflare Access Service Tokenを使って実行するラッパー。
#
# 実行順:
#   1. scripts/check-staging-public-boundary.sh (未認証の公開境界。Staging 302 / 本番 200 / MVP 302)
#   2. npm run test:e2e:staging (公開URL + Access Service Token。E2E_EXPECT_COMMITは任意)
#   3. scripts/check-staging-public-boundary.sh の再実行 (E2E後もAccess境界が維持されていること)
#
# - E2E_CF_ACCESS_CLIENT_ID / E2E_CF_ACCESS_CLIENT_SECRET がどちらか欠けた場合は、
#   実行計画(dry-run相当)だけを表示し、実テストもネットワークアクセスも行わず exit 78 で終了する。
# - トークン値は環境変数として子プロセスへ渡すだけで、標準出力・標準エラー・実行計画へ出さない。
#   xtrace(-x)はトークンを読む前に無効化する。子プロセスへは env -i で必要な変数だけを渡し、
#   境界チェック(トークン不要)にはトークンを渡さない。
# - Access Service Tokenの作成・Access policyの変更・削除は行わない(オーナーの手動運用)。
set -euo pipefail

# xtrace(-x)は、変数の展開をそのままログへ書き得る。トークンを変数へ読む前に必ず無効化する。
if [[ $- == *x* ]]; then
  set +x
  echo "注意: xtrace(-x)を無効化しました(トークン値をログへ出さないため)。" >&2
fi

cd "$(dirname "$0")/.."

EX_CONFIG=78
EX_USAGE=64

dry_run=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)
      dry_run=1
      ;;
    -h | --help)
      echo "使い方: bash scripts/run-staging-access-e2e.sh [--dry-run]"
      echo "  E2E_CF_ACCESS_CLIENT_ID / E2E_CF_ACCESS_CLIENT_SECRET: 必須(オーナーが手動発行)"
      echo "  E2E_EXPECT_COMMIT: 任意(配信commitの照合)"
      echo "  E2E_BASE_URL: 任意(対象URL。既定は公開Staging URL)"
      echo "  --dry-run: 実行計画だけを表示し、何も実行しない"
      exit 0
      ;;
    *)
      echo "不明な引数です: $arg" >&2
      echo "使い方: bash scripts/run-staging-access-e2e.sh [--dry-run]" >&2
      exit "$EX_USAGE"
      ;;
  esac
done

# 既定は scripts/verify-staging-domain.mjs と同じ公開Staging URL。
base_url="${E2E_BASE_URL:-https://mirai-web-cad-stg.mirai-dx-platform.com}"
expect_commit="${E2E_EXPECT_COMMIT:-}"

# トークンは変数へ退避してから、このシェルの環境から削除する。
# これにより、以降の子プロセス(境界チェック等)がトークンを環境から継承しない。
client_id="${E2E_CF_ACCESS_CLIENT_ID:-}"
client_secret="${E2E_CF_ACCESS_CLIENT_SECRET:-}"
unset E2E_CF_ACCESS_CLIENT_ID E2E_CF_ACCESS_CLIENT_SECRET

id_state="未設定"
secret_state="未設定"
if [[ -n "$client_id" ]]; then
  id_state="設定済み"
fi
if [[ -n "$client_secret" ]]; then
  secret_state="設定済み"
fi

# 秘密値を含まない実行計画。dry-runと前提チェック失敗の両方で使う。
print_plan() {
  echo "Staging Access E2E 実行計画"
  echo "  1. 公開境界チェック(未認証・read-only): bash scripts/check-staging-public-boundary.sh"
  echo "     Staging=302(Access)、本番 /api/health=200、MVP=302 を確認"
  echo "  2. 公開URL E2E: npm run test:e2e:staging"
  echo "     対象URL: ${base_url}"
  echo "     期待commit: ${expect_commit:-(未指定)}"
  echo "     E2E_CF_ACCESS_CLIENT_ID: ${id_state}"
  echo "     E2E_CF_ACCESS_CLIENT_SECRET: ${secret_state}"
  echo "  3. 公開境界チェック(E2E後): bash scripts/check-staging-public-boundary.sh"
}

print_plan

if [[ "$dry_run" -eq 1 ]]; then
  echo "dry-run: 上記のコマンドは実行しません(ネットワークへも接続しません)。"
  echo "dry-run 完了。トークン値は表示していません。"
  exit 0
fi

if [[ -z "$client_id" || -z "$client_secret" ]]; then
  # トークン欠落時は「dry-run相当の前提チェック結果だけを表示する」要件のため、
  # ネットワークへ触れる(境界チェック)前に判定して終了する。
  missing=""
  if [[ -z "$client_id" ]]; then
    missing="${missing} E2E_CF_ACCESS_CLIENT_ID"
  fi
  if [[ -z "$client_secret" ]]; then
    missing="${missing} E2E_CF_ACCESS_CLIENT_SECRET"
  fi
  echo "前提チェック失敗:${missing} が未設定です。" >&2
  echo "Access Service Tokenはオーナーが手動で発行し、テスト直後に削除します。このスクリプトはトークンの発行・Access policyの変更・削除を行いません。" >&2
  echo "ネットワークアクセス(公開境界チェック)も行っていません。" >&2
  echo "実テストは実行していません(exit ${EX_CONFIG})。" >&2
  exit "$EX_CONFIG"
fi

# 境界チェック(トークン不要)へ渡す変数だけを明示する。
boundary_env=(env -i "PATH=${PATH:-/usr/local/bin:/usr/bin:/bin}" "HOME=${HOME:-}")
if [[ -n "${TMPDIR:-}" ]]; then
  boundary_env+=("TMPDIR=$TMPDIR")
fi
if [[ -n "${E2E_STAGING_URL:-}" ]]; then
  boundary_env+=("E2E_STAGING_URL=$E2E_STAGING_URL")
fi
if [[ -n "${E2E_PRODUCTION_HEALTH_URL:-}" ]]; then
  boundary_env+=("E2E_PRODUCTION_HEALTH_URL=$E2E_PRODUCTION_HEALTH_URL")
fi
if [[ -n "${E2E_MVP_URL:-}" ]]; then
  boundary_env+=("E2E_MVP_URL=$E2E_MVP_URL")
fi
if [[ -n "${E2E_HTTP_TIMEOUT:-}" ]]; then
  boundary_env+=("E2E_HTTP_TIMEOUT=$E2E_HTTP_TIMEOUT")
fi

run_boundary() {
  local phase="$1"
  echo "[境界] 公開境界チェック(${phase})を実行します。"
  "${boundary_env[@]}" bash scripts/check-staging-public-boundary.sh
}

# E2Eへ渡す変数だけを明示する。E2E_STAGING_LOCALなどは意図的に渡さない
# (トークン必須の公開URL E2Eが、ローカルモードへ切り替わらないようにする)。
e2e_env=(
  env -i
  "PATH=${PATH:-/usr/local/bin:/usr/bin:/bin}"
  "HOME=${HOME:-}"
  "E2E_CF_ACCESS_CLIENT_ID=${client_id}"
  "E2E_CF_ACCESS_CLIENT_SECRET=${client_secret}"
)
if [[ -n "${TMPDIR:-}" ]]; then
  e2e_env+=("TMPDIR=$TMPDIR")
fi
if [[ -n "${LANG:-}" ]]; then
  e2e_env+=("LANG=$LANG")
fi
if [[ -n "${LC_ALL:-}" ]]; then
  e2e_env+=("LC_ALL=$LC_ALL")
fi
if [[ -n "${TZ:-}" ]]; then
  e2e_env+=("TZ=$TZ")
fi
if [[ -n "${E2E_BASE_URL:-}" ]]; then
  e2e_env+=("E2E_BASE_URL=$E2E_BASE_URL")
fi
if [[ -n "$expect_commit" ]]; then
  e2e_env+=("E2E_EXPECT_COMMIT=$expect_commit")
fi
if [[ -n "${E2E_STAGING_READ_ONLY:-}" ]]; then
  e2e_env+=("E2E_STAGING_READ_ONLY=$E2E_STAGING_READ_ONLY")
fi
if [[ -n "${PLAYWRIGHT_BROWSERS_PATH:-}" ]]; then
  e2e_env+=("PLAYWRIGHT_BROWSERS_PATH=$PLAYWRIGHT_BROWSERS_PATH")
fi

run_boundary "E2E前"

echo "[E2E] npm run test:e2e:staging を実行します(トークン値は表示しません)。"
set +e
"${e2e_env[@]}" npm run test:e2e:staging
e2e_status=$?
set -e
if [[ "$e2e_status" -ne 0 ]]; then
  echo "[E2E] 失敗しました(exit ${e2e_status})。公開境界の再確認は続けます。" >&2
else
  echo "[E2E] 成功しました。"
fi

# E2Eが失敗しても、Access境界が維持されているかは必ず再確認する。
boundary_status=0
run_boundary "E2E後" || boundary_status=$?

if [[ "$boundary_status" -ne 0 ]]; then
  echo "公開境界チェック(E2E後)に失敗しました。Access境界が維持されていない可能性があります。" >&2
  if [[ "$e2e_status" -ne 0 ]]; then
    exit "$e2e_status"
  fi
  exit "$boundary_status"
fi
if [[ "$e2e_status" -ne 0 ]]; then
  exit "$e2e_status"
fi

echo "Staging Access E2E 成功: 公開URL E2Eと公開境界(Access維持)を確認しました。"
echo "Access Service Tokenはオーナーが手動で削除してください(このスクリプトは削除しません)。"
