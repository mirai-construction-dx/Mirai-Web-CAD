# ADR-0005: Staging環境の設計と本番・MVPとの分離境界

## ステータス

承認済み(Accepted、2026-10-16) — オーナーの「CTOへ全権委譲」指示(2026-10-16)のもと、CTOが設計を決定。実際のホスト反映(DNS・秘密情報・systemd配置)は[GITHUB_POLICY.md](../../GITHUB_POLICY.md) §8のHuman GateとしてオーナーのY/N後に行う。

## コンテキスト

Mirai-Web-CADの本番は、このホスト(`kensan1969`)上のNode製APIサーバー(`scripts/serve-production.mjs`)をCloudflare Tunnel経由で公開し、同じホストのローカルPostgreSQLへ永続化する構成である。2026-09-05に、本番とデータを分離したMVP環境(`mirai-web-cad-mvp`、DB=`mirai_web_cad_mvp`)を同じTunnelへ追加した([改善台帳](../improvement-register.md) P0-50)。

現状は次の2環境のみで、いずれも「リリース候補を本番と同一構成で検証してから本番へ反映する」用途を持たない。

| 環境 | 用途 | データ | 利用者 |
| --- | --- | --- | --- |
| 本番(`mirai-web-cad`) | 実運用 | 本番データ | 限定利用者 |
| MVP(`mirai-web-cad-mvp`) | 機能の操作確認・評価 | 評価データ(本番と分離) | `kensan1969@gmail.com`のみ |

このため、次のリスクが残る。

- **migrationを含むリリース**は、検証用DBコピーで適用確認した後、本番DBへ直接適用する([ローカルデプロイ運用メモ](../deployment-local.md)「Migrationを含むリリース」)。本番と同名・同型の常設環境が無く、適用後状態の最終確認が本番DBそのものになる。
- **デプロイ手順(`scripts/deploy-local.sh`)の変更**は、本番とMVPの2系統だけで検証される。手順変更を伴うリリースは本番で初めて新経路を通る。
- **Cloudflare Access/Ruleset等の設定変更**を、本番へ適用する前に同じ構成で試す場所が無い。

## 選択肢

| 案 | 内容 | 影響 |
| --- | --- | --- |
| A. 常設のStaging環境を追加する | 本番と同一構成の3系統目(`mirai-web-cad-staging`、専用DB)を既存パターンで追加 | ホスト資源を追加で消費する。DNS/Access/秘密情報/systemd配置はHuman Gate |
| B. CIのエフェメラル検証のみで代替する | 既存のCIジョブ(空DB migration、PostgreSQL統合)を拡張し、常設環境は作らない | 追加のホスト資源・DNSは不要。ただし「常設・本番同一構成・Access保護下の手動UAT」はできない。migration適用後状態とデプロイ手順の最終確認は依然として本番が初 |
| C. MVPをstagingとして転用する | MVP URLをリリース候補検証に使う | MVPは評価データと単一利用者前提。本番相当のrole map/Access/データ隔離を兼ねられない |

## 決定

**案Aを採用する。** 常設のStaging環境を、既存のMVP構築(P0-50)と同じ手順・同じ分離方針で追加する。CIのエフェメラル検証(案B)は補完として維持し、置き換えない。

### 1. 目的

Stagingは「**本番と同一構成で、リリース候補・migration・デプロイ手順を本番反映前に検証する**」環境とする。MVP(機能の操作確認・評価)とは目的が異なる。

- 対象: 本番へ反映する候補commitの受入確認、migration適用後状態の確認、`deploy-local.sh`変更のリハーサル、Cloudflare Access境界の非破壊確認。
- 対象外: 実案件データの取扱い、対外公開、性能・負荷認定。Stagingのデータは使い捨てであり、**Stagingから本番へデータを昇格させない**(昇格するのはコードと設定のみ)。

### 2. 構成(既存パターンの踏襲)

| 項目 | 本番 | MVP | **Staging(新規)** |
| --- | --- | --- | --- |
| サービス | `mirai-web-cad.service` | `mirai-web-cad-mvp.service` | `mirai-web-cad-staging.service` |
| ポート | `18812` | `18813` | **`18814`** |
| ホスト名 | `mirai-web-cad.mirai-dx-platform.com` | `mirai-web-cad-mvp.mirai-dx-platform.com` | **`mirai-web-cad-stg.mirai-dx-platform.com`** |
| アプリDB | `mirai_web_cad` | `mirai_web_cad_mvp` | **`mirai_web_cad_staging`** |
| 復元用隔離DB | `mirai_web_cad_recovery` | `mirai_web_cad_mvp_recovery` | **`mirai_web_cad_staging_recovery`** |
| アプリenv | `~/.config/mirai-web-cad/production.env` | `~/.config/mirai-web-cad/mvp.env` | **`~/.config/mirai-web-cad/staging.env`** |
| バックアップenv | `~/.config/mirai-web-cad/backup.env` | `~/.config/mirai-web-cad/mvp-backup.env` | **`~/.config/mirai-web-cad/staging-backup.env`** |
| バックアップ先 | `/var/backups/mirai-web-cad/postgres` | `/var/backups/mirai-web-cad/mvp-postgres` | **`/var/backups/mirai-web-cad/staging-postgres`** |
| `AUTH_MODE` | `access` | `access` | **`access`** |

