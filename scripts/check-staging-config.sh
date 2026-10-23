#!/usr/bin/env bash
# Staging構成(ADR-0005)の静的検査。クラウド資格情報・ネットワークへ一切触れず、
# リポジトリ内のファイルだけを検査する。CIジョブ「Staging Configuration」から呼ばれる。
# 検査対象は次の5点。
#   (a) 期待するstaging systemd unitが存在し、空でないこと
#   (b) 関連シェルスクリプトの構文(bash -n)はCI側のステップで検査する
#       (deploy-staging.shはこのスクリプト内でもbash -nする)
#   (c) 各unitが必須ディレクティブ(staging env・PORT/LOCAL_URL・OnFailure 等)を持つこと
#   (d) deploy-staging.shが存在し実行可能で、独立ランタイム(~/.local/share/mirai-web-cad/
#       staging-runtime)の releases/<sha> へ構築し、current symlinkを原子切替する方式であること
#   (e) stagingが本番専用の経路へ配線されておらず、本番デプロイ(deploy-local.sh)が
#       stagingへ触れないこと
#   (f) 構築後/構築中の繰り返し検証ツール(check-staging-readiness.sh・verify-staging-domain.mjs・
#       test:e2e:staging)がリポジトリ内に存在し、空でないこと
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0
fail_msg() { echo "Staging構成検査 FAILED: $*" >&2; fail=1; }

# 行の存在を確認する(見つからなければ失敗を記録する)。
require_line() {
  local file="$1" pattern="$2" description="$3"
  grep -Eq "$pattern" "$file" || fail_msg "$file に $description がありません(パターン: $pattern)"
}
# 行が存在しないことを確認する(見つかれば失敗を記録する)。
# ifの条件式はset -eの対象外なので、不一致(exit 1)でスクリプトが止まることはない。
require_absent() {
  local file="$1" pattern="$2" description="$3"
  if grep -Eq "$pattern" "$file"; then
    fail_msg "$file に $description が含まれています(パターン: $pattern)"
  fi
}

# (a) 期待するstaging unit(ADR-0005 §2/§5)。存在し、かつ空でないことを確認する。
staging_units=(
  deploy/systemd/mirai-web-cad-staging.service
  deploy/systemd/mirai-web-cad-staging-backup.service
  deploy/systemd/mirai-web-cad-staging-backup.timer
  deploy/systemd/mirai-web-cad-staging-backup-check.service
  deploy/systemd/mirai-web-cad-staging-backup-check.timer
  deploy/systemd/mirai-web-cad-staging-monitor.service
  deploy/systemd/mirai-web-cad-staging-monitor.timer
  deploy/systemd/mirai-web-cad-staging-restore-drill.service
  deploy/systemd/mirai-web-cad-staging-restore-drill.timer
)
for unit in "${staging_units[@]}"; do
  [[ -s "$unit" ]] || fail_msg "unitが存在しないか空です: $unit"
done

# (c) 必須ディレクティブ。unitファイルに期待する値を1行単位で確認する。

# 常駐サービス: staging専用env・専用ランタイムのcurrent・ポート18814を参照する。
svc=deploy/systemd/mirai-web-cad-staging.service
require_line "$svc" '^\[Service\]$' '[Service]セクション'
require_line "$svc" '^EnvironmentFile=/home/kensan/\.config/mirai-web-cad/staging\.env$' 'staging.env の EnvironmentFile='
# 独立リリース: 本番ツリーを共有せず、deploy-staging.shが切り替えるcurrentから配信する。
require_line "$svc" '^WorkingDirectory=/home/kensan/\.local/share/mirai-web-cad/staging-runtime/current$' '独立ランタイムの WorkingDirectory='
require_line "$svc" '^ExecStart=.*scripts/serve-production\.mjs$' 'scripts/serve-production.mjs を指す ExecStart='
require_line "$svc" '^Environment=PORT=18814$' 'PORT=18814'
require_line "$svc" '^Restart=on-failure$' 'Restart=on-failure'
require_line "$svc" '^WantedBy=multi-user\.target$' 'WantedBy=multi-user.target'

# 健全性監視: stagingのローカルURL・期待DB名・健全性スクリプト。
mon=deploy/systemd/mirai-web-cad-staging-monitor.service
require_line "$mon" '^\[Service\]$' '[Service]セクション'
require_line "$mon" '^EnvironmentFile=/home/kensan/\.config/mirai-web-cad/staging\.env$' 'staging.env の EnvironmentFile='
require_line "$mon" '^Environment=LOCAL_URL=http://127\.0\.0\.1:18814$' 'LOCAL_URL=http://127.0.0.1:18814'
require_line "$mon" '^Environment=EXPECTED_DATABASE=mirai_web_cad_staging$' 'EXPECTED_DATABASE=mirai_web_cad_staging'
require_line "$mon" '^ExecStart=/usr/bin/bash scripts/check-staging-health\.sh$' 'check-staging-health.sh の ExecStart='

