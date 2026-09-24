# 運用・復旧メモ

## ローカル開発

```bash
npm run dev
```

`npm run dev`は`0.0.0.0:4174`で待ち受け、起動時に`Local` URLと端末へ自動割当された`Network (インターフェース名)` URLを表示します。同一LAN上の端末は後者を使用します。Docker bridge、veth、リンクローカルIPv4は表示対象から除外されます。LAN公開が不要な場合は`HOST=127.0.0.1 npm run dev`で制限してください。SPAと`/api`は同一オリジンです。ブラウザ保存はLocalStorageです。破損時は画面左ツールの「デモ初期化」またはブラウザDevToolsで`mirai-web-cad-mvp`キーを削除します。既定ではメモリストア(`env.DATABASE_URL`は無視)です。ローカルPostgreSQLへ接続して確認したい場合は`LOCAL_DB=1`を明示してください。

```bash
LOCAL_DB=1 DATABASE_URL="postgresql://mirai_web_cad_app:...@127.0.0.1:5432/mirai_web_cad" npm run dev
```

## Build

```bash
npm run build
```

`dist/`は静的配信用成果物です。本番は`scripts/serve-production.mjs`がこの`dist/`と`_headers`を配信します(下記「本番アーキテクチャ」参照)。

Cloudflare Pages Functions互換性の参考確認(ロールバック手段としてPages関連ファイルを当面残しているため):

```bash
npm run build
wrangler pages dev dist --port=4176
curl http://127.0.0.1:4176/api/health
```

## 本番アーキテクチャ(2026-08-30〜)

