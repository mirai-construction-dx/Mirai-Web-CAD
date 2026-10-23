# ADR-0006: Stagingを独立リリースチャネルにする

## ステータス

承認済み(Accepted、2026-10-23) — オーナーの「CTOへ全権委譲」指示(2026-10-23)のもと、CTOが決定。

- 関連: [ADR-0005](ADR-0005-staging-environment.md)(Staging環境の設計)
- 置き換える範囲: ADR-0005 §2 の「Stagingサービスは本番と同じ作業ツリーの `dist/` と `node_modules/` を使う(`deploy-local.sh` が3系統を一括で切り替える)」という記述、および `deploy-local.sh` の3系統一括切替。ADR-0005 のその他の決定(用途、分離境界、Access、DB、定期ジョブ)は維持する。

## コンテキスト

ADR-0005 で Staging を追加し、2026-10-16 にホストへ構築した。Staging の目的は「**本番と同一構成で、リリース候補・migration・デプロイ手順を本番反映前に検証する**」ことである。

しかし構築後の実測(2026-10-23)では、次の構造的な矛盾が残っていた。

1. 本番(`mirai-web-cad.service`)、MVP(`mirai-web-cad-mvp.service`)、Staging(`mirai-web-cad-staging.service`)は、**同じ作業ツリー** `/home/kensan/Projects/Mirai-Construction-DX/Mirai-Web-CAD` の `dist/` と `node_modules/`(いずれも `.releases/<sha>/` へのsymlink)を共有している。
2. `scripts/deploy-local.sh` は3系統を**一度に**同じcommitへ切り替える。Stagingだけを先に新しいcommitへ更新することはできない。
3. したがって「Stagingでリリース候補を検証してから本番へ反映する」という順序を、コードと手順の両面で保証できない。Stagingが検証できるのは、本番と同じcommitが既に配信された後になる。

2026-10-23時点の実測:

| 項目 | 本番 | MVP | Staging |
| --- | --- | --- | --- |
| サービス | active | active | active |
| ポート | 18812 | 18813 | 18814 |
| 配信中commit | `246b88a` | `246b88a` | `246b88a` |
| 作業ツリー | 共有 | 共有 | 共有 |
| DB | `mirai_web_cad` | `mirai_web_cad_mvp` | `mirai_web_cad_staging` |

`main` は `4f8982a` まで進んでいるが、3環境とも `246b88a` を配信している。Stagingだけ `4f8982a` を先に配信して受け入れる手段が無い。

## 選択肢

| 案 | 内容 | 影響 |
| --- | --- | --- |
| A. 3系統一括のまま | `deploy-local.sh` で常に3環境を同時に更新する | 追加実装は不要。ただしStagingは「本番前の検証」に使えず、ADR-0005の目的を満たさない |
| B. Staging専用ランタイムを分離する | Stagingだけ別ディレクトリのリリースを持ち、`deploy-staging.sh` で先行デプロイする。本番は `deploy-local.sh` で別途反映する | ビルド成果物が増える(ディスク)。Stagingと本番で配信commitが異なる期間が生まれる。手順が2つに分かれる |
| C. CIのエフェメラル検証だけで代替する | 常設Stagingをやめ、CIでmigration・E2Eを回す | ホスト資源は減る。Access保護下の手動UAT・migration適用後状態・デプロイ手順のリハーサルはできない |

## 決定

**案Bを採用する。** Stagingを本番・MVPから独立したリリースチャネルにする。

### 1. 構成

| 項目 | 本番/MVP | Staging(変更後) |
| --- | --- | --- |
| 作業ツリー | `/home/kensan/Projects/Mirai-Construction-DX/Mirai-Web-CAD` | `/home/kensan/.local/share/mirai-web-cad/staging-runtime/current` |
| リリース実体 | `.releases/<sha>/` | `~/.local/share/mirai-web-cad/staging-runtime/releases/<sha>/` |
| 切替単位 | `dist/`・`node_modules/` のsymlink | `current` symlink(原子切替) |
| デプロイ手順 | `scripts/deploy-local.sh`(本番+MVP) | `scripts/deploy-staging.sh`(Stagingのみ) |
| 配信commit | 本番反映のたびに更新 | リリース候補ごとに独立更新 |

- Stagingのリリースは `git archive <sha>` から構築し、`npm ci --ignore-scripts` と `BUILD_COMMIT=<sha> npm run build` を実行する。稼働中のStagingツリーではビルドしない。
- `current` symlinkの切替は `ln -sfn` + `mv -Tf` の1操作で行い、途中状態を配信しない。
- 再起動は `mirai-web-cad-staging.service` のみ。本番・MVPのサービスとsymlinkには触れない。
- 失敗時は `current` を直前のリリースへ戻し、Stagingサービスを再起動してhealthを再検証する。本番・MVPは変更しない。
- 古いリリースは直近3件とロールバック先を残して削除する。

### 2. 昇格フロー

