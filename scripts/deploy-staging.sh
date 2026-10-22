#!/usr/bin/env bash
# Stagingを本番・MVPから独立してリリースする(ADR-0005 / ADR-0006)。
#
# 対象commit(引数、省略時はorigin/main)を専用ランタイム($STAGING_RUNTIME_ROOT、既定
# ~/.local/share/mirai-web-cad/staging-runtime)の releases/<sha> へ書き出し、そこで依存導入と
# buildを行う。本番・MVPが使う作業ツリーの git HEAD・.releases/・dist・node_modules には
# 一切触れず、再起動するのもStagingサービスだけである。これにより「Stagingだけを先に
# リリース候補へ更新し、受入確認後にdeploy-local.shで本番へ反映する」順序が取れる。
#
# 手順:
#   1. 対象commitを releases/<sha> へgit archiveし、npm ci --ignore-scripts と
#      BUILD_COMMIT=<sha> npm run build を実行する
#   2. staging.envからDATABASE_URLをsedで1変数だけ取り出し(source禁止・値は非出力)、
#      読み取り専用の npm run db:check を実行する(ここまで失敗しても稼働中は変わらない)
#   3. current symlinkを ln -sfn + mv -Tf で原子的に切り替え、Stagingサービスだけ再起動する
#   4. /api/healthの deploy.distCommit(と、返る場合は deploy.commit)・接続DB名が
#      対象sha・mirai_web_cad_staging と一致するまで検証する
#   5. 手順3以降で失敗したら current を直前の向き先へ戻し、再起動・再検証する(ロールバック)
#   6. 古いreleasesは直近3件とロールバック先を残して削除する
# -E: 関数内の失敗でもERR trap(ロールバック)を働かせる。
set -Eeuo pipefail

ROOT="${DEPLOY_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$ROOT"

runtime_root="${STAGING_RUNTIME_ROOT:-$HOME/.local/share/mirai-web-cad/staging-runtime}"
releases_dir="$runtime_root/releases"
current_link="$runtime_root/current"
env_file="${STAGING_ENV_FILE:-$HOME/.config/mirai-web-cad/staging.env}"
service="${STAGING_SERVICE:-mirai-web-cad-staging.service}"
port="${STAGING_PORT:-18814}"
expected_db="${STAGING_DB_NAME:-mirai_web_cad_staging}"
health_attempts="${STAGING_HEALTH_ATTEMPTS:-30}"
health_interval="${STAGING_HEALTH_INTERVAL:-1}"
health_url="http://127.0.0.1:${port}/api/health"

