# Core Release intake（取込み可否判定）

更新日: 2026-10-23。状態: **読み取り専用CLIと単体テストを実装済み。Core成果物の取込みは未実施**。
関連: [基盤連携の要件と現状](platform-integration.md) §3・§6.2、[Core evidence エクスポート](core-evidence-export.md) §4.1・§11、[外部入力・確定待ち台帳](../external-input-status.md) §4、[AGENTS.md](../../AGENTS.md) §1・§3。

## 1. 目的と非目標

目的:

- Mirai-Harness-Core の GitHub Release を Web-CAD が取り込めるかを、**読み取り専用**で機械判定する。
- 判定根拠（Release、asset、SHA256、attestation、署名鍵、core-lockの有無）を人間向け／JSONで残す。
- `v0.8.0` の実測結果を記録し、Coreへの依頼（[Mirai-Harness-Core Issue #98](https://github.com/mirai-construction-dx/Mirai-Harness-Core/issues/98)）と対応付ける。

非目標（このCLIでは実施しない）:

- Releaseのダウンロード物をリポジトリへ配置する、`core-lock/` を作る、Core schemaをコピーする。
- attestationの暗号学的検証（署名者・identity・rekorの検証）。本CLIは**存在確認まで**。
- 本番・ステージング環境、DB、envファイル、秘密値へのアクセス。
- Core成果物の送信、MCIP/CDEへの接続。

## 2. 使い方

```bash
# 既定: Latest Release を確認（人間向け出力）
node scripts/check-core-release.mjs

# タグを固定（Coreの版を明示）
node scripts/check-core-release.mjs --tag v0.8.0

# JSONで出力（CI・記録用）
node scripts/check-core-release.mjs --tag v0.8.0 --json

# NO-GOなら終了コード1（取込みゲートとして使う）
node scripts/check-core-release.mjs --tag v0.8.0 --strict
```

| オプション | 内容 |
| --- | --- |
| `--tag <tag>` | 確認するReleaseタグ（`vX.Y.Z`）。省略時はLatest。 |
| `--repo <owner/name>` | 対象リポジトリ。既定は `mirai-construction-dx/Mirai-Harness-Core`。 |
| `--json` | 判定結果をJSONで標準出力へ出す。 |
| `--strict` | NO-GOのとき終了コード1。省略時は判定レポートとして0。 |
| `-h`, `--help` | ヘルプ。 |

終了コード:

| コード | 意味 |
| --- | --- |
| 0 | GO。またはNO-GOだが`--strict`未指定（判定レポート）。 |
| 1 | `--strict`指定時のNO-GO。引数エラー。Release情報そのものを取得できない（判定不能）。 |

前提:

- Node.js >= 20（`package.json` の `engines`）。
- 認証済みの `gh` CLI（Releaseの閲覧と`attestations`の読み取り権限）。CLIは`gh release view` / `gh release download` / `gh api` だけを実行する。
- 認証情報は`gh`の既存設定に任せる。CLIはトークン・envファイルを読まず、外部コマンドの出力に含まれ得る秘密値風の文字列を伏せる。

2026-10-23の`v0.8.0`実測時の出力例（`NO-GO`）:

```text
Core release intake checker: mirai-construction-dx/Mirai-Harness-Core
  要求: v0.8.0 / 解決: v0.8.0
  contracts.tar.gz SHA256: a049de95ae21bbc3bdf6bc644486679c5ca8a5b55e72c0479ce8a37cff201487
  SHA256SUMS の記載 : a049de95ae21bbc3bdf6bc644486679c5ca8a5b55e72c0479ce8a37cff201487
  core-lock: なし
判定: NO-GO
チェック:
  [OK] Releaseの特定: Release v0.8.0 を確認しました。
  [OK] 必須assetの存在: 必須asset(SHA256SUMS, contracts.tar.gz)を確認しました。
  [OK] SHA256SUMSの解析: 8件の記載を読み取りました。
  [OK] contracts.tar.gzのSHA256照合: contracts.tar.gzのSHA256がSHA256SUMSと一致しました。
  [NG] attestationの存在: attestationがありません(404)。
  [NG] 署名鍵(signing-keys.yaml): keysが空です(署名鍵未登録)。
  [INFO] Web-CADのcore-lock: core-lockは未作成です(取込み未実施)。
NO-GO理由:
  - attestationの存在: attestationがありません(404)。
  - 署名鍵(signing-keys.yaml): keysが空です(署名鍵未登録)。
```

## 3. 判定基準

GOは「必須チェックがすべて成功」のときだけ返す。1つでも失敗すればNO-GOとし、失敗理由を列挙する。

| チェック | 必須 | GOの条件 | NO-GOの例 |
| --- | --- | --- | --- |
| `release` | はい | Releaseを特定でき、要求タグと一致し、draft/prereleaseでない | タグ不一致、draft、prerelease |
| `assets` | はい | `SHA256SUMS` と `contracts.tar.gz` がRelease assetにある | asset欠落 |
| `sha256sums` | はい | `SHA256SUMS` の全行を解釈できる | 形式違反行、重複 |
| `checksum` | はい | `contracts.tar.gz` の実SHA256が`SHA256SUMS`の記載と一致 | 不一致、取得・計算失敗 |
| `attestation` | はい | `repos/<repo>/attestations/sha256:<digest>` にattestationがある | 404、空配列、確認不能 |
| `signing_keys` | はい | `registries/signing-keys.yaml` の`keys`が非空 | `keys: []`、ファイルなし、形式不正 |
| `core_lock` | いいえ（情報） | — | —（判定に影響しない） |

補足:

- **SHA256SUMSの一致は「改ざんされていない」証明ではない。** `SHA256SUMS` 自体が署名されない限り、両方が差し替えられ得る。真正性のゲートはattestationと署名鍵であり、本CLIはその存在を確認する。
- **attestationの存在確認は暗号学的検証ではない。** 将来Coreがattestationを提供したら、`gh attestation verify` 等で署名者・リポジトリ・workflow identityを検証する手順を別途追加する（本CLIのスコープ外）。
- Latest（`--tag`省略）は最初に解決したタグを以後の取得に使う。判定中にLatestが動いても別タグのassetを混ぜない。
- タグは`vX.Y.Z`（`-`/`+`の接尾辞を許容）に限定する。任意文字列を`gh`へ渡さない。
- `core-lock`の有無は情報表示のみ。GO/NO-GOを変えない。

## 4. v0.8.0 の実測（2026-10-23）

`node scripts/check-core-release.mjs --tag v0.8.0` と読み取り系コマンドで確認した。公開情報のみを扱い、秘密値・PIIは含めない。

| 確認項目 | 実測結果 | 根拠 |
| --- | --- | --- |
| Release | `v0.8.0`（Latest、`2026-10-19T06:16:03Z`公開、`targetCommitish: main`） | `gh release view v0.8.0` |
| タグのcommit | `829c85873600e4819daded177714dd17c1b09b91` | `gh api repos/.../git/ref/tags/v0.8.0` |
| 必須asset | `SHA256SUMS`・`contracts.tar.gz` あり（全9 asset） | `gh release view v0.8.0 --json assets` |
| `contracts.tar.gz` のSHA256 | `a049de95ae21bbc3bdf6bc644486679c5ca8a5b55e72c0479ce8a37cff201487` | `gh release download` → 実計算 |
| SHA256SUMS照合 | 一致（`SHA256SUMS`は8エントリ） | `check-core-release.mjs` |
| attestation | **なし**。`/attestations/sha256:<digest>` が404（v0.7.0の`contracts.tar.gz`も404） | `gh api repos/.../attestations/sha256:<digest>` |
| 署名鍵 | **なし**。`registries/signing-keys.yaml` が `keys: []` | 同タグのファイル |
| 署名生成経路 | `release.yml` の`build`ジョブが`if: false`（`sign_policy_bundle.py`と`actions/attest-build-provenance`はその中） | 同タグの`.github/workflows/release.yml` |
| evidence schema | `schemas/evidence/ai-run.schema.json`（`$id: core.evidence.ai_run/1`）の`source_system`が`const "mcah"` | 同`contracts.tar.gz`を展開 |
| 利用側の版宣言 | Web-CADは`{declared_version: null, overall: "宣言なし"}` | 同タグの`registries/integration-baseline.json` |
| Web-CADの`core-lock` | **未作成** | リポジトリ直下に`core-lock/`がない |

判定結果:

- 構成: `release`・`assets`・`sha256sums`・`checksum` がOK、`attestation`・`signing_keys` がNG、`core_lock`はINFO。
- 判定: **NO-GO**。
- 終了コード: 既定は0（判定レポート）、`--strict`は1。
- 出力確認: JSON・人間向け出力・stderrにトークン・接続文字列等の秘密値風文字列がないこと、一時ディレクトリが残らないことを確認した。

Coreへの依頼は Issue #98（attestation付きRelease、consumer別evidence schemaまたは`source_system`制約の緩和、schema版・検証手順の提示）として起票した。署名有効化の既存依頼はCore Issue #83、0.8.0の取込み追跡はCore Issue #76。

## 5. NO-GO時の方針（core-lockを作らない）

- **NO-GOのReleaseは取り込まない。`core-lock/` を作らない。** 取り込んでいないものを固定すると、実態と合わない記録になる（[platform-integration.md](platform-integration.md) §3）。
- Core schemaのコピー・改変・`contracts/`の手編集をしない（AGENTS.md §1・§5）。
- `schema: "core.evidence.ai_run/1"` を名乗らない。Web-CADの射影は引き続き`schema: null` / `schema_status: "unsupported"` とする（[core-evidence-export.md](core-evidence-export.md) §4.1）。
- MCIP等への証跡送信も行わない（[core-evidence-export.md](core-evidence-export.md) §10）。
- `--strict`をCIのゲートに使う場合も、**判定できないものを成功として扱わない**（Release情報を取得できない場合は終了コード1）。
- Coreが依頼に対応してGOになった後、別PRで`core-lock/`を作成し、Releaseタグ・digest・attestationの検証結果を記録する。その時点で`platform-integration.md` §3・§6.2と本docを更新する。

## 6. 実装とテスト

変更ファイル:

- `scripts/check-core-release.mjs` — 読み取り専用CLI。引数検証、`gh`実行（注入可能）、SHA256SUMS解析、SHA256照合、attestation存在確認、署名鍵確認、core-lock情報、GO/NO-GO、`--json`、`--strict`、秘密値の伏せ字、一時ディレクトリ削除。
- `tests/core-release.test.js` — 実ネットワーク不要の単体テスト。外部コマンドは`runGh`として注入する。
- `docs/architecture/core-release-intake.md` — 本文書。

テストの観点:

- 引数（既定・`--tag`・`--repo`・`--json`・`--strict`・不正値・重複・不明引数）。
- SHA256SUMSの正常行・コメント・空行・大文字digest・形式違反・重複。
- SHA256の一致・不一致・記載なし・計算不能。
- 署名鍵の`keys: []`（インライン/ブロック）、非空（ブロック/フロー）、欠落・不正形式。
- attestationの200（1件/空）・404・その他エラー・不正JSON。
- GO（全条件成立）、NO-GO（attestation 404、署名鍵空、SHA256不一致、asset欠落、draft/prerelease）。
- core-lockの有無が判定を変えないこと。
- 一時ディレクトリの削除（成功時・download失敗時）。
- 秘密非出力（外部コマンド出力のトークン、Release取得失敗のエラー、`--help`実行時の環境トークン）。
- `--strict`の終了コード（NO-GOで1、既定で0）。

実行結果（worktree `.wt-core-intake`、2026-10-23）:

| コマンド | 結果 |
| --- | --- |
| `node --test tests/core-release.test.js` | 24 tests / 24 pass / 0 fail |
| `npm run lint` | `lint ok` |
| `npx eslint scripts/check-core-release.mjs tests/core-release.test.js` | エラー0 |
| `npm run typecheck` | 成功 |
| `node scripts/check-core-release.mjs --tag v0.8.0` | NO-GO / exit 0 |
| `node scripts/check-core-release.mjs --tag v0.8.0 --strict` | NO-GO / exit 1 |

## 7. 残リスク・既知の制約

- **attestationは存在確認のみ**。署名者・workflow identity・rekorの検証は未実装。Coreがattestationを提供した後の受入では、`gh attestation verify`等の検証を追加する。
- **SHA256SUMSは署名されていない**。ハッシュ一致は整合性の確認であり、配布物の真正性はattestation/署名鍵に依存する。
- **`gh`の認証・権限・ネットワークに依存**。Release情報を取得できない場合は「判定不能」として終了コード1にし、GOにしない。
- **タグ形式を`vX.Y.Z`に限定**。CoreのReleaseタグはこの形式だが、別形式のタグを運用する場合は引数検証を更新する。
- **`signing-keys.yaml`はトップレベルの`keys`だけを見る最小パーサ**。YAML全体のschema検証はしない。複雑な形式（アンカー・マージキー等）は想定しない。
- **LatestのTOCTOU**は、解決したタグを以後の取得に固定することで限定している。それでもRelease公開直後の差し替えはGitHub側の履歴に依存する。
- **CI組込みは未実施**。`--strict`を定期ジョブへ入れる場合は、`gh`認証と実行頻度（APIレート）を別途設計する。

## 8. 関連

- [Mirai-Harness-Core Issue #98](https://github.com/mirai-construction-dx/Mirai-Harness-Core/issues/98)（本件の依頼）
- [Mirai-Harness-Core Issue #83](https://github.com/mirai-construction-dx/Mirai-Harness-Core/issues/83)（リリース署名の有効化）
- [Mirai-Harness-Core Issue #76](https://github.com/mirai-construction-dx/Mirai-Harness-Core/issues/76)（Core 0.8.0の公開と取込み）
- [基盤連携の要件と現状](platform-integration.md) §3・§6.2
- [Core evidence エクスポート](core-evidence-export.md) §4.1・§10・§11
- [外部入力・確定待ち台帳](../external-input-status.md) §4
- [AGENTS.md](../../AGENTS.md) §1・§3・§5
