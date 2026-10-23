# Staging受入記録 2026-10-23（ADR-0006 独立リリースチャネル）

[ADR-0006](../adr/ADR-0006-staging-independent-release-channel.md)で決定した「Stagingを本番・MVPから独立したリリースチャネルにする」変更の**初回受入記録**です。2026-10-23 08:45〜08:47 JSTに、`scripts/deploy-staging.sh`でStagingだけをリリース候補commitへ先行デプロイし、health・readiness・E2E・公開境界・監視を実測しました。

本記録は**事実の記録**であり、手順の正本は[Staging構築手順書](staging-bringup.md)と[Staging E2Eと公開境界の検証](staging-e2e.md)、日常運用は[ローカルデプロイ運用メモ](../deployment-local.md)です。値はcommit SHA・DB名・ポート・パスのみを記載し、**秘密値・資格情報・接続文字列・個人情報は記載しません**。

> [!NOTE]
> **最終更新: 2026-10-23 09:02 JST。** 受入後に本番・MVPへの反映（`scripts/deploy-local.sh`、別のHuman Gate）が完了したため、最終commit `dd4bddbbe13800a2db35d7602cfd3f8564304880` の実測を§2・§4.1・§5・§7へ追記しました。以降は「本番反映後」の値を最終状態として扱います。

## 1. 目的

1. Stagingだけをリリース候補commitへ**先行デプロイ**できること（本番・MVPの配信commitを変えずに）を実測で示す。
2. 先行デプロイしたStagingで、受入に必要な検証（readiness、ローカルE2E、公開境界、監視）が**すべて成功**することを示す。
3. Stagingと本番/MVPが**別のランタイム・別のcommit・別のDB**で動いていることを証明する（本番反映後は同じcommitへ収束する。§5.2）。
4. 失敗時にStagingだけを戻せること（本番・MVPへ影響しないこと）を手順として確認する。

## 2. 対象と実施条件

| 項目 | 値 |
| --- | --- |
| 受入実施日時 | 2026-10-23 08:45〜08:47 JST（Staging先行デプロイと受入） |
| 本番反映実施日時 | 2026-10-23 09:01〜09:02 JST（`scripts/deploy-local.sh` 成功、§4.1） |
| 対象commit（リリース候補） | `625e7c311ce42b11ab883103de113e61ce5cd32c`（PR #179: ADR-0006、`deploy-staging.sh`、unit分離） |
| 本番反映の最終commit | `dd4bddbbe13800a2db35d7602cfd3f8564304880`（PR #180まで含むmain） |
| 本番/MVPの配信commit（受入時点・反映前） | `246b88a58946669de2a6a89b25de167531f4ac84` |
| 本番/MVP/Stagingの配信commit（本番反映後・最終） | `dd4bddbbe13800a2db35d7602cfd3f8564304880` |
| 本番worktreeのHEAD（受入時点） | `78dd2d3` |
| 本番worktreeのHEAD（本番反映後） | `dd4bddbbe13800a2db35d7602cfd3f8564304880` |
| 本番worktreeの`dist`（受入時点） | `.releases/246b88a58946669de2a6a89b25de167531f4ac84/dist` |
| 本番worktreeの`dist`（本番反映後） | `.releases/dd4bddbbe13800a2db35d7602cfd3f8564304880/dist` |
| Stagingランタイム | `~/.local/share/mirai-web-cad/staging-runtime`（`current` → `releases/dd4bddbbe13800a2db35d7602cfd3f8564304880`。受入時点は`releases/625e7c311ce42b11ab883103de113e61ce5cd32c`） |
| Stagingサービス | `mirai-web-cad-staging.service`（`127.0.0.1:18814`） |
| Staging公開URL | `https://mirai-web-cad-stg.mirai-dx-platform.com` |
| StagingアプリDB | `mirai_web_cad_staging` |
| 本番 / MVP | `mirai-web-cad.service`（18812、DB `mirai_web_cad`） / `mirai-web-cad-mvp.service`（18813、DB `mirai_web_cad_mvp`） |