1. `npm run deploy:staging -- <candidate-sha>` でStagingだけを候補commitへ更新する。
2. Stagingで受け入れる:
   - `bash scripts/check-staging-readiness.sh` が exit 0
   - `npm run db:check` がStaging DBで成功
   - Stagingのhealthが `ok=true`、`db.mode=connected`、DB名 `mirai_web_cad_staging`、`deploy.distCommit` が候補commitと一致
   - 公開URL `https://mirai-web-cad-stg.mirai-dx-platform.com` が未認証で302(Access)
   - 必要なE2E(ローカル/公開境界)が成功
3. 受け入れ後、`npm run deploy:local` で本番・MVPへ同じcommitを反映する(本番デプロイは別のHuman Gate)。
4. Stagingは本番より先行してよい。本番反映後は同じcommitになる。Stagingから本番へデータを昇格させない。

### 3. 分離境界(ADR-0005 §3を維持)

1. Stagingは専用DB `mirai_web_cad_staging` のみを読み書きする。本番・MVPのDBへ接続しない。
2. Stagingは本番・MVPと別のsystemd unit・envファイル・バックアップディレクトリ・作業ツリーを持つ。
3. 本番・MVPのDNS/Access/Ruleset設定を変更しない。
4. Stagingのバックアップは `/var/backups/mirai-web-cad/staging-postgres` に14日保持し、R2オフサイト転送の対象には当面含めない。
5. 監視(`mirai-web-cad-staging-monitor.service`)・バックアップ・鮮度検査・復元ドリルも、独立ランタイムの `current` にあるスクリプトを実行する。本番worktreeの更新に依存しない。これらはStagingのAPI・DB・公開境界・バックアップだけを扱い、本番・MVPを変更しない。

### 4. 変更する資産

- 新規: `scripts/deploy-staging.sh`、Stagingランタイム用ディレクトリ、`deploy:staging` npm script
- 変更: `deploy/systemd/mirai-web-cad-staging.service`(WorkingDirectory)、`scripts/deploy-local.sh`(Stagingを対象外)、`scripts/check-staging-config.sh`、`scripts/check-staging-readiness.sh`、`scripts/lib/deploy-info.mjs`(git情報が無い配信物のcommitフォールバック)、`docs/deployment-local.md`、`docs/runbooks/staging-bringup.md`、テスト
- 維持: ADR-0005のAccess Application/Policy、DB、バックアップ、監視、復元ドリル

### 5. Human Gate

- Stagingへの先行デプロイは、Staging専用のリソースだけを変更する可逆操作であり、本番デプロイではない。ただし初回のsystemd unit変更とランタイム作成はホスト変更のため、オーナーの包括委譲(2026-10-23「CTOに全権委譲」)の範囲でCTOが実施し、結果を記録する。
- 本番・MVPへの反映(`deploy-local.sh`)は、従来どおりコードのマージとは別のHuman Gateとする。2026-10-23の包括委譲に基づき、CTOが実施する場合も事前にbackupと`db:check`を通す。

## 結果

- Stagingは本番前に候補commitを配信し、migration・health・Access境界・E2Eを検証できる。
- 本番とStagingの配信commitが一時的に異なることがある。healthの `deploy.commit` / `deploy.distCommit` と`check-staging-readiness.sh` で確認できる。
- ビルド成果物と`node_modules`がStaging用に追加で必要になる(1リリースあたり数百MB、直近3件を保持)。
- `deploy-local.sh` は本番+MVPのみを扱う。Stagingを本番と同時に更新したい場合は、`deploy:staging` の後に `deploy:local` を実行する。
- 既存の `mirai-web-cad-staging-monitor.service` / backup / restore-drill は変更せず、引き続き成功を維持する。
- ADR-0005の目的・分離境界・定期ジョブは維持される。本ADRは配信方式だけを変更する。

## 受け入れ条件

- [x] Stagingだけをcommit Xへ更新し、本番・MVPがcommit Yのままであることをhealthで実測できる（2026-10-23: Staging=`625e7c3` / 本番・MVP=`246b88a`。受入記録§5.1）
- [x] `deploy-staging.sh` の失敗時にStagingが直前のcommitへ戻り、本番・MVPが変化しない（`tests/deploy-staging.test.js`のrollbackテスト）
- [x] `scripts/check-staging-config.sh` がCIで成功し、`deploy-local.sh` がStagingを参照しないことを検査する
- [x] `scripts/check-staging-readiness.sh` がexit 0を維持する（2026-10-23 09:13、5ユニットのWorkingDirectory=currentを確認）
- [x] Stagingの監視・バックアップ・復元ドリルが引き続き成功する（2026-10-23 09:13、独立ランタイム移行後に4ジョブを手動実行して成功。受入記録§4.2）
- [x] 本番デプロイ(`deploy-local.sh`)が本番+MVPだけを更新し、Stagingを再起動しない（2026-10-23: Stagingの`ActiveEnterTimestamp=09:01:00`のまま。受入記録§4.1）
