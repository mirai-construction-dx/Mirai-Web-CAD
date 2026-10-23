# Staging migrationリハーサル

更新日: 2026-10-23。状態: **実装済み(CIはテスト用スタブのみ。実Staging DBでの実行は未実施)**。
関連: [Staging構築手順書](staging-bringup.md)、[Staging E2Eと公開境界の検証](staging-e2e.md)、
[ローカルデプロイ運用メモ](../deployment-local.md)、[データベース障害対応](database-incident.md)、
[基盤連携の要件と現状](../architecture/platform-integration.md)、ADR-0005(Staging環境)、ADR-0006(Stagingの独立リリース)。

## 1. 目的

本番・MVPへmigrationを反映する**前に**、使い捨てのStaging DBで次を1コマンドで確かめる。

1. `npm run db:verify` — `migrations/` の適用と `seeds/demo.sql` の投入が成功すること。
2. `npm run db:check` — 適用後状態(テーブル・列・制約・索引・監査トリガ・JSONB)が期待どおりであること。
3. 実行前後でStagingの `/api/health` が健全であること。

本番では `db:verify` を実行しない([AGENTS.md](../../AGENTS.md) §4、[deployment-local.md](../deployment-local.md))。
本リハーサルは「migrationと検証手順がStagingで通る」ことの確認であり、本番DBへの適用そのものではない。

## 2. 前提

- Stagingは**使い捨て**である(ADR-0005)。リハーサルでStaging DBのデータが書き換わってよい。
- `migrations/` は**additiveかつ後方互換のみ**([AGENTS.md](../../AGENTS.md) §4)。破壊的migrationはリハーサルの対象外であり、そもそも追加しない。
- 対象は `staging.env`(既定 `~/.config/mirai-web-cad/staging.env`、mode 0600)の `DATABASE_URL` が指す `mirai_web_cad_staging` **だけ**。本番(`mirai_web_cad`)・MVP・復元用の `mirai_web_cad_staging_recovery` には実行しない。
- 実行するのは開発/運用担当。秘密値(`DATABASE_URL`・パスワード)はコマンド履歴・ログ・Issue・チャットへ出さない。
- このスクリプトはsystemd・`current` symlink・デプロイには触れない。失敗しても稼働中のStagingの配信物とプロセスは変わらない(変わるのはStaging DBだけ)。

## 3. 実行前の確認

```bash
# 1. Stagingサービスが稼働している(任意。healthはスクリプトが前後で確認する)
curl -fsS --max-time 5 http://127.0.0.1:18814/api/health

# 2. staging.envが存在し、DB名がStagingであること(値は表示しない)
stat -c '%a %n' ~/.config/mirai-web-cad/staging.env
grep -o '^[A-Z_]*=' ~/.config/mirai-web-cad/staging.env

# 3. 実行予定の確認(何も実行しない)
bash scripts/rehearse-staging-migration.sh --dry-run
```

`--dry-run` は対象DB名・envファイル・実行予定の4ステップだけを表示する。秘密値・接続文字列は表示しない。
DB名がStagingでなければ `--dry-run` でも中止する。

## 4. 実行例

```bash
# リポジトリのルートで実行する(migrationはこの作業ツリーの migrations/ を使う)
bash scripts/rehearse-staging-migration.sh
```

成功時の出力例(値はイメージ。DATABASE_URLは表示されない):

```text
Staging migrationリハーサル開始: DB=mirai_web_cad_staging(値は表示しません)
=== 1/4 実行前のStaging health確認 ===
[health:before] ok=true distCommit=abc1234 db.mode=connected
=== 2/4 db:verify (migration適用＋seed) ===
database verification ok: database=mirai_web_cad_staging tables=9 seed=1
=== 3/4 db:check (適用後状態の確認) ===
database state check ok: migrations=8 tables=9 constraints=7 indexes=7 audit_triggers=3 jsonb_strings=0
=== 4/4 実行後のStaging health確認 ===
[health:after] ok=true distCommit=abc1234 db.mode=connected
Staging migrationリハーサル成功: DB=mirai_web_cad_staging db:verify=ok db:check=ok
```