実施の根拠: [ADR-0006](../adr/ADR-0006-staging-independent-release-channel.md) §5。Stagingへの先行デプロイはStaging専用リソースだけを変更する**可逆操作**であり本番デプロイではありません。初回のsystemdユニット変更（`WorkingDirectory`）とランタイム作成はホスト変更のため、2026-10-23のオーナー包括委譲（「CTOに全権委譲」）の範囲でCTOが実施しました。**本番・MVPへの反映（`scripts/deploy-local.sh`）は別のHuman Gateで、2026-10-23 09:01〜09:02 JSTに完了**しました（§4.1）。

## 3. 実行コマンド（実行順）

```bash
# 1. Stagingだけをリリース候補へ先行デプロイ（本番・MVPのツリー/dist/node_modules/サービスには触れない）
bash scripts/deploy-staging.sh 625e7c311ce42b11ab883103de113e61ce5cd32c

# 2. Readiness（読み取り専用。秘密値は出力しない）
bash scripts/check-staging-readiness.sh

# 3. ローカルE2E（Access Service Token不要）
E2E_EXPECT_COMMIT=625e7c311ce42b11ab883103de113e61ce5cd32c npm run test:e2e:staging -- --local

# 4. 公開境界の検証（読み取り専用）
bash scripts/check-staging-public-boundary.sh

# 5. 監視ジョブの手動実行（15分タイマーと同じunit）
sudo systemctl start mirai-web-cad-staging-monitor.service
journalctl -u mirai-web-cad-staging-monitor.service -n 20

# 6. healthの突合（Staging / 本番 / MVP）
curl -fsS http://127.0.0.1:18814/api/health
curl -fsS http://127.0.0.1:18812/api/health
curl -fsS http://127.0.0.1:18813/api/health
```

`scripts/deploy-staging.sh`は`staging.env`から`DATABASE_URL`を`sed`で1変数だけ取り出して`db:check`（読み取り専用）に使い、値は出力しません。手順3の`current`切替以降で失敗した場合は、ERR trapが`current`を直前の向き先へ戻します（§6）。

受入が完了した後、**本番・MVPへの反映は別のHuman Gate**として`bash scripts/deploy-local.sh`で行います（事前backup・`db:check`・health検証の手順は[ローカルデプロイ運用メモ](../deployment-local.md)）。今回は受入後にmainが`dd4bddb`（PR #180まで）へ進んだため、Stagingへ同commitを先行デプロイ（09:01:00）してから本番・MVPへ反映しました（09:01:5x完了）。`deploy-local.sh`は本番・MVPの2系統だけを切り替え、Stagingの`current`とサービスには触れません（§4.1・§5で実測）。

## 4. 結果（受入時点: 2026-10-23 08:45〜08:47 JST）

| # | 検証 | 実測値 | 判定 |
| --- | --- | --- | --- |
| 1 | 独立Stagingデプロイ（`scripts/deploy-staging.sh`、受入時点） | 成功。`current` → `releases/625e7c311ce42b11ab883103de113e61ce5cd32c` | OK |
| 2 | Staging health（`127.0.0.1:18814/api/health`、受入時点） | `ok=true`、`db.mode=connected`、`deploy.commit=625e7c3…`、`deploy.distCommit=625e7c3…` | OK |
| 3 | 本番 health（`127.0.0.1:18812/api/health`、受入時点） | `ok=true`、`deploy.distCommit=246b88a…`（**変更なし**） | OK |
| 4 | MVP health（`127.0.0.1:18813/api/health`、受入時点） | `ok=true`、`deploy.distCommit=246b88a…`（**変更なし**） | OK |
| 5 | 本番worktreeの不変性（受入時点） | HEAD `78dd2d3`、`dist` → `.releases/246b88a…/dist`（Stagingデプロイ前後で不変） | OK |
| 6 | StagingローカルE2E（`npm run test:e2e:staging -- --local`、受入時点） | desktop/mobile **2/2 pass**、`deployedCommit=625e7c3…`（`E2E_EXPECT_COMMIT`と一致） | OK |
| 7 | 公開境界（`scripts/check-staging-public-boundary.sh`） | Staging `/`=302（Access）、Staging `/api/health`=302（Access）、本番 `/api/health`=200、MVP `/`=302 | OK |
| 8 | Readiness（`scripts/check-staging-readiness.sh`） | 全項目OK: unit `WorkingDirectory`=`staging-runtime/current`、env `0600`、env/healthのDB名=`mirai_web_cad_staging`、公開URL 302、runtime `current` の向き先とbuild commit | OK（exit 0） |
| 9 | 監視（`mirai-web-cad-staging-monitor.service` 手動実行） | success: `service health check ok: local API, database=mirai_web_cad_staging, Access redirect required=yes` | OK |
| 10 | 定期タイマー | stagingの backup / backup-check / monitor / restore-drill の4本が `enabled` かつ `active (waiting)` | OK |