2026-08-30に、本番の永続化先をNeon PostgreSQLからローカルPostgreSQL + Cloudflare Tunnelへ移行しました(ユーザー指示「Neonは今後2度と利用しない」、Issue #22)。

```
Cloudflare Tunnel(mirai-web-cad-cloudflared.service)
  → mirai-web-cad-mvp.mirai-dx-platform.com
  → http://127.0.0.1:18813 (mirai-web-cad-mvp.service)
  → ローカルPostgreSQL 16(127.0.0.1:5432, DB=mirai_web_cad_mvp)

Cloudflare Tunnel(mirai-web-cad-cloudflared.service)
  → mirai-web-cad.mirai-dx-platform.com
  → http://127.0.0.1:18812 (mirai-web-cad.service, scripts/serve-production.mjs)
  → ローカルPostgreSQL 16(127.0.0.1:5432, DB=mirai_web_cad)
```

セットアップ手順、systemdユニット一覧、日常運用(デプロイ・バックアップ・ログ確認・ロールバック)は[ローカルデプロイ運用メモ](deployment-local.md)を参照してください。

Cloudflare設定は`infra/cloudflare/`にTerraform v5構成を置き、既存資源のimport-firstで管理する。誤削除防止、MVP許可メールの完全一致制約、広範囲なAccessルールの静的検査を持つ。現行API tokenはverify成功だがDNS APIが403、Access Application一覧が0件のため、実資源のimport/applyは保留中。外部入力の実測状況は[確定待ち台帳](external-input-status.md)、手順は[Cloudflare Terraform](../infra/cloudflare/README.md)を参照。

障害時は次のRunbookを使用する。

- [サービス停止](runbooks/service-outage.md)
- [Cloudflare Access変更](runbooks/cloudflare-access-change.md)
- [PostgreSQL障害](runbooks/database-incident.md)

MVP URLはサイト全体をCloudflare Accessで保護し、`kensan1969@gmail.com`だけを許可する。本番の公開デモ用bypass policyはMVPへ引き継がない。MVPと本番は同じソースとTunnelを使うが、待受ポート、環境ファイル、PostgreSQLデータベース、バックアップ保存先を分離する。`mirai-web-cad-mvp-monitor.timer`は15分ごとにローカルAPI、DB名、公開URLのAccess 302境界を検証する。`mirai-web-cad-mvp-restore-drill.timer`は毎週、最新バックアップを専用の隔離DBへ復元する。

Cloudflare Pages(`functions/api/`、`wrangler.toml`)はロールバック手段として当面残置していますが、`main`へのマージでは自動デプロイされません(`.github/workflows/production.yml`のdeployジョブは削除済み、`CLOUDFLARE_DEPLOY_ENABLED`変数もPR Preview用途にのみ影響します)。

## ローカルPostgreSQL初期化

```bash
DATABASE_URL="postgresql://mirai_web_cad_app:...@127.0.0.1:5432/mirai_web_cad" npm run db:verify
```

注意:

- 既存データがあるDBへ適用する前に検証用DBへ適用します
- 既存本番データ削除は行いません
- migrationは`create table if not exists`中心、Seedは`on conflict do nothing`で、既存業務データを上書きしません

### DBの状態だけを確認する(読み取り専用)

```bash
DATABASE_URL="postgresql://mirai_web_cad_app:...@127.0.0.1:5432/mirai_web_cad" npm run db:check
```

`db:check`は**書き込みを一切行わず**、migration 0001〜0008が作る9テーブル、`drawings.revision`/`drawings.visibility`/`projects.access_scope`列、監査の追記専用トリガ**3件**(UPDATE/DELETE/TRUNCATE)と各操作の拒否(検査はROLLBACK)、JSONB string scalarが0件であることを確認します。未適用があれば欠落を列挙して**終了コード1**で失敗します。

実測(2026-09-18): migration適用済DBで`db:check`実行前後の行数と`content_hash`のmd5が完全一致(書き込みゼロ)。空DBでは欠落テーブル・列を列挙してexit 1。

### 監査ログの追記専用保護と所有権分離(P0-78)

`audit_logs`は`migration 0005`(UPDATE/DELETE拒否)と`0008`(TRUNCATE拒否)のDBトリガで保護されています。**トリガはロールを問わず発火する**ため、スーパーユーザでの`truncate`/`update`/`delete`も拒否されることを実測確認済みです。

ただし所有者は`alter table ... disable trigger`や`drop trigger`を実行できるため、トリガだけではDDLを防げません。現在は`create database ... owner mirai_web_cad_app`のためアプリ用ロールが所有者でもあり、ここが残余リスクです(`db:check`は所有者が接続ロールと同一の場合に**警告**を出力します。失敗にはしません)。

所有権を分離する場合、DB管理者が次を一度だけ実行します。

```bash
sudo -u postgres psql -d mirai_web_cad \
  -v app_role=mirai_web_cad_app \
  -v owner_role=mirai_web_cad_audit_owner \
  -f scripts/sql/harden-audit-role.sql
```

実測した効果(2026-09-18、検証用DB):

| 接続ロール | TRUNCATE | UPDATE | DELETE | SELECT | INSERT |
| --- | --- | --- | --- | --- | --- |
| アプリ用ロール(所有者) | トリガで拒否 | トリガで拒否 | トリガで拒否 | 可 | 可 |
| アプリ用ロール(非所有者、SELECT/INSERTのみ) | 権限で拒否 | 権限で拒否 | 権限で拒否 | 可 | 可 |

> [!IMPORTANT]
> 所有権を分離した後は、`db:verify`(migration適用)を**アプリ用ロールで実行できません**(`must be owner of table audit_logs`で失敗します。実測確認済み)。migration適用は所有者ロールまたは管理者で実行してください。`db:check`はどちらの構成でも正常に動作します。

> [!NOTE]
> `db:verify`(migration+`seeds/demo.sql`適用)をデプロイのたびに本番DBへ実行すると、デモ行の投入、`0004`による`dwg_demo_001`の`name`上書きと`visibility='public'`強制、`0006`による監査トリガのdrop→UPDATE→再作成が毎回発生します(2026-09-18の独立監査で指摘、改善台帳P0-74)。`db:check`はこの問題に対する**読み取り専用の代替**として追加し、2026-09-25にデプロイ手順(`scripts/deploy-local.sh`)を`db:check`へ切り替えました。migrationを含むリリースの適用手順は[ローカルデプロイ運用メモ](deployment-local.md)の「Migrationを含むリリース」を参照してください。

## リリース判定基準

**`CI`ワークフロー(pull_request/push時のLint/Test/Build/E2E/A11y等)の成功は「コード品質が基準を満たしている」ことのみを保証し、「本番が正常稼働している」ことは保証しません。** CIはephemeralなPostgreSQLコンテナを使うため、実際の本番DB接続の健全性は検証できません(2026-08-29のIssue #22はこの盲点で発生し、CI全green後もNeon資格情報の不整合で本番APIが500になり続けました。移行後の現在もこの原則自体は変わりません)。

本番の正常稼働は、必ず以下を**すべて**満たした場合にのみ判定してください。手動での`/api/health`確認は判定条件の代替にはなりません(health 1エンドポイントだけではSPA表示、公開デモ、書込みfail-closedの回帰を検出できないため)。

1. `mirai-web-cad.service`が`journalctl -u mirai-web-cad -n 20`でエラーなく稼働していること、かつ`scripts/deploy-local.sh`(または手動デプロイ)実行時のhealth確認(`curl -fsS http://127.0.0.1:18812/api/health`)が成功していること
2. `Synthetic Monitor`ワークフロー(`.github/workflows/synthetic-monitor.yml`、15分間隔)の**`main`ブランチの定期実行(`schedule`)が直近で成功しており、かつ実行時刻が現在から1時間以内**であること。`workflow_dispatch`による他ブランチの手動実行はこの判定に含めない(`gh run list --workflow=synthetic-monitor.yml --branch main --event schedule --limit 1 --json conclusion,createdAt,headBranch,event`で`conclusion=success`かつ`headBranch=main`を確認)。`schedule`はGitHub側の負荷で遅延・間引かれることがあるため、実行自体が止まっていないかをこの時刻で確認する
3. 上記2の直近成功実行が`incident`ラベルの未解決Issueを起票していないこと(`gh issue list --label incident --state open`で確認)。2を満たさずに3だけを確認しても、監視が止まっている間の障害を見逃す

「mainへのマージが成功した」「CIが緑だった」「healthが200だった」のいずれか単独をもって本番正常と報告しないでください。

## デプロイ素性(稼働commit)と乖離検知

### 何が起きたか

2026-09-18、本番ホストのチェックアウトでローカル`main`がGitHub `main`より4コミット先行し、**未レビューのPR #87(`feat/native-dimension-hatch-viewport`)のコードが本番で稼働している**状態が、人手の調査で初めて判明しました(Issue #98 / [改善台帳P0-58](improvement-register.md))。`branch protection`の`required_conversation_resolution`によりPR #87は正規手順ではマージできない状態のまま、セキュリティ修正を届けるためにローカルでのみ`git merge --no-ff`が行われていました。

原因は「本番が今どのコミットで動いているか」を記録・比較する仕組みが無く、確認が人の記憶と目視に依存していたことです。

### 運用ルール(必須)

- **本番ホストのチェックアウトへ直接コミットしない。** 変更は必ずPR経由でGitHub `main`へ入れ、本番は`scripts/deploy-local.sh`の`git merge --ff-only origin/main`だけで更新する。
- 本番ホストのローカル`main`を先行させない。`ff-only`が失敗した場合は、回避策を探すのではなく分岐の原因を解消する(Issue #98と同じ判断を繰り返さない)。
- やむを得ず暫定措置を取る場合は、Issue起票・コミットメッセージへの理由記載・解消期限の3点を同時に残す。

### 検知の仕組み

`GET /api/health`は稼働中のコミットを`deploy`ブロックで返します(公開リポジトリのcommit/branchのみ。パス・資格情報・環境変数の値は含みません)。

```json
"deploy": { "commit": "89a25fe...", "branch": "main", "dirty": false }
```

`scripts/check-deploy-drift.mjs`は、作業ツリーのcommit・`origin/main`・(指定時は)稼働APIの報告値を突き合わせて判定します。

```bash
npm run deploy:drift                    # 作業ツリーのみ(どこでも実行可)
npm run deploy:drift:live               # 稼働API(http://127.0.0.1:18812)も突き合わせる
npm run deploy:drift:live -- --json     # 機械可読
node scripts/check-deploy-drift.mjs --url http://127.0.0.1:18812 --remote
```

- **デプロイ後の必須確認は`deploy:drift:live`**です。`deploy:drift`は作業ツリーしか見ないため、再起動漏れ(プロセスが古いコードのまま)を検出できません。
- `--url`を指定したのに稼働APIから`deploy.commit`を取得できない場合は「判定不能」として扱います。**比較できないことを「一致」とは報告しません。**
- `--remote`は`git ls-remote`でリモートの`main`を確認します。リモートが進んでいるだけ(ローカルrefが古い)の場合は情報提供に留め、失敗扱いにしません。

判定と終了コード:

| 判定 | 意味 | 終了コード |
| --- | --- | --- |
| `verified` | `origin/main`と一致し、未コミット変更もない | 0 |
| `behind` | 本番が`origin/main`より遅れている(デプロイ待ち) | 0 |
| `ahead` | `origin/main`に無いコミットが稼働している(**未レビューコード**) | 1 |
| `dirty` | 未コミット変更が混ざった状態で稼働している | 1 |
| (乖離要因あり) | 稼働APIのcommit不一致など。`--json`の`ok`が`false` | 1 |
| `unknown` | `origin/main`未取得・稼働commit取得失敗など、**判定できない** | 2 |

`scripts/deploy-local.sh`も、health確認時に稼働APIが報告する`deploy.commit`が今回のデプロイ対象`$new_sha`と一致することを必須とし、一致しない場合は自動ロールバックします。

定期実行用に`deploy/systemd/mirai-web-cad-deploy-drift.service`と`.timer`(30分間隔)を用意しています。配置手順は[ローカルデプロイ運用メモ](deployment-local.md)の「systemdユニット配置」と同じです。乖離時はユニットが失敗し、journalに理由が残ります(通知連携はIssue #8)。

### 起動時のガード(任意)

`scripts/serve-production.mjs`は起動時に同じ判定を行い、乖離があれば`error`ログを出します。既定は可用性優先で**起動を継続**します。乖離状態での起動そのものを拒否したい場合は、本番の環境変数ファイルに`DEPLOY_GUARD=strict`を追加して再起動してください(`strict`では`origin/main`に無いコミットが稼働している状態での起動を拒否します)。有効化する前に`npm run deploy:drift`が`verified`を返すことを確認してください。

## Rollback

本番はこのホスト(kensan1969)上のsystemdサービスです。ロールバック手順:

```bash
git checkout <直前の正常コミットSHA>
npm ci && npm run build
sudo systemctl restart mirai-web-cad.service
curl -fsS http://127.0.0.1:18812/api/health
```

`scripts/deploy-local.sh`はhealth確認に失敗すると直前コミットへ自動ロールバックします。DB migrationは破壊的変更を含めていないため、ロールバック時も既存テーブルを削除しません。

Cloudflare Tunnel/DNS自体に問題がある場合(Tunnel停止、証明書失効等)は、Cloudflare Pages Custom Domainを再アタッチして`mirai-web-cad.pages.dev`相当の配信へ一時的に切り戻せます(Pagesプロジェクト・`functions/`・`wrangler.toml`はこのためにロールバック手段として残置しています)。

ただしPages側は**「移行前のコード」ではありません**(2026-09-18に実測して訂正)。`functions/api/[[path]].js`が現行の`src/api-handler.js`を読み込むため、`/api`は現行コードで動作します。接続先が失効済みのNeonを指しているため、実測では`GET /api/health`が500を返して図面データは取得できません。SPA表示のみの緊急避難的な切り戻しであり、APIの代替にはなりません。

なおPages(preview含む)はCloudflare Accessの外側の公開オリジンであるため、本リポジトリでは`functions/api/[[path]].js`が`AUTH_MODE=access`以外を503で拒否するようにし、`wrangler.toml`にも`AUTH_MODE = "access"`を明示しています。`wrangler.toml`の設定が反映されている環境では通常のaccess判定(未認証401、DB接続不可500など)が行われ、503はダッシュボード側の設定漏れでdemoモードになり得る場合のガードとして働きます。5xxの内部エラー詳細も、ローカルdemoモード以外では応答へ含めません(2026-09-18の実測では、Pagesが内部のDB接続ユーザー名を未認証で返していました)。

## 監査ログの追記専用化(0005)

`audit_logs`はDBトリガーでUPDATE/DELETEが拒否されます(errcode `42501`)。INSERTのみ許可です。DB権限保有者でも既存行の改変・削除はできません。トリガーを無効化する場合(監査ポリシー変更時のみ):

```sql
drop trigger audit_logs_no_update on audit_logs;
drop trigger audit_logs_no_delete on audit_logs;
```

監査データの棚卸は承認者権限で`POST /api/audit-logs/export`(`content-type: application/json`必須)を実行します(export操作自体が`audit.exported`として記録されます)。

```bash
curl -fsS -X POST -H 'content-type: application/json' \
  https://mirai-web-cad.mirai-dx-platform.com/api/audit-logs/export -o audit-logs.csv
```

> [!NOTE]
> 2026-09-18の独立監査で、`GET /api/audit-logs?format=csv`が**GETでありながら監査行を追記**していた点を指摘し、POST専用へ変更しました。GETはCORSのsimple requestとして扱われるため、クロスサイトの`<img>`/`<link>`から被害者の名前で`audit.exported`を追記でき、監査証跡を汚染・誤帰属させ得るためです(`content-type: application/json`の必須化によりpreflightが発生し、ブラウザ経由のクロスサイト実行は成立しません)。

### 既存の検証用残留行の削除(要承認)

2026-09-18より前の`db:verify`は、検証対象DBへ`audit_trigger_verify_probe`(actor `verify`、action `probe.insert`)をコミットしていました。**本番`mirai_web_cad`および検証用`mirai_web_cad_test`に1件ずつ残留しています**(2026-09-18実測)。現在の`db:verify`は検査をトランザクション内で行い必ずROLLBACKするため、新たな残留は発生しません([改善台帳P0-63](improvement-register.md))。

この行の削除は追記専用保護を一時的に外す操作であり、**本番データを対象とする破壊的操作のため、実施前に承認が必要です**。手順:

1. 対象DBと対象行(`id = 'audit_trigger_verify_probe'`)を確認し、削除対象がこの1行だけであることを記録する。
2. 上記「トリガーを無効化する場合」の手順で保護を外し、当該行を削除する。
3. **同一トランザクション内で**migration 0005のトリガー定義を再適用する。再適用後に`pg_trigger`の`tgenabled='O'`が2件であることを確認する。
4. `npm run db:verify`を実行し、追記専用保護が有効であり、かつ新たな残留が発生しないことを確認する。

削除を実施しない場合でも業務上の実害は限定的ですが、「監査証跡に検証用の合成行が1件残ることを受容する」という判断として記録してください。

## Backup / Restore

CIは一時PostgreSQLにMigration/Seedを適用し、custom archiveを空DBへ復元します(`.github/workflows/ci.yml`の`recovery`ジョブ)。同ワークフローの`postgres-integration`ジョブは復元は行わず、`db:verify`(migration適用)と`tests/data-store.pg.test.js`の実DB統合テストのみを実行します。

```bash
DATABASE_URL="postgresql://source" \
  BACKUP_FILE="artifacts/mirai-web-cad.dump" \
  npm run db:backup

RESTORE_DATABASE_URL="postgresql://empty-recovery-db" \
  BACKUP_FILE="artifacts/mirai-web-cad.dump" \
  ALLOW_DATABASE_RESTORE=yes \
  npm run db:restore
```

安全条件:

- 復元先は必ず空の検証DBとし、本番接続文字列を指定しない
- `ALLOW_DATABASE_RESTORE=yes`は復元実行時だけ設定する
- archiveは`umask 077`で作成し、Gitへ追加しない
- 復元後に件数だけでなく、実ブラウザでデモ取得、作図、再読込を確認する

本番の日次バックアップは`mirai-web-cad-backup.timer`(systemd、毎日03:10 JST)が担い、`/var/backups/mirai-web-cad/postgres/`へ保存します(保持14日)。詳細は[ローカルデプロイ運用メモ](deployment-local.md)を参照。暫定目標はRPO 24時間、RTO 4時間。オフサイト転送(R2等)は未実施で、保存先・暗号鍵・保持期間・費用・復元責任者の合意が別途必要です。

## 合成監視・障害Issue自動起票

`.github/workflows/synthetic-monitor.yml`が15分毎(`workflow_dispatch`でも手動実行可)に、Custom DomainでSPA/health/demo図面の200と、任意write APIのfail-closed(2026-08-30〜Cloudflare Access保護により302、未設定時は401)を確認します。

- 失敗時: `incident`+`synthetic-monitor`両ラベルを持つ既存Open Issueがあれば追記コメント、なければ新規Issueを自動起票し、ジョブを失敗させてActionsの通知(既定のGitHub通知経路)を発報します。
- 復旧時: 同条件で見つけたIssueへ復旧コメントを追記してcloseします。`synthetic-monitor`ラベルはこのworkflowが作成したIssueだけを対象にする識別子で、人が起票した`incident`ラベルのIssueを誤ってcloseしないようにしています。
- Teams/Slack Webhook通知(任意): Actions Secret `MONITOR_WEBHOOK_URL`にIncoming Webhook URLを設定すると、失敗時にWebhook通知も送信します。未設定の場合はIssue起票のみで運用でき、追加のSecrets登録なしで機能します。

GitHub Actions `schedule`は負荷状況により実行が遅延・間引かれることがあるため、設定した15分間隔の実行は保証されません(公式仕様)。7名のIT・DX部門での一次窓口として、Issue起票を主経路、Webhookを補助経路とします。

制約: 実行間隔の保証がありません。重大度別SLA・エスカレーション経路は下記「当番体制・重大度別SLA」で整備済みですが、当番の実名・連絡先割当は未整備です。これはIssue #8の残課題として管理します。

## 本番バックアップ自動化

日次バックアップはローカルsystemd timer(`mirai-web-cad-backup.timer`)が担います。GitHub Actions(クラウドhosted runner)からこのホストのPostgreSQLへ直接到達できないため、GitHub Actionsでのバックアップは行いません(旧`.github/workflows/backup-production.yml`は廃止)。

- `mirai-web-cad-backup.timer`: 毎日03:10 JST、`scripts/backup-local.sh`(既存の`scripts/backup-database.sh`を無変更で呼ぶ)を実行し、`/var/backups/mirai-web-cad/postgres/`へdump保存(保持14日)
- `mirai-web-cad-backup-check.timer`: 毎日06:00 JST、最新dumpが36時間以内・0バイト超であることを検証

手動実行・詳細手順は[ローカルデプロイ運用メモ](deployment-local.md)を参照。

## Incident Response

1. 検知: `journalctl -u mirai-web-cad -u mirai-web-cad-cloudflared`のエラー、health/demo失敗、DB接続失敗、認証失敗率、利用者申告をrequest IDで関連付ける。合成監視によるIssue自動起票も一次検知経路として機能する。
2. 初動: 更新を止める場合はCloudflare Access policyまたは`mirai-web-cad.service`を停止し、静的SPA閲覧の可否を確認する。証跡を保存する。
3. 判定: UI、API、Auth、DB、Tunnelのどの層か切り分ける。本番DBへ直接修正しない。
4. 復旧: 上記Rollback手順に従う。DBは復旧branchで内容確認後に切替判断する。
5. 確認: health、公開デモ、未認証write fail-closed(302または401)、認証済み作図/再読込、監査をsmoke testする。
6. 事後: 発生/検知/復旧時刻、影響図面、request ID、原因、再発防止をIssueへ残す。

自動alert(合成監視Issue自動起票)、重大度別SLA、エスカレーション経路は導入済み(下記「当番体制・重大度別SLA」参照)。当番の実名・連絡先は引き続き未設定。

## 当番体制・重大度別SLA(Issue #8)

IT/DX 7名での運用を想定した枠組み。**当番の実名・連絡先割当は運用担当者間の合意が必要なため、このセクションの表はテンプレートとして用意し、実際の割当は運用開始前に人間側で確定・追記すること。**

### 重大度定義

| 重大度 | 定義 | 例 |
|---|---|---|
| Sev1(重大) | 本番サービス全停止、データ損失・破損の疑い、セキュリティインシデント | Tunnel/DB接続断で全機能停止、認証バイパスの疑い、監査ログ改ざんの疑い |
| Sev2(高) | 主要機能の一部停止・継続的な書込み失敗、バックアップ失敗 | 図面保存API 5xx継続、`mirai-web-cad-backup-check.timer`鮮度検証失敗 |
| Sev3(中) | 軽微な表示不具合、性能劣化、単発の合成監視アラート(自動復旧含む) | 単発timeoutでのIssue起票後、次回実行で自動close |

### SLA目標(初動対応・サービス復旧目標)

| 重大度 | 初動対応 | サービス復旧目標(RTO) | 備考 |
|---|---|---|---|
| Sev1 | 検知後30分以内 | 4時間以内 | 復旧困難な場合はPages再アタッチ(SPAのみ)で緊急避難 |
| Sev2 | 検知後2時間以内 | 1営業日以内 | |
| Sev3 | 次営業日中 | 次回定例対応 | 自動復旧したIssueは事後確認のみで可 |

この表の「サービス復旧目標」は障害検知からサービスが利用可能に戻るまでの目標時間全体を指す。上記Backup / Restore節の「暫定目標はRPO 24時間、RTO 4時間」は、DB障害等でバックアップからの復元が必要な場合に限定した復元時間の目標であり、別の指標である。DB障害でバックアップ復元を伴うSev1のケースでは、この復元時間(4時間)がサービス復旧目標(4時間以内)の大半を占める前提で両者を揃えているが、それ以外の障害(Tunnel停止、認証設定不備等)ではバックアップ復元は発生せず、サービス復旧目標のみが適用される。

### 当番ローテーション(テンプレート、要人手入力)

| 期間 | 一次当番 | 二次(エスカレーション先) | 連絡手段 |
|---|---|---|---|
| (未確定) | (未確定) | (未確定) | (未確定) |

運用開始時にこの表を実名で埋め、以後は当番交代のたびに更新する(週次/月次ローテーション等、頻度は運用側で決定)。

### エスカレーション経路

1. 合成監視が失敗 → `incident`+`synthetic-monitor`ラベルでIssue自動起票(一次通知)、設定時は`MONITOR_WEBHOOK_URL`経由でも通知(二次通知)
2. 一次当番がIssue内容から重大度(Sev1〜3)を判定し、上記SLAに従い対応を開始。Issueに重大度ラベル(`severity:1`/`severity:2`/`severity:3`、未整備の場合は本文に明記)を付与する
3. Sev1、またはSLA内に一次当番が対応できない場合は二次(責任者)へエスカレーション
4. ホスト(kensan1969)自体の障害でSev1が長期化する場合、Cloudflare Pages Custom Domain再アタッチによるSPAのみの緊急避難を判断(上記Rollback節参照。`/api`はNeon接続の旧コードのため機能しない点に注意)

### 通知連携の現状

- 一次経路: GitHub Actions Issue自動起票(常時有効、追加設定不要)
- 二次経路(任意): Teams/Slack Incoming Webhook(`MONITOR_WEBHOOK_URL`、未設定なら一次経路のみで運用)
- Cloudflare Access自体の認証失敗・異常ログインのリアルタイム通知は、現行のCloudflare zoneプラン(Free)では提供されない(Logpush等はZero Trust Enterprise相当の契約が必要)。当面はAccessの監査ログを`Cloudflare Zero Trust`ダッシュボードで手動確認する運用とし、自動通知は上記2経路(合成監視ベース)に限定する。Access監査ログの定期確認自体は当番の定常タスクとして扱う

## 監視観点

- SPA 200応答とCSP/frame/Permissions-Policy header
- Canvas描画が空白でないこと
- LocalStorage保存失敗の有無
- `/api/health`と公開デモ200、任意図面/書き込みの認証fail-closed、書き込み監査ログを確認
- `/api/health`の`db.mode=connected`、`migrated=true`、`provider=postgres`を確認
- 作図/AI承認後の別リクエスト再読込と`audit_logs`を確認
- `journalctl -u mirai-web-cad -u mirai-web-cad-cloudflared`で5xx、JWT検証失敗、DB接続失敗を確認

## 既知制約

- Mirai JSONとASCII DXFの2D Importに対応。DXF書出しは未実装(80-90%代替方針Phase 1で対応予定)。DWGは対象外(ADR-0002)。PDF、寸法、ブロック、ハッチは試作〜限定対応(README参照)
- AIはルールベース提案を優先し、拾えない場合のみサーバー側プロキシ経由でOpenAI/Anthropicへフォールバックする(2026-08-30〜、PR#47/#49)。本番の実際の有効化状態は`GET /api/ai/status`で確認可能(鍵は返さない)
- 本番Custom Domainは`https://mirai-web-cad.mirai-dx-platform.com/`。SPA、health、公開デモは匿名200。任意図面と全更新は未認証401
- `mirai-web-cad.pages.dev`はロールバック手段として残置しているが、mainマージでは更新されない(SPAのみ200、`/api`は移行前のNeon接続コードのまま機能しない)
- Production環境は`AUTH_MODE=access`。Cloudflare Access(`mirai-web-cad-api`、`/api/*`保護、`kensan1969@gmail.com`のみallow)を2026-08-30に設定。未ログイン・未認証の書き込みはAccessログインへの302で拒否(SPA/health/demoはbypass設定で引き続き匿名可)。ログインはCloudflare IdPを使用する。案件単位RBACのための Entra ID グループ⇔ロール動的マッピングは実装済み(`src/entra-graph.js`、Microsoft Graph APIを非対話式client credentials flowで呼び出し、`ACCESS_ROLE_MAP`不一致時のみ`ENTRA_GROUP_ROLE_MAP`で解決、インメモリキャッシュ既定15分、解決失敗はfail-softで`ACCESS_DEFAULT_ROLE`へ縮退。設定手順は[ローカルデプロイ運用メモ](deployment-local.md)参照)。未設定のまま(`ENTRA_TENANT_ID`等3変数)では従来通り`ACCESS_ROLE_MAP`/`ACCESS_DEFAULT_ROLE`のみで動作する。複数利用者への実運用展開(グループ⇔ロール対応表の確定・投入)は引き続きIssue #5の残課題
- Production DBはこのホスト(kensan1969)上のローカルPostgreSQL 16、DB名`mirai_web_cad`
- 本番サービスがこのホストの稼働・ネットワークに依存する。ホスト停止・ネットワーク断で本番が停止する
- `mirai-web-cad.service`のsystemdユニットは`IPAddressDeny=any`を採用していない(Cloudflare Access JWKS取得の外向きHTTPSに必要なため)。インバウンド制限は`127.0.0.1`バインドと`RestrictAddressFamilies`で担保している
- CI(GitHub Actions)からはこのホストへ直接デプロイできないため、デプロイは`scripts/deploy-local.sh`の手動実行に依存する。self-hosted runner化は将来の別Issueとする
- バックアップのオフサイト転送(R2等)は未実施
- OpenDesign外部正本へ接続する手段は現環境にないため、リポジトリ内仕様HTMLとの整合を正本として確認中
