#!/usr/bin/env bash
# mainブランチの最新コミットをこのホストへ反映し、mirai-web-cad.serviceを
# 再起動する。GitHub Actions(クラウドhosted runner)からはこのローカル
# マシンへ直接到達できないため、当面は人間がこのスクリプトを手動実行する
# (docs/operations.md参照)。失敗時は直前のコミットへ自動ロールバックする。
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -n "$(git status --porcelain)" ]]; then
  echo "作業ツリーに未コミットの変更があります。中止します。" >&2
  git status --short >&2
  exit 1
fi

prev_sha="$(git rev-parse HEAD)"
echo "現在のHEAD: $prev_sha"

git fetch --prune origin
if ! git merge --ff-only origin/main; then
  echo "origin/mainへfast-forwardできません(ローカルに未pushの差分がある可能性)。中止します。" >&2
  exit 1
fi
new_sha="$(git rev-parse HEAD)"
echo "デプロイ対象: $new_sha"

rollback() {
  echo "デプロイに失敗しました。${prev_sha} へロールバックします。" >&2
  git checkout --quiet "$prev_sha"
  npm ci --silent
  npm run build --silent
  sudo systemctl restart mirai-web-cad.service
  echo "ロールバック完了: $prev_sha" >&2
  exit 1
}
trap rollback ERR

npm ci
npm run build

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URLが設定されていません。~/.config/mirai-web-cad/production.envをsourceしてください。" >&2
  exit 1
fi
# 本番DBへは書き込まず、migration適用済みであることだけを検証する(改善台帳P0-74)。
# db:verifyはmigration+seeds/demo.sqlを毎回適用し、デモ行投入・dwg_demo_001の上書き・
# 監査トリガの再作成を本番DBへ起こすため、デプロイでは実行しない。migrationを含む
# リリースは、デプロイ前に手順書「Migrationを含むリリース」に従って適用しておくこと。
# 未適用ならdb:checkがexit 1で失敗し、ERR trapで直前のcommitへロールバックする。
npm run db:check

sudo systemctl restart mirai-web-cad.service

echo "health checkと稼働commit確認の待機中..."
ok=0
for _ in $(seq 1 30); do
  # --max-timeなしでhealthループがハングし得るため(改善台帳P0-86)、タイムアウトを必須にする。
  health="$(curl -fsS --max-time 5 "http://127.0.0.1:${PORT:-18812}/api/health" 2>/dev/null || true)"
  if printf '%s' "$health" | grep -qE '"ok":[[:space:]]*true'; then
    # healthがokでも、応答しているプロセスが今回のデプロイ対象commitを読み込んでいるとは限らない。
    # 再起動漏れ・別プロセスの応答・未レビューコードの稼働(Issue #98)をここで検出する。
    if printf '%s' "$health" | grep -qE "\"commit\":[[:space:]]*\"${new_sha}\""; then
      ok=1
      break
    fi
    echo "healthはokだが稼働commitが ${new_sha} と一致しない" >&2
  fi
  sleep 1
done

trap - ERR
if [[ "$ok" != "1" ]]; then
  rollback
fi

echo "デプロイ成功: $new_sha"