補足:

- 手順2の`deploy.commit`は`git archive`由来の配信物でgit情報を持たないため、`dist/build-info.json`へフォールバックして同じ候補commitを返します（ADR-0006 §4、`scripts/lib/deploy-info.mjs`）。
- 匿名`/api/health`は`db.database`を伏せるため、接続DB名は`staging.env`のDB名（readiness）とStaging DBへの`db:check`で確認しました。**受入時点では本番DB・MVP DBへ`db:check`を実行していません**。本番反映（§4.1）では`deploy-local.sh`が本番・MVPの2回だけ`db:check`を実行し、Staging DBへの追加実行はありません。
- 手順6のE2Eは`--local`（`127.0.0.1:18814`直結）であり、Access境界の証明は手順4の公開境界チェックで別途行っています（[staging-e2e.md](staging-e2e.md) §5）。

### 4.1 本番・MVPへの反映（別のHuman Gate、2026-10-23 09:01〜09:02 JST）

Stagingでの受入が完了した後、本番・MVPへ反映しました。反映は`bash scripts/deploy-local.sh`で行い、事前にバックアップを取得しています。**`deploy-local.sh`は本番・MVPの2系統だけを切り替え、Stagingには触れません。**

| # | 検証 | 実測値 | 判定 |
| --- | --- | --- | --- |
| 11 | 本番・MVPへの反映（`scripts/deploy-local.sh`） | 成功（出力 `デプロイ成功: dd4bddbbe138...`）。最終mainは`dd4bddbbe13800a2db35d7602cfd3f8564304880`（PR #180まで） | OK |
| 12 | 反映前バックアップ | `mirai-web-cad-20261023T000118Z.dump`（`backup-local ok`、manifest付き） | OK |
| 13 | 本番worktree | HEAD `dd4bddb…`、`dist`と`node_modules` → `.releases/dd4bddb…/` | OK |
| 14 | 3環境health（18812 / 18813 / 18814） | すべて`ok=true`、`db.mode=connected`、`deploy.commit=dd4bddb…`、`deploy.distCommit=dd4bddb…` | OK |
| 15 | Stagingが本番デプロイで再起動されていないこと | `mirai-web-cad-staging.service`の`ActiveEnterTimestamp`がStaging先行デプロイ時の`2026-10-23 09:01:00 JST`のまま（本番デプロイは09:01:5xに完了） | OK |
| 16 | 反映後のStaging検証 | `check-staging-readiness.sh`全項目OK、公開境界はStaging 302（Access）・本番`/api/health`=200・MVP 302、`mirai-web-cad-staging-monitor.service` success（09:01:53） | OK |
| 17 | `db:check`の実行範囲 | 本番デプロイ中の`db:check`は本番・MVPの2回のみで、Staging DBへの`db:check`は実行されていない | OK |

## 5. Stagingと本番/MVPの分離証明

分離の根拠を、**受入時点（08:47）**と**本番反映後（09:02）**の2つの実測で示します。

### 5.1 受入時点（08:47）: Stagingだけが先行更新されていた