環境変数(通常は変更しない):

| 変数 | 既定 | 用途 |
| --- | --- | --- |
| `STAGING_ENV_FILE` | `~/.config/mirai-web-cad/staging.env` | `DATABASE_URL` の取得元 |
| `STAGING_DB_NAME` | `mirai_web_cad_staging` | 必須のDB名(ガード) |
| `STAGING_PORT` | `18814` | healthの待受ポート |
| `STAGING_HEALTH_TIMEOUT_SECONDS` | `5` | health取得のタイムアウト |

## 5. 判定

| 終了コード | 意味 | 判定 |
| --- | --- | --- |
| 0 | 4ステップすべて成功 | リハーサル成功。本番反映の判断材料にできる |
| 非0 | env不備・DB名不一致・`db:verify`/`db:check`失敗・事後health失敗 | 失敗。原因を確認し、本番へは進まない |

- 実行前healthが取得できない場合は**警告のみでDB検証続行**(DBはサービスと独立のため)。実行後healthが取得できない場合は**失敗扱い**にする(サービスへの影響を疑う)。
- 出力に表示するhealth情報は `ok` / `distCommit` / `db.mode` の要約だけ。health本文は表示しない(匿名healthでも将来の項目追加に備える)。

## 6. 失敗時の扱い

- **DB名不一致**: 何も実行せず終了する。`staging.env` の設定誤りを直す。本番・MVPのDBを対象に `db:verify` を実行しない。
- **envファイル/DATABASE_URLなし**: 何も実行しない。Human Gate 3(`staging.env` の作成)を確認する。
- **`db:verify` 失敗**: 所有権不足・接続不可・migration不整合の可能性がある。エラーメッセージを確認し、必要ならmigrationを追加したPRの内容とStaging DBのロール・grantを見直す。Stagingサービスは再起動していない。
- **`db:check` 失敗**: migrationは適用済みの可能性がある。不足しているテーブル・列・制約・索引・監査トリガを確認し、Staging DBを作り直すか、差分を埋めるmigrationを用意する(Stagingは使い捨てのため作り直しを選べる)。
- 失敗しても本番・MVPへは影響しない。Staging DBで復旧できない場合は[データベース障害対応](database-incident.md)と[Staging構築手順書](staging-bringup.md)に従う。
- 失敗したまま**本番へmigrationを反映しない**。成功するまでリハーサルを繰り返す。

## 7. 本番migrationとの関係

- リハーサル成功は「Stagingでmigrationと検証手順が通った」ことを意味する。本番への適用は別のHuman Gateであり、本番DBへ `db:verify` は実行しない。
- 本番反映はリリース手順([deployment-local.md](../deployment-local.md))に従い、migration適用後に**読み取り専用の** `npm run db:check` で適用後状態を確認する。
- Stagingのリハーサルは本番の代わりではない。本番固有のロール・所有権・データ量・バックアップからの復元時間はStagingでは再現できない。
- リハーサルで使ったrelease候補のcommitを、Stagingの独立リリース(`scripts/deploy-staging.sh`)と本番反映で同じにそろえる。

## 8. 制約

- **`--skip-seed` は提供しない。** `db:verify` はmigration適用と `seeds/demo.sql` を1組で検証する実装(`scripts/verify-database.sh`)であり、seedだけを飛ばすと「検証した状態」と「実際の状態」がずれる。seed込みで通すことがStagingの目的に合う。
- 実行対象は現在の作業ツリーの `migrations/`。未マージのmigrationを試す場合は、そのbranchのworktreeで実行する。
- healthの前後確認は「サービスが生きている」ことの確認であり、DBの内容の正しさは `db:verify`/`db:check` が判定する。
- 実Staging DBでの実行は未実施(2026-10-23時点)。CIは `tests/staging-rehearsal.test.js` のnpm/curl/psqlスタブのみで、実DB・Stagingホスト・ネットワークには触れない。
- 定期実行・CIからの実DB実行は行わない(Staging DBを書き換えるため)。実行はHuman Gateの判断で行う。
