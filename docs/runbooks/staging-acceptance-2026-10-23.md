# Staging受入記録 2026-10-23（ADR-0006 独立リリースチャネル）

[ADR-0006](../adr/ADR-0006-staging-independent-release-channel.md)で決定した「Stagingを本番・MVPから独立したリリースチャネルにする」変更の**初回受入記録**です。2026-10-23 08:45〜08:47 JSTに、`scripts/deploy-staging.sh`でStagingだけをリリース候補commitへ先行デプロイし、health・readiness・E2E・公開境界・監視を実測しました。

本記録は**事実の記録**であり、手順の正本は[Staging構築手順書](staging-bringup.md)と[Staging E2Eと公開境界の検証](staging-e2e.md)、日常運用は[ローカルデプロイ運用メモ](../deployment-local.md)です。値はcommit SHA・DB名・ポート・パスのみを記載し、**秘密値・資格情報・接続文字列・個人情報は記載しません**。

## 1. 目的

1. Stagingだけをリリース候補commitへ**先行デプロイ**できること（本番・MVPの配信commitを変えずに）を実測で示す。
2. 先行デプロイしたStagingで、受入に必要な検証（readiness、ローカルE2E、公開境界、監視）が**すべて成功**することを示す。
3. Stagingと本番/MVPが**別のランタイム・別のcommit・別のDB**で動いていることを証明する。
4. 失敗時にStagingだけを戻せること（本番・MVPへ影響しないこと）を手順として確認する。

## 2. 対象と実施条件

| 項目 | 値 |
| --- | --- |
| 実施日時 | 2026-10-23 08:45〜08:47 JST |
| 対象commit（リリース候補） | `625e7c311ce42b11ab883103de113e61ce5cd32c`（PR #179: ADR-0006、`deploy-staging.sh`、unit分離） |
| 本番/MVPの配信commit（変更なし） | `246b88a58946669de2a6a89b25de167531f4ac84` |
| 本番worktreeのHEAD（変更なし） | `78dd2d3` |
| 本番worktreeの`dist`（変更なし） | `.releases/246b88a58946669de2a6a89b25de167531f4ac84/dist` |
| Stagingランタイム | `~/.local/share/mirai-web-cad/staging-runtime`（`current` → `releases/625e7c311ce42b11ab883103de113e61ce5cd32c`） |
| Stagingサービス | `mirai-web-cad-staging.service`（`127.0.0.1:18814`） |
| Staging公開URL | `https://mirai-web-cad-stg.mirai-dx-platform.com` |
| StagingアプリDB | `mirai_web_cad_staging` |
| 本番 / MVP | `mirai-web-cad.service`（18812、DB `mirai_web_cad`） / `mirai-web-cad-mvp.service`（18813、DB `mirai_web_cad_mvp`） |

実施の根拠: [ADR-0006](../adr/ADR-0006-staging-independent-release-channel.md) §5。Stagingへの先行デプロイはStaging専用リソースだけを変更する**可逆操作**であり本番デプロイではありません。初回のsystemdユニット変更（`WorkingDirectory`）とランタイム作成はホスト変更のため、2026-10-23のオーナー包括委譲（「CTOに全権委譲」）の範囲でCTOが実施しました。**本番・MVPへの反映（`scripts/deploy-local.sh`）は別のHuman Gateであり、本記録作成時点では未実施**です（§7）。

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

## 4. 結果