| 観点 | Staging | 本番 | MVP |
| --- | --- | --- | --- |
| 配信commit（`deploy.distCommit`） | `625e7c3` | `246b88a` | `246b88a` |
| ランタイム | `~/.local/share/mirai-web-cad/staging-runtime/current` | 作業ツリーの`dist`→`.releases/246b88a…/dist` | 同左（本番と共有） |
| デプロイ手段 | `scripts/deploy-staging.sh`（Stagingのみ再起動） | `scripts/deploy-local.sh` | `scripts/deploy-local.sh` |
| ポート | 18814 | 18812 | 18813 |
| DB | `mirai_web_cad_staging` | `mirai_web_cad` | `mirai_web_cad_mvp` |
| 作業ツリー | 独立ランタイム（本番ツリーを共有しない） | 共有worktree | 共有worktree |
| 公開境界（未認証） | 302（Access） | `/api/health`=200 | `/`=302（Access） |

### 5.2 本番反映後（09:02）: 3環境が同じcommitで一致（ランタイム・DB・サービスは分離のまま）

| 観点 | Staging | 本番 | MVP |
| --- | --- | --- | --- |
| 配信commit（`deploy.distCommit`） | `dd4bddb` | `dd4bddb` | `dd4bddb` |
| ランタイム | `~/.local/share/mirai-web-cad/staging-runtime/current` → `releases/dd4bddb…` | 作業ツリーの`dist`→`.releases/dd4bddb…/dist` | 同左（本番と共有） |
| サービス | `mirai-web-cad-staging.service`（`ActiveEnterTimestamp`=`09:01:00`のまま） | `mirai-web-cad.service` | `mirai-web-cad-mvp.service` |
| デプロイ手段 | `scripts/deploy-staging.sh` | `scripts/deploy-local.sh` | `scripts/deploy-local.sh` |
| ポート | 18814 | 18812 | 18813 |
| DB | `mirai_web_cad_staging` | `mirai_web_cad` | `mirai_web_cad_mvp` |

証明の要点:

1. **commitの不一致が同時に観測できた。** 同じ時刻のhealthでStagingが`625e7c3`、本番/MVPが`246b88a`を返しており、Stagingだけが先行更新されたことを示す。ADR-0006の受け入れ条件「Stagingだけをcommit Xへ更新し、本番・MVPがcommit Yのままであることをhealthで実測できる」に対応する。
2. **本番worktreeの`dist` symlinkとHEADが不変。** Stagingデプロイの前後で本番worktreeのHEAD `78dd2d3`と`dist` → `.releases/246b88a…/dist`が変わっていない。`deploy-staging.sh`は本番ツリーの`git HEAD`・`.releases/`・`dist`・`node_modules`に触れない。
3. **再起動されたのはStagingサービスだけ。** 本番・MVPのhealthが`ok=true`のまま`246b88a`を配信し続けており、再起動やsymlink切替が起きていないことと整合する。
4. **公開境界とDBが別。** Stagingの公開URLと`/api/health`は302（Access）で、本番`/api/health`=200・MVP`/`=302`は従来どおり。StagingのDBは`mirai_web_cad_staging`のみで、本番・MVPのDBを参照していない。
5. **E2Eが候補commitを配信していることを検証。** `E2E_EXPECT_COMMIT=625e7c3…`付きのローカルE2Eが`deployedCommit=625e7c3…`で2/2 passし、commitの取り違えがないことを確認した。
6. **本番反映はStagingを再起動しない。** `deploy-local.sh`の実行後もStagingの`ActiveEnterTimestamp`は先行デプロイ時の`2026-10-23 09:01:00 JST`のままで、本番デプロイの完了（09:01:5x）より前である。ADR-0006の受け入れ条件「本番デプロイ（`deploy-local.sh`）が本番+MVPだけを更新し、Stagingを再起動しない」に対応する。3環境の配信commitが`dd4bddb`で一致したのは、Staging先行デプロイと本番反映が同じcommitを対象にしたためで、ランタイム・DB・ポート・サービスは分離したままである。

## 6. 失敗時のロールバック

| 局面 | 戻し方 | 本番・MVPへの影響 |
| --- | --- | --- |
| `deploy-staging.sh`の手順1〜2（構築・`db:check`）で失敗 | 何も切り替わらない（稼働中のStagingはそのまま）。原因を直して再実行 | なし |
| `deploy-staging.sh`の手順3以降（`current`切替・再起動・health検証）で失敗 | スクリプトのERR trapが`current`を直前の向き先へ戻し、Stagingサービスを再起動してhealthを再検証する。初回で戻し先が無い場合は`current`を削除してStagingを停止する | なし |
| 受入で問題が見つかった（デプロイ自体は成功） | `bash scripts/deploy-staging.sh <直前の正常commit>`でStagingだけを戻す。Stagingランタイムは独立しているため本番・MVPのサービスは再起動しない | なし |
| systemdユニット（`WorkingDirectory`）の切り戻し | 旧ユニット（本番worktree参照）へ戻して`daemon-reload`・Staging再起動。**systemd設定の変更にあたるためHuman GateとしてオーナーのY/Nを得る** | なし |
| Staging定期ジョブ（backup/backup-check/restore-drill/monitor） | 本番ツリーのスクリプトを実行するため、Stagingのロールバックでは変更されない。必要なら`systemctl start`で個別に再実行 | なし |

本記録の受入（§4）は本番・MVPを変更していません。その後の**本番反映（§4.1、2026-10-23 09:01〜09:02 JST）は完了済み**で、失敗時の切り戻しは`deploy-local.sh`の自動ロールバックと[ローカルデプロイ運用メモ](../deployment-local.md)の手順に従います。Stagingは独立ランタイムのため、本番反映のロールバックでもStagingの`current`とサービスは影響を受けません。逆にStagingだけを戻す場合は§6の`deploy-staging.sh <直前の正常commit>`を使い、本番・MVPには触れません。

## 7. 残課題

本番反映は2026-10-23 09:01〜09:02 JSTに完了しました（§4.1、最終commit `dd4bddb`）。残課題は次の2点です。

| # | 残課題 | 現状と次アクション |
| --- | --- | --- |
| 1 | **staging-monitorのスクリプト依存** | 監視・バックアップ・復元ドリルは本番ツリーのスクリプト（`scripts/check-staging-health.sh`等）を実行するため、スクリプトの更新は本番デプロイ後に反映される（ADR-0006 §3-5、[deployment-local.md](../deployment-local.md)の既知の制約）。2026-10-16時点は本番worktreeが古く`exit 127`だったが、2026-10-23は本番worktreeに同スクリプトが存在し、手動実行はsuccess（08:47・09:01:53の2回実測）。監視ユニットの`WorkingDirectory`を独立ランタイムへ移すかは**未決**（別途判断） |
| 2 | **Service Tokenを使う公開URL E2Eが未実施** | 今回のE2Eは`--local`（トークン不要）のみ。公開URLの画面検証（`npm run test:e2e:staging`、Access Service Token）はトークン値がログに残らないようオーナーがローカルで実施する必要があり、**2026-10-23時点でも未実施**（[staging-e2e.md](staging-e2e.md) §3、[staging-bringup.md](staging-bringup.md) §12） |

次回以降のリリースでも「Staging先行デプロイ→受入→本番反映」の順序を守ります。今回は受入（08:45〜08:47、`625e7c3`）の後にmainが`dd4bddb`（PR #180まで）へ進んだため、Stagingへ`dd4bddb`を先行デプロイしてから本番・MVPへ反映しました（§4.1）。

## 8. 参照文書

- [ADR-0006: Stagingを独立リリースチャネルにする](../adr/ADR-0006-staging-independent-release-channel.md)（本受入の設計）
- [ADR-0005: Staging環境の設計](../adr/ADR-0005-staging-environment.md)（用途・分離境界・Access・DB・定期ジョブ）
- [Staging構築手順書](staging-bringup.md)（§7 独立リリース移行、§10 検証チェックリスト）
- [Staging E2Eと公開境界の検証](staging-e2e.md)（受入で使う検証コマンド）
- [ローカルデプロイ運用メモ](../deployment-local.md)（`deploy-staging.sh` / `deploy-local.sh` の運用手順）