- Stagingは本番と同じ認証モード(`AUTH_MODE=access`)とし、Access Applicationでホスト全体を保護する。許可対象は当面 `kensan1969@gmail.com` のみ(本番と同じ運用主体が操作する)。
- StagingのCloudflare資源(DNS、Tunnel ingress、Access Application/Policy)は既存Tunnel `mirai-web-cad` に追加する。新しいTunnelは作らない。
- Stagingサービスは本番と同じ作業ツリーの `dist/` と `node_modules/` を使う(`deploy-local.sh` が3系統を一括で切り替える)。
- **ホスト名は`-stg`**(`mirai-web-cad-stg.mirai-dx-platform.com`)。組織の他Consumerの公開ホスト名(`Civil-Open-Data-Intelligence-Platform` `odip-stg`、`Construction-Site-Spatial-Platform` `3dgs-stg`)に合わせる。一方でsystemd unit・DB・envファイルは本リポジトリの既存慣例(`-staging`)を維持し、Tunnel名`mirai-web-cad`も変更しない(既存本番・MVPを共用)。

### 3. 分離境界(必須)

1. Stagingは**専用DBのみ**を読み書きする。本番・MVPのDBへ接続しない。Cutover後のサービスは、接続先DB名を`db:check`/healthで検証する(既存の`EXPECTED_DATABASE`方式を踏襲)。
2. Stagingは本番・MVPと**別のsystemd unit・別のenvファイル・別のバックアップディレクトリ**を持つ。
3. Stagingからの本番データ参照は行わない。検証に実データ形状が必要な場合は、`seeds/demo.sql`または合成データを使う。
4. 本番・MVPのDNS/Access/Ruleset設定を変更しない。Terraformの`enable_management`は`false`を維持し、import-only planが無差分であることを確認するまでapplyしない。
5. Stagingのバックアップ保持期間は本番より短くてよい(初期値14日)。オフサイト転送(R2)の対象には**当面含めない**(本番・MVPの`production/`・`mvp/`のみ)。追加する場合はR2の保存先と費用をオーナーが判断する。

### 4. Human Gate(オーナーのY/Nが必要な項目)

[GITHUB_POLICY.md](../../GITHUB_POLICY.md) §8および[AGENTS.md](../../AGENTS.md) §4に従い、次はコードのマージとは別にオーナーのY/Nを得てから実行する。手順は[Staging構築手順書](../runbooks/staging-bringup.md)にまとめる。

- Stagingホスト名のDNS route作成(公開DNS変更)
- Access Application/Policyの新設(公開範囲の変更)
- `~/.config/mirai-web-cad/staging.env`・`staging-backup.env`の作成(秘密情報の追加)
- systemd unitの配置・enable(本番デプロイ手順の変更)
- Staging用DB/ロールの作成

コード・設定ファイル・unit定義・CI・文書のマージは、GitHub RulesetのRequired Checks通過後にauto-mergeで行う(中央ポリシー v2)。

### 5. Stagingの定期ジョブ(初期値)

| ジョブ | 内容 | 初期値 |
| --- | --- | --- |
| バックアップ | 専用DBを`/var/backups/mirai-web-cad/staging-postgres`へ日次保存 | 毎日03:50 JST |
| 鮮度検査 | 最新dumpの鮮度(36時間以内・0バイト超)を検査 | 毎日06:45 JST |
| 復元ドリル | 隔離DB`mirai_web_cad_staging_recovery`へ週次復元し、内容一致を検査 | 日曜04:50 JST |
| 監視 | ローカルAPI・接続DB名・公開URLのAccess境界を検査 | 15分ごと |

失敗時は`OnFailure=mirai-web-cad-notify-failure@%n.service`で既存のGitHub Issue通知へ接続する。

## 結果

- 追加する資産: `deploy/systemd/mirai-web-cad-staging*.service`/`.timer`、`scripts/check-staging-health.sh`、`infra/cloudflare`のstaging定義(変数化・管理スイッチ据え置き)、`docs/runbooks/staging-bringup.md`、CIのstaging構成検査。
- 変更する資産: `scripts/deploy-local.sh`(3系統対応)、`scripts/check-deploy-drift.mjs`および`mirai-web-cad-deploy-drift.service`(staging URL追加)、`docs/deployment-local.md`・`docs/operations.md`・`README.md`・`state.json`。
- 未実施(オーナーY/N後): ホストへの反映(DNS route、Access Application、秘密情報、systemd配置、DB/ロール作成)。
- 差分・残課題は[基盤連携の要件と現状](../architecture/platform-integration.md)と[外部入力・確定待ち台帳](../external-input-status.md)に記録する。