| # | 検証 | 実測値 | 判定 |
| --- | --- | --- | --- |
| 1 | 独立Stagingデプロイ（`scripts/deploy-staging.sh`） | 成功。`current` → `releases/625e7c311ce42b11ab883103de113e61ce5cd32c` | OK |
| 2 | Staging health（`127.0.0.1:18814/api/health`） | `ok=true`、`db.mode=connected`、`deploy.commit=625e7c3…`、`deploy.distCommit=625e7c3…` | OK |
| 3 | 本番 health（`127.0.0.1:18812/api/health`） | `ok=true`、`deploy.distCommit=246b88a…`（**変更なし**） | OK |
| 4 | MVP health（`127.0.0.1:18813/api/health`） | `ok=true`、`deploy.distCommit=246b88a…`（**変更なし**） | OK |
| 5 | 本番worktreeの不変性 | HEAD `78dd2d3`、`dist` → `.releases/246b88a…/dist`（Stagingデプロイ前後で不変） | OK |
| 6 | StagingローカルE2E（`npm run test:e2e:staging -- --local`） | desktop/mobile **2/2 pass**、`deployedCommit=625e7c3…`（`E2E_EXPECT_COMMIT`と一致） | OK |
| 7 | 公開境界（`scripts/check-staging-public-boundary.sh`） | Staging `/`=302（Access）、Staging `/api/health`=302（Access）、本番 `/api/health`=200、MVP `/`=302 | OK |
| 8 | Readiness（`scripts/check-staging-readiness.sh`） | 全項目OK: unit `WorkingDirectory`=`staging-runtime/current`、env `0600`、env/healthのDB名=`mirai_web_cad_staging`、公開URL 302、runtime `current` の向き先とbuild commit | OK（exit 0） |
| 9 | 監視（`mirai-web-cad-staging-monitor.service` 手動実行） | success: `service health check ok: local API, database=mirai_web_cad_staging, Access redirect required=yes` | OK |
| 10 | 定期タイマー | stagingの backup / backup-check / monitor / restore-drill の4本が `enabled` かつ `active (waiting)` | OK |

補足:

- 手順2の`deploy.commit`は`git archive`由来の配信物でgit情報を持たないため、`dist/build-info.json`へフォールバックして同じ候補commitを返します（ADR-0006 §4、`scripts/lib/deploy-info.mjs`）。
- 匿名`/api/health`は`db.database`を伏せるため、接続DB名は`staging.env`のDB名（readiness）と`db:check`で確認しました。**本番DB・MVP DBへは`db:check`も含めて実行していません**。
- 手順6のE2Eは`--local`（`127.0.0.1:18814`直結）であり、Access境界の証明は手順4の公開境界チェックで別途行っています（[staging-e2e.md](staging-e2e.md) §5）。

## 5. Stagingと本番/MVPの分離証明

2026-10-23 08:47時点の実測による分離の根拠です。

| 観点 | Staging | 本番 | MVP |
| --- | --- | --- | --- |
| 配信commit（`deploy.distCommit`） | `625e7c3` | `246b88a` | `246b88a` |
| ランタイム | `~/.local/share/mirai-web-cad/staging-runtime/current` | 作業ツリーの`dist`→`.releases/246b88a…/dist` | 同左（本番と共有） |
| デプロイ手段 | `scripts/deploy-staging.sh`（Stagingのみ再起動） | `scripts/deploy-local.sh` | `scripts/deploy-local.sh` |
| ポート | 18814 | 18812 | 18813 |
| DB | `mirai_web_cad_staging` | `mirai_web_cad` | `mirai_web_cad_mvp` |
| 作業ツリー | 独立ランタイム（本番ツリーを共有しない） | 共有worktree | 共有worktree |
| 公開境界（未認証） | 302（Access） | `/api/health`=200 | `/`=302（Access） |

証明の要点:

1. **commitの不一致が同時に観測できた。** 同じ時刻のhealthでStagingが`625e7c3`、本番/MVPが`246b88a`を返しており、Stagingだけが先行更新されたことを示す。ADR-0006の受け入れ条件「Stagingだけをcommit Xへ更新し、本番・MVPがcommit Yのままであることをhealthで実測できる」に対応する。
2. **本番worktreeの`dist` symlinkとHEADが不変。** Stagingデプロイの前後で本番worktreeのHEAD `78dd2d3`と`dist` → `.releases/246b88a…/dist`が変わっていない。`deploy-staging.sh`は本番ツリーの`git HEAD`・`.releases/`・`dist`・`node_modules`に触れない。
3. **再起動されたのはStagingサービスだけ。** 本番・MVPのhealthが`ok=true`のまま`246b88a`を配信し続けており、再起動やsymlink切替が起きていないことと整合する。
4. **公開境界とDBが別。** Stagingの公開URLと`/api/health`は302（Access）で、本番`/api/health`=200・MVP`/`=302`は従来どおり。StagingのDBは`mirai_web_cad_staging`のみで、本番・MVPのDBを参照していない。
5. **E2Eが候補commitを配信していることを検証。** `E2E_EXPECT_COMMIT=625e7c3…`付きのローカルE2Eが`deployedCommit=625e7c3…`で2/2 passし、commitの取り違えがないことを確認した。

## 6. 失敗時のロールバック

| 局面 | 戻し方 | 本番・MVPへの影響 |
| --- | --- | --- |
| `deploy-staging.sh`の手順1〜2（構築・`db:check`）で失敗 | 何も切り替わらない（稼働中のStagingはそのまま）。原因を直して再実行 | なし |
| `deploy-staging.sh`の手順3以降（`current`切替・再起動・health検証）で失敗 | スクリプトのERR trapが`current`を直前の向き先へ戻し、Stagingサービスを再起動してhealthを再検証する。初回で戻し先が無い場合は`current`を削除してStagingを停止する | なし |
| 受入で問題が見つかった（デプロイ自体は成功） | `bash scripts/deploy-staging.sh <直前の正常commit>`でStagingだけを戻す。Stagingランタイムは独立しているため本番・MVPのサービスは再起動しない | なし |
| systemdユニット（`WorkingDirectory`）の切り戻し | 旧ユニット（本番worktree参照）へ戻して`daemon-reload`・Staging再起動。**systemd設定の変更にあたるためHuman GateとしてオーナーのY/Nを得る** | なし |
| Staging定期ジョブ（backup/backup-check/restore-drill/monitor） | 本番ツリーのスクリプトを実行するため、Stagingのロールバックでは変更されない。必要なら`systemctl start`で個別に再実行 | なし |

本記録の受入は本番・MVPを一切変更していないため、**この受入自体に起因する本番のロールバックは不要**です。本番反映（`deploy-local.sh`）のロールバックは[ローカルデプロイ運用メモ](../deployment-local.md)の手順に従います。

## 7. 残課題

| # | 残課題 | 現状と次アクション |
| --- | --- | --- |
| 1 | **本番反映（`scripts/deploy-local.sh`）が未実施** | 本記録作成時点では、本番/MVPは`246b88a`のまま。受理した`625e7c3`を本番・MVPへ反映するのはコードのマージとは別のHuman Gate。本番反映を実施したら、**最終commit**を本節へ追記する（2026-10-23時点: 未反映） |
| 2 | **staging-monitorのスクリプト依存** | 監視・バックアップ・復元ドリルは本番ツリーのスクリプト（`scripts/check-staging-health.sh`等）を実行するため、スクリプトの更新は本番デプロイ後に反映される（ADR-0006 §3-5、[deployment-local.md](../deployment-local.md)の既知の制約）。2026-10-16時点は本番worktreeが古く`exit 127`だったが、2026-10-23は本番worktree `78dd2d3`に同スクリプトが存在し、手動実行はsuccess。監視ユニットの`WorkingDirectory`を独立ランタイムへ移すかは**未決**（別途判断） |
| 3 | **Service Tokenを使う公開URL E2Eが未実施** | 今回のE2Eは`--local`（トークン不要）のみ。公開URLの画面検証（`npm run test:e2e:staging`、Access Service Token）はトークン値がログに残らないようオーナーがローカルで実施する必要があり、**2026-10-23時点でも未実施**（[staging-e2e.md](staging-e2e.md) §3、[staging-bringup.md](staging-bringup.md) §12） |

## 8. 参照文書

- [ADR-0006: Stagingを独立リリースチャネルにする](../adr/ADR-0006-staging-independent-release-channel.md)（本受入の設計）
- [ADR-0005: Staging環境の設計](../adr/ADR-0005-staging-environment.md)（用途・分離境界・Access・DB・定期ジョブ）
- [Staging構築手順書](staging-bringup.md)（§7 独立リリース移行、§10 検証チェックリスト）
- [Staging E2Eと公開境界の検証](staging-e2e.md)（受入で使う検証コマンド）
- [ローカルデプロイ運用メモ](../deployment-local.md)（`deploy-staging.sh` / `deploy-local.sh` の運用手順）