# バックアップ: staging専用env・保存先・期待DB名。
bkp=deploy/systemd/mirai-web-cad-staging-backup.service
require_line "$bkp" '^\[Service\]$' '[Service]セクション'
require_line "$bkp" '^EnvironmentFile=/home/kensan/\.config/mirai-web-cad/staging-backup\.env$' 'staging-backup.env の EnvironmentFile='
require_line "$bkp" '^Environment=BACKUP_DIR=/var/backups/mirai-web-cad/staging-postgres$' 'staging-postgres の BACKUP_DIR='
require_line "$bkp" '^Environment=EXPECTED_DATABASE=mirai_web_cad_staging$' 'EXPECTED_DATABASE=mirai_web_cad_staging'

# 鮮度検査(本番・MVPと同じくoneshotで、EnvironmentFile=は持たない)。
bchk=deploy/systemd/mirai-web-cad-staging-backup-check.service
require_line "$bchk" '^\[Service\]$' '[Service]セクション'
require_line "$bchk" '^Environment=BACKUP_DIR=/var/backups/mirai-web-cad/staging-postgres$' 'staging-postgres の BACKUP_DIR='
require_line "$bchk" '^Environment=EXPECTED_DATABASE=mirai_web_cad_staging$' 'EXPECTED_DATABASE=mirai_web_cad_staging'

# 復元ドリル: 隔離DB名(EXPECTED_RESTORE_DATABASE)と復元元DB名。
rd=deploy/systemd/mirai-web-cad-staging-restore-drill.service
require_line "$rd" '^\[Service\]$' '[Service]セクション'
require_line "$rd" '^EnvironmentFile=/home/kensan/\.config/mirai-web-cad/staging-backup\.env$' 'staging-backup.env の EnvironmentFile='
require_line "$rd" '^Environment=EXPECTED_RESTORE_DATABASE=mirai_web_cad_staging_recovery$' 'EXPECTED_RESTORE_DATABASE=mirai_web_cad_staging_recovery'
require_line "$rd" '^Environment=EXPECTED_DATABASE=mirai_web_cad_staging$' 'EXPECTED_DATABASE=mirai_web_cad_staging'

# 定期ジョブ(oneshot)は失敗時にGitHub Issue通知へ接続する(ADR-0005 §5)。
# 常駐サービス(staging.service)は本番・MVPと同じくRestart=on-failureで扱うため対象外。
# あわせて、定期ジョブも本番worktreeではなく独立ランタイムのcurrentからscripts/を読む
# ことを検査する(ADR-0006。本番ツリー更新に依存させない)。
for f in "$bkp" "$bchk" "$mon" "$rd"; do
  require_line "$f" '^OnFailure=mirai-web-cad-notify-failure@%n\.service$' 'OnFailure=mirai-web-cad-notify-failure@%n.service'
  require_line "$f" '^WorkingDirectory=/home/kensan/\.local/share/mirai-web-cad/staging-runtime/current$' '独立ランタイムの WorkingDirectory='
done

# 各timerは[Timer]で起動契機を持ち、timers.targetへ接続する。
for t in deploy/systemd/mirai-web-cad-staging-backup.timer \
  deploy/systemd/mirai-web-cad-staging-backup-check.timer \
  deploy/systemd/mirai-web-cad-staging-monitor.timer \
  deploy/systemd/mirai-web-cad-staging-restore-drill.timer; do
  require_line "$t" '^\[Timer\]$' '[Timer]セクション'
  require_line "$t" '^(OnCalendar|OnUnitActiveSec)=' '起動契機(OnCalendar= または OnUnitActiveSec=)'
  require_line "$t" '^Persistent=true$' 'Persistent=true'
  require_line "$t" '^WantedBy=timers\.target$' 'WantedBy=timers.target'
done

# (d) Stagingの独立リリース(deploy-staging.sh)。本番のdeploy-local.shとは別の経路で、
#     専用ランタイムの releases/<sha> を構築し、current symlinkを原子的に切り替える。
deploy_staging=scripts/deploy-staging.sh
[[ -x "$deploy_staging" ]] || fail_msg "実行可能なデプロイスクリプトがありません: $deploy_staging"
if ! bash -n "$deploy_staging"; then
  fail_msg "$deploy_staging に構文エラーがあります"
