#!/usr/bin/env bash
# mainブランチの最新コミットをこのホストへ反映し、本番(mirai-web-cad.service)とMVP
# (mirai-web-cad-mvp.service、設置されている場合)を再起動する。GitHub Actions(クラウド
# hosted runner)からはこのローカルマシンへ直接到達できないため、人間が手動実行する
# (docs/deployment-local.md参照)。
#
# 両サービスは作業ツリーの dist/ と node_modules/ をそのまま使う。以前は稼働中のツリーで
# npm ci と build を実行していたため、依存が一時的に消え、未検証の画面が先に配信されていた
# (2026-09-25 独立レビュー H-1)。現在は次の順で行う。
#   1. 対象commitを .releases/<sha>/ へ書き出し、そこで依存導入とbuildを行う(稼働中は無変更)
#   2. 本番DB・MVP DBへ読み取り専用の db:check(失敗したら何も切り替えずに中止)
#   3. 作業ツリーをfast-forwardし、dist と node_modules を .releases/<sha>/ へのsymlinkとして
#      一度に切り替える
#   4. 両サービスを再起動し、稼働commitと配信物のbuild元commitが対象commitと一致するか確認
#   5. 失敗したら、作業ツリー・symlinkを直前の状態へ戻して両サービスを再起動する
# -E: 関数内の失敗でもERR trap(ロールバック)を働かせる。
set -Eeuo pipefail
ROOT="${DEPLOY_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$ROOT"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "作業ツリーに未コミットの変更があります。中止します。" >&2
  git status --short >&2
  exit 1
fi

# 再実行時(下記)は、更新前に記録したロールバック先を引き継ぐ。
prev_sha="${DEPLOY_PREV_SHA:-$(git rev-parse HEAD)}"
echo "現在のHEAD: $(git rev-parse HEAD) (ロールバック先: ${prev_sha})"

git fetch --prune origin
if ! git merge-base --is-ancestor HEAD origin/main; then
  echo "origin/mainへfast-forwardできません(ローカルに未pushの差分がある可能性)。中止します。" >&2
  exit 1
fi
new_sha="$(git rev-parse origin/main)"
echo "デプロイ対象: $new_sha"

# このスクリプト自体が更新される場合は、何も変更しないうちに新しい手順で最初からやり直す
# (2026-09-25、db:check切替の初回デプロイで旧手順のdb:verifyが走った事故の再発防止)。
# 再実行は1回だけ。新しい手順が起動できないとロールバックの仕組みごと失われるため、構文を先に確かめる。
if [[ "${DEPLOY_REEXECUTED:-}" != "1" ]] && ! git diff --quiet HEAD "$new_sha" -- scripts/deploy-local.sh; then
  next_script="$(mktemp)"
  git show "$new_sha:scripts/deploy-local.sh" > "$next_script"
  if ! bash -n "$next_script"; then
    echo "更新後のデプロイ手順に構文エラーがあります。何も変更せずに中止します。" >&2
    rm -f "$next_script"
    exit 1
  fi
  echo "デプロイ手順(scripts/deploy-local.sh)が更新されたため、新しい手順で再実行します。"
  DEPLOY_REEXECUTED=1 DEPLOY_PREV_SHA="$prev_sha" DEPLOY_REPO_ROOT="$ROOT" exec bash "$next_script"
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URLが設定されていません。production.envから必要な1変数だけを取り出して渡してください(docs/deployment-local.md)。" >&2
  exit 1
fi

# MVPはユニットが設置されている場合だけ対象にする。接続先は環境ファイルから1変数だけ取り出す
# (JSON値を含む環境ファイルをsourceすると引用符が壊れるため)。
mvp_service="mirai-web-cad-mvp.service"
mvp_enabled=0
if systemctl cat "$mvp_service" >/dev/null 2>&1; then
  mvp_enabled=1
  mvp_env_file="${MVP_ENV_FILE:-$HOME/.config/mirai-web-cad/mvp.env}"
  if [[ -z "${MVP_DATABASE_URL:-}" && -r "$mvp_env_file" ]]; then
    MVP_DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' "$mvp_env_file" | head -n 1)"
  fi
  if [[ -z "${MVP_DATABASE_URL:-}" ]]; then
    echo "${mvp_service} が設置されていますが、MVPのDATABASE_URLを取得できません(${mvp_env_file})。中止します。" >&2
    exit 1
  fi
fi

# 1. 稼働中のツリーに触れずに、対象commitを書き出してbuildする。
releases_dir=".releases"
release_rel="$releases_dir/$new_sha"
mkdir -p "$releases_dir"
rm -rf "$release_rel.tmp"
mkdir -p "$release_rel.tmp"
git archive "$new_sha" | tar -x -C "$release_rel.tmp"
(
  cd "$release_rel.tmp"
  # 本番ホストでパッケージのinstallスクリプトを実行しない(供給網対策)。
  npm ci --ignore-scripts --no-audit --no-fund
  BUILD_COMMIT="$new_sha" npm run build
)
rm -rf "$release_rel"
mv "$release_rel.tmp" "$release_rel"