die() {
  echo "Stagingデプロイを中止します: $*" >&2
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

# currentを原子的に切り替える。rename(同一ディレクトリ内)なので、途中状態は見えない。
switch_current() {
  local target="$1"
  ln -sfn "$target" "$runtime_root/.current.swap"
  mv -Tf "$runtime_root/.current.swap" "$current_link"
}

# currentの向き先(relativeな releases/<sha> を想定)からrelease名を取り出す。
release_sha() {
  local target="$1"
  target="${target%/}"
  printf '%s' "${target##*/}"
}

# releaseディレクトリの dist/build-info.json が記録するbuild元commit。
release_build_commit() {
  local release="$1"
  grep -oE '"commit"[[:space:]]*:[[:space:]]*"[^"]*"' "$release/dist/build-info.json" 2>/dev/null \
    | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/' || true
}

# healthが対象commitを配信しているか。deploy.commitはgit情報を持たないアーカイブ配信では
# 配信物のbuild元へフォールバックする(scripts/serve-production.mjs)ため、存在する場合だけ照合する。
health_matches() {
  local health="$1" expected="$2"
  printf '%s' "$health" | grep -qE '"ok":[[:space:]]*true' || return 1
  printf '%s' "$health" | grep -qE "\"distCommit\":[[:space:]]*\"${expected}\"" || return 1
  if printf '%s' "$health" | grep -qE '"commit":[[:space:]]*"'; then
    printf '%s' "$health" | grep -qE "\"commit\":[[:space:]]*\"${expected}\"" || return 1
  fi
  # 匿名healthはdb.databaseを伏せる(sanitizeProbe)。返ってきた場合だけ一致を必須にする。
  if printf '%s' "$health" | grep -qE '"database":[[:space:]]*"'; then
    printf '%s' "$health" | grep -qE "\"database\":[[:space:]]*\"${expected_db}\"" || return 1
  fi
  return 0
}

verify_health() {
  local expected="$1" health ok=0
  for _ in $(seq 1 "$health_attempts"); do
    # --max-timeがないとhealth待ちがハングし得る(改善台帳P0-86)。
    health="$(curl -fsS --max-time 5 "$health_url" 2>/dev/null || true)"
    if [[ -n "$health" ]] && health_matches "$health" "$expected"; then
      ok=1
      break
    fi
    sleep "$health_interval"
  done
  if [[ "$ok" != "1" ]]; then
    echo "${service}(${port}) のhealthが対象commit ${expected} / DB ${expected_db} と一致しません" >&2
    return 1
  fi
}

[[ $# -le 1 ]] || die "引数は対象commit(省略時は origin/main)の1つだけです。"
target_ref="${1:-origin/main}"

if [[ -n "$(git status --porcelain)" ]]; then
  die "作業ツリーに未コミットの変更があります(デプロイ手順の出所を固定するため)。"
fi

# 対象commitはorigin/mainの最新、または明示したcommit。どちらもoriginの最新を取得してから
# 解決する(明示commitがorigin側にしか無い場合も解決できるようにする)。
git fetch --prune origin || die "originの取得に失敗しました。"
new_sha="$(git rev-parse --verify "${target_ref}^{commit}" 2>/dev/null)" \
  || die "対象commitを解決できません: ${target_ref}"

[[ -r "$env_file" ]] || die "Stagingのenvファイルを読めません: ${env_file}(Human Gate 3)"
staging_database_url="$(read_env_value DATABASE_URL)"
[[ -n "$staging_database_url" ]] || die "${env_file} に DATABASE_URL がありません。"
resolved_db="$(url_database_name "$staging_database_url")"
[[ "$resolved_db" == "$expected_db" ]] \
  || die "staging.env の DATABASE_URL のDB名が ${expected_db} と一致しません(値は表示しません)。"
unset resolved_db

mkdir -p "$releases_dir"
release="$releases_dir/$new_sha"
previous_target="$(readlink "$current_link" 2>/dev/null || true)"
previous_sha=""
if [[ -n "$previous_target" ]]; then
  previous_sha="$(release_sha "$previous_target")"
fi

echo "Stagingデプロイ対象: ${new_sha}"
echo "ランタイム: ${runtime_root} (current: ${previous_sha:-なし})"

# 1. 稼働中のcurrentへ触れずに、対象commitを専用ランタイムへ書き出してbuildする。
#    同じcommitの完全なreleaseが既にあれば再buildしない(再デプロイを高速化する)。
if [[ -f "$release/dist/build-info.json" && "$(release_build_commit "$release")" == "$new_sha" ]]; then
  echo "対象commitのreleaseは構築済みのため再利用します: releases/${new_sha}"
else
  rm -rf "$release.tmp"
  mkdir -p "$release.tmp"
  git archive "$new_sha" | tar -x -C "$release.tmp"
  (
    cd "$release.tmp"
    # ホストでパッケージのinstallスクリプトを実行しない(供給網対策)。
    npm ci --ignore-scripts --no-audit --no-fund
    BUILD_COMMIT="$new_sha" npm run build
  )
  rm -rf "$release"
  mv "$release.tmp" "$release"
fi

# 2. 読み取り専用のDB検証(改善台帳P0-74)。migrationは適用しない。
#    ここで失敗してもcurrentと稼働中サービスは変わらない。値は環境変数でのみ渡す。
(cd "$release" && DATABASE_URL="$staging_database_url" npm run db:check)
unset staging_database_url

# 3. 切替。ここから先の失敗は直前のcurrentへ戻す。
#    初回デプロイ(previousなし)の失敗時は戻し先が無いため、currentを消して停止する。
rollback() {
  set +e
  trap - ERR
  echo "Stagingデプロイに失敗しました。currentを直前の状態へ戻します。" >&2
  if [[ -z "$previous_target" ]]; then
    echo "警告: 初回デプロイのためロールバック先がありません。currentを削除し、Stagingサービスを停止します。" >&2
    rm -f "$current_link"
    sudo systemctl stop "$service" || echo "警告: ${service} を停止できませんでした" >&2
    exit 1
  fi
  if switch_current "$previous_target"; then
    echo "currentを ${previous_sha} へ戻しました。" >&2
  else
    echo "警告: currentを ${previous_sha} へ戻せませんでした。" >&2
  fi
  if ! sudo systemctl restart "$service"; then
    echo "警告: ${service} の再起動に失敗しました。" >&2
  elif verify_health "$previous_sha"; then
    echo "ロールバック完了: ${previous_sha}" >&2
  else
    echo "ロールバック後の確認に失敗しました。docs/runbooks/staging-bringup.md を参照して手動で確認してください。" >&2
  fi
  exit 1
}
trap rollback ERR

switch_current "releases/${new_sha}"
sudo systemctl restart "$service"

# 4. health検証(稼働commit・配信物のbuild元・DB名)。
if ! verify_health "$new_sha"; then
  rollback
fi
trap - ERR

# 5. 古いreleaseの掃除。直近3件と、current・ロールバック先(直前の向き先)は残す。
#    release名はcommit SHAのみだが、find+sortで新しい順に扱い、空白を含む名前でも壊れないようにする。
while IFS= read -r old; do
  [[ -n "$old" ]] || continue
  case "$old" in
    "$new_sha" | "$previous_sha") continue ;;
  esac
  rm -rf "${releases_dir:?}/$old"
done < <(find "$releases_dir" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %f\n' 2>/dev/null \
  | sort -rn | tail -n +4 | cut -d' ' -f2-)
# 中断したbuildの残骸(*.tmp)を片付ける。
find "$releases_dir" -mindepth 1 -maxdepth 1 -name '*.tmp' -exec rm -rf {} + 2>/dev/null || true

echo "Stagingデプロイ成功: ${new_sha}"