fi
require_line "$deploy_staging" 'staging-runtime' '専用ランタイム(staging-runtime)の参照'
require_line "$deploy_staging" 'releases/' 'releases/<sha> 方式'
require_line "$deploy_staging" 'git archive' 'git archiveによる対象commitの書き出し'
require_line "$deploy_staging" 'npm ci --ignore-scripts' 'npm ci --ignore-scripts'
require_line "$deploy_staging" 'BUILD_COMMIT=' 'BUILD_COMMITの付与'
require_line "$deploy_staging" 'npm run db:check' '読み取り専用のdb:check'
require_line "$deploy_staging" 'ln -sfn' 'current symlinkの作成(ln -sfn)'
require_line "$deploy_staging" 'mv -Tf' 'current symlinkの原子切替(mv -Tf)'
require_line "$deploy_staging" 'mirai-web-cad-staging\.service' '再起動対象のStagingサービス'
require_line "$deploy_staging" '18814|STAGING_PORT' 'Stagingポート18814の参照'
require_line "$deploy_staging" 'mirai_web_cad_staging' '期待するStaging DB名'
# Staging DB名はenv(staging.env)から解決しつつ、Staging配備面全体で定義が揃っていることを確認する。
if ! grep -q 'mirai_web_cad_staging' \
  "$deploy_staging" \
  deploy/systemd/mirai-web-cad-staging.service \
  deploy/systemd/mirai-web-cad-staging-monitor.service \
  scripts/check-staging-health.sh; then
  fail_msg 'Staging DB名 mirai_web_cad_staging がstaging配備面(deploy-staging.sh/unit/健全性スクリプト)で参照されていません'
fi

# (e) stagingを本番専用の経路へ配線していないこと(ADR-0005 §3)。
# 1. staging unitは本番・MVPのenvファイルを参照しない(自前のstaging.env系のみ)。
for f in "${staging_units[@]}"; do
  require_absent "$f" '(production\.env|mvp\.env|mvp-backup\.env)' '本番/MVPのenvファイル参照'
done
# 2. staging unitは本番・MVPのポート(18812/18813)を参照しない。
for f in "${staging_units[@]}"; do
  require_absent "$f" '(18812|18813)' '本番/MVPのポート参照'
done
# 3. staging unitは本番・MVPのDB名を参照しない。\bにより mirai_web_cad_staging 系は一致しない。
for f in "${staging_units[@]}"; do
  require_absent "$f" '\bmirai_web_cad\b' '本番DB名 mirai_web_cad の参照'
  require_absent "$f" 'mirai_web_cad_mvp' 'MVP DB名 mirai_web_cad_mvp の参照'
done
# 4. 本番専用のオフサイト転送(ADR-0005 §3.5ではstagingを当面含めない)へ配線しない。
require_absent deploy/systemd/mirai-web-cad-offsite-backup.service 'staging' 'Stagingのオフサイト転送への組み込み'
# 5. 本番サービスunitはstagingを参照しない。
require_absent deploy/systemd/mirai-web-cad.service 'staging' '本番サービスunitからのStaging参照'
# 6. 本番デプロイ(deploy-local.sh)はStagingに触れない。Stagingはdeploy-staging.shだけが更新する。
require_absent scripts/deploy-local.sh 'mirai-web-cad-staging\.service' '本番デプロイからのStagingサービス参照'
require_absent scripts/deploy-local.sh '18814' '本番デプロイからのStagingポート参照'
require_absent scripts/deploy-local.sh 'staging\.env|STAGING_' '本番デプロイからのStaging env参照'

# (f) 構築後/構築中の繰り返し検証ツールがリポジトリ内に存在し、空でないこと。
# Readinessチェッカーと公開URL E2Eは、ホスト反映後の疎通確認で使う(staging-bringup.md §12)。
for f in scripts/check-staging-readiness.sh scripts/verify-staging-domain.mjs; do
  [[ -s "$f" ]] || fail_msg "検証ツールが存在しないか空です: $f"
done
# 公開URL E2Eをnpmスクリプトから実行できること。
require_line package.json 'test:e2e:staging' 'test:e2e:staging スクリプト'

if [[ "$fail" -ne 0 ]]; then
  echo "Staging構成検査: 失敗があります。" >&2
  exit 1
fi
echo "Staging構成検査 ok: unit 9件・必須ディレクティブ・deploy-staging.shの独立ランタイム方式・本番経路との非配線を確認しました。"