# 2. 本番DB・MVP DBへ読み取り専用の検証(改善台帳P0-74)。migrationは適用しないため、
#    migrationを含むリリースは手順書「Migrationを含むリリース」に従って先に適用しておく。
#    ここで失敗しても、稼働中の作業ツリーは何も変わっていない。
(cd "$release_rel" && npm run db:check)
if [[ "$mvp_enabled" == "1" ]]; then
  (cd "$release_rel" && DATABASE_URL="$MVP_DATABASE_URL" npm run db:check)
fi

# 3. 切り替え。以降に失敗した場合はrollbackで直前の状態へ戻す。
# 現在の向き先を記録する。symlinkでなく実体のディレクトリ(初回のみ)の場合は、退避先を向き先とする。
link_target() {
  local name="$1"
  if [[ -L "$name" ]]; then
    readlink "$name"
  elif [[ -e "$name" ]]; then
    echo "$releases_dir/legacy-${prev_sha}/$name"
  else
    echo ""
  fi
}
# symlinkの向き先を一度の操作(rename)で切り替える。実体のディレクトリは退避してからsymlinkにする。
point_to() {
  local name="$1" target="$2"
  if [[ -e "$name" && ! -L "$name" ]]; then
    mkdir -p "$releases_dir/legacy-${prev_sha}"
    rm -rf "$releases_dir/legacy-${prev_sha}/$name"
    mv "$name" "$releases_dir/legacy-${prev_sha}/$name"
  fi
  ln -sfn "$target" ".swap-$name"
  mv -Tf ".swap-$name" "$name"
}

prev_dist="$(link_target dist)"
prev_modules="$(link_target node_modules)"
services=("mirai-web-cad.service:${PORT:-18812}")
if [[ "$mvp_enabled" == "1" ]]; then
  services+=("${mvp_service}:${MVP_PORT:-18813}")
fi

# 稼働中のプロセスが、指定commitのサーバーコードと配信物を使っているかを確認する。
verify_services() {
  local expected="$1" entry service port health ok
  for entry in "${services[@]}"; do
    service="${entry%%:*}"
    port="${entry##*:}"
    ok=0
    for _ in $(seq 1 30); do
      # --max-timeなしでhealthループがハングし得るため(改善台帳P0-86)、タイムアウトを必須にする。
      health="$(curl -fsS --max-time 5 "http://127.0.0.1:${port}/api/health" 2>/dev/null || true)"
      if printf '%s' "$health" | grep -qE '"ok":[[:space:]]*true' \
        && printf '%s' "$health" | grep -qE "\"commit\":[[:space:]]*\"${expected}\"" \
        && printf '%s' "$health" | grep -qE "\"distCommit\":[[:space:]]*\"${expected}\""; then
        ok=1
        break
      fi
      sleep 1
    done
    if [[ "$ok" != "1" ]]; then
      echo "${service}(${port}) のhealth・稼働commit・配信物のbuild元が ${expected} と一致しません" >&2
      return 1
    fi
  done
}

restart_services() {
  local entry status=0
  for entry in "${services[@]}"; do
    sudo systemctl restart "${entry%%:*}" || status=1
  done
  return "$status"
}

rollback() {
  # ロールバック中は途中の失敗で止めず、各手順の結果を報告しながら最後まで実行する。
  set +e
  trap - ERR
  echo "デプロイに失敗しました。${prev_sha} へロールバックします。" >&2
  git checkout --quiet "$prev_sha" || echo "警告: 作業ツリーを ${prev_sha} へ戻せませんでした" >&2
  if [[ -n "$prev_dist" ]]; then point_to dist "$prev_dist" || echo "警告: dist を戻せませんでした" >&2; fi
  if [[ -n "$prev_modules" ]]; then point_to node_modules "$prev_modules" || echo "警告: node_modules を戻せませんでした" >&2; fi
  restart_services || echo "警告: サービスの再起動に失敗しました" >&2
  if verify_services "$prev_sha"; then
    echo "ロールバック完了: $prev_sha" >&2
  else
    echo "ロールバック後の確認に失敗しました。docs/runbooks/owner-absence-rollback.md に従い手動で確認してください。" >&2
  fi
  exit 1
}
trap rollback ERR

git merge --ff-only "$new_sha"
point_to node_modules "$release_rel/node_modules"
point_to dist "$release_rel/dist"

# 4. 両サービスを再起動して確認する。
restart_services
trap - ERR
if ! verify_services "$new_sha"; then
  rollback
fi

# 古いリリースを片付ける(直近3件と、今回・直前の向き先は残す)。
for old in $(ls -1t "$releases_dir" 2>/dev/null | tail -n +4); do
  case "$releases_dir/$old/dist" in
    "$release_rel/dist" | "$prev_dist") continue ;;
  esac
  rm -rf "${releases_dir:?}/$old"
done

echo "デプロイ成功: $new_sha"
