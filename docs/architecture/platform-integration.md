# 基盤連携の要件と現状(全体構成 V3.6 / リポジトリ構成 V3.6 / OS・アプリ選定 V3.5)

更新日: 2026-10-23。基盤の設計文書がMirai-Web-CADに求める他リポジトリとの連携を抽出し、現状との差を記録する。
正本の文書は複製しない(下表)。判断が必要な事項は推測で確定せず、[外部入力・確定待ち台帳](../external-input-status.md)の「4. 基盤V3.6との整合」に記録する。
§2〜§5は主に2026-09-25時点の記録で、§6に2026-10-23の再実測(他Repositoryのorigin/main・最新Release・稼働状態)をまとめる。再実測で変わった箇所は§2・§3・§4にも反映した。

| 文書 | 正本(複製しない) |
| --- | --- |
| 全体構成 V3.6 | `mirai-construction-dx/Mirai-Construction-DX-Portfolio` `docs/baseline/source-snapshots/`(commit `4d87890`、mainに含まれる) |
| リポジトリ構成 ベストプラクティス V3.6 | 同上 |
| OS・アプリケーション選定 ベストプラクティス V3.5 | `mirai-construction-dx/Mirai-Platform-Infra` 直下(commit `9ba5375`、mainに含まれる) |
| 組織構成 最終構成案 | 基盤プロジェクト資料(リポジトリ外) |

## 1. Web-CADの位置付け

- 全体構成 V3.6 / リポジトリ構成 V3.6 の一覧で **08 Mirai-Web-CAD(Domain Product)**。接続は第3段階。
- 正本として持つのは**編集中の2D図面**。確定版はCDEへ登録する。案件ID・承認・証跡の正本はMCIPで、Web-CADは参照する側。
- リポジトリ構成 V3.6「許可する接続は原則4種類」: ①Coreの版付き成果物をビルド/起動時に取り込む、②実行時はAPI/MCP/Tool Gateway、③データは正本API・CDE参照から取得、④イベントは版付きschemaを介す。DB直結・他Repoコード直参照・独自ベタ結合は禁止。
- 同「禁止」: Agentから他システムDBへの直接接続、**Domain ProductからAI Providerを直接呼ぶこと**、git submoduleやmain branchの直接参照による契約共有。Core/Infraの正本をConsumerが上書きしない。
- 全体構成 V3.6 / リポジトリ構成 V3.6: mainへの直接push禁止。Branch → PR → CI → Human Review → Merge。通常変更は2名、重要変更は3名の人間レビューを基本とする。

## 2. 要件と現状(2026-09-25時点、ファイルで確認)

| 要件 | 現状 | 根拠・備考 |
| --- | --- | --- |
| 短い入口の`CLAUDE.md`と、build/test規約の`AGENTS.md` | **充足(本PR)** | リポジトリ直下 |
| 他システムDBへ直結しない | 充足 | 接続先は自DB(`mirai_web_cad`)のみ |
| migrationは自schemaだけ | 充足 | `migrations/`は自DBのみ。additive・後方互換 |
| main直接push禁止・必須CI | 充足 | Branch Protection(必須チェック5件+strict)とRuleset(必須チェック10件) |
| ActionのSHA固定、Secret Scan | 充足 | `.github/workflows/ci.yml` |
| SBOM | 一部 | CycloneDX SBOMはCIで生成。署名・Attestationは無い |
| マージ前の人間レビュー(通常2名/重要3名) | 未充足(リスク受入れ済み) | 2026-09-30に中央ポリシー v2 の自動マージへ統一(A型を廃止。Required Checksの全成功とconflictなしのみを条件とし、人間のApproveを待たない。[GITHUB_POLICY.md](../../GITHUB_POLICY.md) §2)。2人目は2026-10以降に決定、見直し期限2026-10-31([外部入力・確定待ち台帳](../external-input-status.md)§4) |
| CODEOWNERSはTeam指定 | 一部(個人指定) | CODEOWNERはレビュー依頼先(承認は必須でない、2026-09-30)。当面は個人`@Kensan196948G`、2人目の決定時にTeamへ移す |
| AIの結果の反映に人間承認(承認者の分離・承認記録) | **未充足** | 反映には利用者の明示操作が必要だが、編集権限があれば誰でも適用でき、オフライン時は承認記録を残さない([ADR-0003](../adr/ADR-0003-ai-provider-direct-call-interim.md)) |
| AIはModel Gateway(MCAH)経由。キーを持つのはGatewayのみ | **承認済み例外(期限付き)** | `src/ai-provider.js`がOpenAI/Anthropicを直接呼び、本番はキーを保持。[ADR-0003](../adr/ADR-0003-ai-provider-direct-call-interim.md)(承認済み、見直し期限2026-12-25) |
| Coreの版付き成果物を版・digest固定で取り込む(`core-lock/`等) | 未対応(利用対象なし) | Web-CADはCoreの契約(event/evidence/MCP)をまだ使っていない。取込み時の手順は§3。2026-10-23時点のLatest `v0.8.0`も署名・attestationが無く取込み条件を満たさない(§6.2) |
| 基盤の台帳(Core `registries/systems.yaml`等)への登録 | **登録済み** | system_idは`web-cad`(2026-09-25オーナー決定)。**Core PR #27は2026-09-28にマージ済み(登録完了)**。Platform-Infraの`systems.yaml`にも`web-cad`が登録済み(`uses_core: false`、2026-10-12追加。2026-10-23実測、§6.6) |
| MCPサーバー公開(契約はCoreで版管理、`server_id`+`tool_name`のAllowlist) | 未対応 | 第3段階。ツール仕様は文書に無い |
| 案件IDはMCIPが発番 | 不整合(将来) | `migrations/0001`の独自`projects`と`0007`の`project_members` |
| 確定版をCDEへ登録 | 未対応 | CDE連携なし。承認済み版はWeb-CAD内で保持 |
| UI→Agent→Tool→DBまで相関IDを維持 | 一部 | APIは`x-request-id`を受け取り応答へ返す(`src/api-handler.js`)。監査・AI Runへの保存と下流への伝搬は未対応 |
| 証跡の共通項目(Core evidence schema) | 一部 | 対応表は§4 |
| 技術標準(OS・アプリ選定 V3.5) | 承認済み例外・更新計画あり | PostgreSQL 16、Node 22(CI)/`engines >=20`、vanilla JS、実行時にNode APIを使用。[ADR-0004](../adr/ADR-0004-tech-stack-vs-os-selection.md)(承認済み: アプリ構成は例外として維持、Node 24へ2027-01-31・PostgreSQL 18へ2027-11-30までに更新) |
| SSOはEntra ID → Cloudflare Access | 一部 | Cloudflare Accessは稼働。Entra連携の実装(`src/entra-graph.js`)はあるが対象利用者のtenant登録は未完了(台帳§2) |

## 3. Coreの版付き成果物を取り込むときの手順(未実施)

現時点でWeb-CADが利用するCore成果物は無いため、lockファイルは置かない(使っていないものを固定すると実態と合わない記録になる)。取り込むときは次による。

決定(2026-09-25、台帳§4の6): **CoreのGitHub Releaseからのみ取り込む**。タグの内容をvendoringする方式(他Consumerの暫定方式)は使わない。

1. 取り込む契約(例: `schemas/evidence/*`、`schemas/event/envelope.schema.json`、MCP tool定義)と、それを含むReleaseを選ぶ。必要な版がReleaseされていなければCoreへRelease作成を依頼する(2026-10-23時点のLatestは`v0.8.0`、2026-10-19公開。§6.2)。
2. Releaseの`SHA256SUMS`で成果物のハッシュを照合し、Coreの利用者ガイド(`docs/consumer-guide.md`)の手順どおり`contracts.lock.json`で版・ダイジェストを固定して`mhc verify`を通す。`contracts/`配下は取得物として手編集しない。`latest`・main直参照・submoduleは使わない。
3. **署名・来歴証明(attestation)の検証を必須とする**。CoreのRelease手順は`actions/attest-build-provenance`と署名に対応しているが、署名鍵の設定待ちで無効(`release.yml`のbuildジョブが`if: false`)。`v0.7.0`に加え、Latestの`v0.8.0`にもattestationが無い(2026-10-23に`/attestations/sha256:<digest>`が404。§6.2)。取り込む時点で署名・attestationが無いReleaseしか無い場合は、署名付きReleaseをCoreへ依頼し、それまで取り込まない。
4. CIで`mhc verify`とlockのダイジェスト照合を実行する。
5. system_idは`web-cad`(**Core PR #27で登録済み、2026-09-28 merge**)。

参考(照合用、取込みは未実施): Core Release `v0.8.0`(Latest)の`contracts.tar.gz`のSHA256は`a049de95ae21bbc3bdf6bc644486679c5ca8a5b55e72c0479ce8a37cff201487`(同Releaseの`SHA256SUMS`と一致、2026-10-23実測)。`v0.7.0`は`c98851835c2b2b3ebbaa0fcadb26581cb902026c98c0f621854e2396f749ce90`。

## 4. 監査・AI実行記録とCore evidence schemaの対応(現状)

Core `schemas/evidence/ai-run.schema.json`(`core.evidence.ai_run/1`)・`schemas/event/envelope.schema.json`(`core.event.envelope/1`)・`schemas/evidence/citation.schema.json`(`core.evidence.citation/1`)の必須項目に対する、Web-CADのDB列(`migrations/0001`ほか)の対応。Release `v0.8.0`の`contracts.tar.gz`を展開して`$id`と`required`を確認した(2026-10-23)。変換処理は未実装で、将来MCIPへ証跡を送る際の差分を示す。

`ai-run`の必須項目は`schema` / `event_id` / `source_system` / `run_id` / `request_id` / `project_id` / `requester_oid` / `skill` / `status` / `citations` / `verification` / `policy` / `models` / `usage` / `deployment` / `created_at`。`envelope`は`schema` / `specversion` / `id` / `source` / `type` / `time` / `data`。

| Core必須項目 | Web-CADの対応 | 状態 |
| --- | --- | --- |
| `schema` | 固定値(`core.evidence.ai_run/1`等)を出す変換は未実装 | 未対応 |
| `source_system` | `web-cad`(2026-09-25決定、Core PR #27で登録済み)。証跡への出力・変換は未実装 | 未対応(値は確定) |
| `event_id` / envelope `id` | `audit_logs.id`、`agent_runs.id` | 対応可 |
| `run_id` | `agent_runs.id` | 対応可 |
| `request_id` / `correlation_id` | APIの`x-request-id`はDBへ保存していない | 未対応 |
| `project_id` | `drawings.project_id`(独自の案件ID。MCIP発番ではない) | 一部 |
| `requester_oid` | `audit_logs.actor_id`、`agent_runs.created_by`(メール/ロール。Entra OIDではない) | 一部 |
| `status` / `created_at` / envelope `time` | `agent_runs.status`(received〜rolled_backの10状態)、`created_at` | 対応可(状態名の対応付けは要定義) |
| `skill` | `agent_runs.skill_id`、`skill_version` | 対応可 |
| `policy` | 承認・ポリシー判定の記録が無い(ADR-0003の移行で扱う) | 未対応 |
| `verification` / `citations` | 検証結果・引用の記録が無い(文書系の引用は`citation.schema.json`の必須8項目) | 未対応 |
| `models` / `usage` / `deployment` | `agent_runs.proposal`にengine程度のみ | 未対応(ADR-0003の移行で扱う) |

## 5. 本リポジトリ内で実施済み・今後の対応

- 実施済み: `CLAUDE.md`・`AGENTS.md`の新設、本文書、ADR-0003(承認済み)/0004(承認済み)、判断事項の台帳化と2026-09-25のオーナー決定の反映。
- 他リポジトリ・設計判断が必要(記録のみ。本リポジトリでは実施しない): 台帳§4を参照。

## 6. 他Repository連携の2026-10-23実測とStaging環境の位置付け

Staging環境([ADR-0005](../adr/ADR-0005-staging-environment.md))は**新しいリポジトリ間結合を追加しない**。上記「許可する接続は原則4種類」の枠内に留まり、接続形態は本番・MVPと同一である。2026-10-23時点でStagingは稼働しており(§6.8)、その事実はPortfolio catalogへ別途登録する(PORT-OPS-007)。

### 6.1 実測の条件

- 2026-10-23 08:25〜08:40 JSTに、各リポジトリの`origin`を`git fetch origin --prune`したうえで、read-onlyのコマンド(`git show`/`grep`/`gh release view`/`gh api`/`curl`/`systemctl show`)で確認した。他リポジトリの作業ツリー・main・本番環境は変更していない。
- 対象HEAD: Core `7e799e5`(main)、MCIP `eb876de`(main)、CDE `cd7e5e3`(master)、Portfolio `76a310b`(main)、Platform-Infra `6038d31`(main)、MCAH `6a5ece7`(main)、CEOS `0c6a3a6`(main)、CODIP `4f14b21`(main)、ArcSphere `bf537e2`(master)、Spatial Capture `4387a5d`(main)。
- 「observed」はコマンド出力で確認できた事実だけを指す。接続していないものは「未接続」、判断できないものは「未確認」と書く。

### 6.2 Mirai-Harness-Core(2026-10-23)

| 確認項目 | 実測結果 | 根拠 |
| --- | --- | --- |
| Web-CADのsystem登録 | **登録済み** | `registries/systems.yaml:11`(origin/main `7e799e5`): `- {id: web-cad, name: Mirai-Web-CAD, repo: Mirai-Web-CAD, audience: "api://web-cad", mcp_server_id: null, db_schema: mirai_web_cad}`。2026-09-28のPR #27で追加 |
| 最新Release | **`v0.8.0`(Latest、2026-10-19公開)** | `gh release list`。tag commit `829c858`、`targetCommitish: main`、公開`2026-10-19T06:16:03Z` |
| Release assets | 9件(VERSION、contracts.tar.gz、contracts.manifest.json、policy-bundle.tar.gz、docs.tar.gz、aibom.cdx.json、SHA256SUMS、Python wheel、TS tgz)。署名ファイル(`.sig`/`.asc`)は無い | `gh release view v0.8.0 --json assets` |
| `contracts.tar.gz`の実SHA256 | `a049de95ae21bbc3bdf6bc644486679c5ca8a5b55e72c0479ce8a37cff201487`。`SHA256SUMS`の記載・GitHub APIのasset digestと一致 | `gh release download v0.8.0` → `sha256sum contracts.tar.gz` → `sha256sum -c SHA256SUMS`(VERSION・manifest・contractsがOK)。`gh api repos/.../releases/tags/v0.8.0`(assetごとの`digest`を確認) |
| `contracts.manifest.json` | `tree_digest: sha256:cf3666a57e55e623c67fdcc205172da86b7e38d63bafb309211e88d301fb7e36`、56ファイル | 同Release asset |
| 証跡schemaの版 | `schemas/evidence/ai-run.schema.json`=`core.evidence.ai_run/1`、`schemas/event/envelope.schema.json`=`core.event.envelope/1`、`schemas/evidence/citation.schema.json`=`core.evidence.citation/1` | 同Releaseの`contracts.tar.gz`を展開し`$id`を確認 |
| attestation | **無い**。`contracts.tar.gz`と`SHA256SUMS`のdigestで`/attestations/{digest}`が404(v0.7.0の`contracts.tar.gz`も404) | `gh api repos/mirai-construction-dx/Mirai-Harness-Core/attestations/sha256:<digest>` |
| 署名鍵 | **未設定**。`keys: []` | `registries/signing-keys.yaml`(origin/mainと`v0.8.0`の両方) |
| 署名・attestationの生成経路 | 無効。`release.yml`のbuildジョブが`if: false`で、`sign_policy_bundle.py`と`actions/attest-build-provenance`はその中にある | `.github/workflows/release.yml`(origin/main) |
| 利用側の版宣言 | Web-CADは**宣言なし**。`{system_id: web-cad, declared_version: null, overall: "宣言なし"}` | `registries/integration-baseline.json`(v0.8.0のRelease assetとorigin/main) |
| MCP allowlist | **未登録**(`mcp_server_id: null`) | `registries/mcp-allowlist.yaml`に`web-cad`が無い |

**結論**: Web-CADはCoreの台帳に`web-cad`として登録済みだが、Core成果物の取り込み・版宣言・MCP公開は未実施。`v0.8.0`はReleaseとして公開されたが署名・attestationは無く、`registries/signing-keys.yaml`も空のため、§3の取込み条件(署名付きRelease)を満たさない。**2026-10-23時点でも取り込まない。**

### 6.3 MCIP(2026-10-23)

| 確認項目 | 実測結果 | 根拠 |
| --- | --- | --- |
| 対外案件ID API(発番・配布) | **未実装** | `docs/architecture/V3.2整合性評価.md:14`: 案件コンテキストの正本は`projects`/`assets`/`project_members`で実装済みだが「全社共通の案件 ID を他システムへ配る API は未実装」 |
| 案件の読み取りAPI | **ある(読み取りのみ)** | `api/src/app-api.ts:686` `GET /api/v1/projects`(自分に見える案件のみ、RLS)、`:748` `GET /api/v1/projects/:code`。作成・発番のAPIは無い |
| OpenAPI定義 | **リポジトリに無い** | `find . -iname "*openapi*"`が0件(2026-10-23)。API仕様はコードと文書が正本 |
| Tool API | 読み取り専用`POST /api/v1/tools/call`がある | `api/src/tool-api.ts:803`、`Mirai-Construction-Information-Platform/docs/architecture/ADR-0001-mcip-tool-api-readonly.md`。`mcip.document.search`等。Web-CADは未登録・未接続 |
| Core契約のpin | `0.7.0`(`supported_core: ">=0.7.0 <0.8.0"`) | `core.lock.json:11,16`。`v0.8.0`は未採用 |
| Web-CADへの言及 | コード・台帳には無い(設計スナップショットHTMLのみ) | `grep -rn -i "web-cad" registry/ api/src/`が0件 |

**結論**: MCIPは案件の読み取りAPIを持つが、Web-CADが使う「全社共通の案件IDを発番・配布するAPI」は無い。Web-CADの`projects`は自採番のまま(§2)であり、対外IDの連携は**外部入力待ち**。

### 6.4 CDE(2026-10-23)

| 確認項目 | 実測結果 | 根拠 |
| --- | --- | --- |
| Core契約のpin | `0.7.0` | `core-lock/contracts.lock.json`(`core_version: 0.7.0`、`tree_digest: sha256:9115a28b…24fe`、`attestation: null`、`policy_bundle_key_id: null`、`pulled_at: 2026-10-17`) |
| Stagingの稼働 | **稼働中(内部)** | `systemctl is-active cdp-stg`=active、`docker ps`で`cdp-stg-*`の5コンテナが5日稼働・healthy、`curl http://127.0.0.1:18983/healthz`=`{"status":"ok","service":"civil-docs-platform","environment":"staging"}` |
| Stagingの公開入口 | **未提供** | `https://cdp-stg.mirai-dx-platform.com/`への接続はプロキシでCONNECT失敗(502)。CDEの`docs/operations/staging.md`§1.1の「DNS未作成・connector未起動」と整合。公開疎通は**未確認** |
| 承認済み版の登録API | **Web-CAD向けのAPI/ツールは無い** | REST API(`cdp/api/documents.py`等)とMCPツール(`mcp/tools.lock.json`の6ツール)はあるが、版の承認・登録を外部システムへ提供するツールは無い。CDE側にWeb-CADのクライアント登録も無い(`grep -rn -i "web-cad"`がコード・文書で0件) |
| 認証 | 利用者トークン(Entra)前提。非対話用のclient_credentials設定はあるが、Web-CAD用のアプリ登録は未確認 | `cdp/auth.py`、`cdp/config.py` |

**結論**: CDEはStagingを含めて稼働しているが、Web-CADの確定版を登録するAPI・認証・受入設計は無い。Web-CADからの登録は**外部入力待ち**(CDE側の受入APIとクライアント登録)。

### 6.5 Portfolio(2026-10-23)

| 確認項目 | 実測結果 | 根拠 |
| --- | --- | --- |
| web-cadのdeployments | **Pages本番のみ**(`platform: pages`、`evidence: observed`)。Tunnel/systemdの本番・MVP・Stagingは未登録 | `catalog/repositories.yaml:68`(origin/main `76a310b`) |
| relationships | `mcip`(mcp_tool_gateway)と`mcah`(runtime_api)がいずれも`designed` | 同`:70-71` |
| Staging登録の前例 | PORT-OPS-002(CEOS)/005(CivilPDF)/006(CDE)が「実測→`deployments`へ`observed`追加→`source_documents`へ記録追加」の形式 | `docs/operations/PORT-OPS-006_Staging環境連携の実測登録（Civil-Docs-Platform）.md` |
| web-cadのStaging登録 | **未登録**(2026-10-23時点) | 同catalog。本監査の別タスクでPORT-OPS-007として登録する |

**結論**: Portfolioのweb-cadエントリはPages本番のみで、実態(systemd+Cloudflare Tunnelの本番/MVP/Staging)と乖離している。Stagingの登録はPortfolio側の作業(task-3)で行う。設計上のrelationships(mcip/mcah)は実装が無いため`designed`のままとし、`observed`へ上げない。

### 6.6 CEOS/CODIP/ArcSphere/Spatial Capture(設計上mcip/mcah経由)

| リポジトリ | Web-CADとの直接関係の実測 | 根拠 |
| --- | --- | --- |
| Construction-Enterprise-OS | 直接の連携コード・設定・文書は無い(設計スナップショットHTMLのみ) | `grep -rn -i "web-cad"`(コード・docs)が0件(origin/main `0c6a3a6`) |
| Civil-Open-Data-Intelligence-Platform | 直接の連携は無い | 同0件(origin/main `4f14b21`) |
| ArcSphere-Civil-Twin | **直接連携は凍結済み**。旧連携先は`CivilDraft-Web-CAD`(別製品)で、2026-09-25に凍結。後継の2D図面はMirai-Web-CADだが「同リポジトリのAPI/MCP公開後に接続」と明記 | `docs/migration/integration-contracts.md:3-7`、`docs/adr/0006-v36-portfolio-positioning.md:61-62`(origin/master `bf537e2`) |
| Spatial Capture | 直接の連携は無い | `grep`0件(origin/main `4387a5d`) |
| MCAH | 実行時の直接連携は無い。設計(repo一覧)にWeb-CADのAPI/MCP公開予定が載るのみ | `blueprint/pages/repos.json`(origin/main `6a5ece7`)。Web-CADのMCPは未公開(§6.2) |

補足(実測): Platform-Infraの`systems.yaml:105-110`に`web-cad`(`uses_core: false`、`production: false`、2026-10-12追加)があり、`envs/stg/services.yaml:183-200`にStagingのユニットと`https://mirai-web-cad-stg.mirai-dx-platform.com`→`127.0.0.1:18814`が`running`として登録されている(origin/main `6038d31`)。Web-CAD側の文書が「Platform-Infraの台帳は未作成」としていた記述は2026-09-25時点のもので、**2026-10-23時点では登録済み**。

### 6.7 許可される接続に照らした仕分け(2026-10-23)

許可される接続は①Coreの版付き成果物の取込み、②実行時のAPI/MCP/Tool Gateway、③正本API・CDE参照からのデータ取得、④版付きschemaを介すイベント、の4種類。DB直結・他Repoコード直参照・Core/Infra正本のコピーは禁止。

| 区分 | 連携 | 状態・根拠 |
| --- | --- | --- |
| **次に実装可能**(外部入力不要) | Core evidence形式への変換(エクスポート) | Core `v0.8.0`の`schemas/evidence/ai-run.schema.json`(`core.evidence.ai_run/1`)等はRelease assetで内容を確認できる。**送信はせず**、自DBの読み取りからJSON Linesを生成する変換・試験は本リポジトリだけで実装できる(§4の差分を埋める)。ただし契約の**取込み・lock固定**は署名済みRelease待ちであり、変換の正本性は未保証 |
| 同上 | 連携状況の記録(`integration status`) | CDPの`docs/operations/integration-status.md`と同じ形式で、Web-CADが実測した接続状態を自リポジトリに記録できる。他システムへの接続を伴わない |
| 同上 | 相関ID(`x-request-id`)の保存・伝搬 | `src/api-handler.js`は受け取って応答へ返すが、監査・AI Runへ保存していない(§2)。自DBのadditive migrationで実装可能 |
| 同上 | 自環境の監視・Stagingの観測記録 | systemd timer・health・DB名の確認は実装済み(§6.8) |
| **外部入力待ち** | Core成果物の取込み(`core-lock/`)と版宣言 | 署名・attestation付きReleaseが無い(`signing-keys.yaml`空、`/attestations`404)。条件: Coreが署名鍵(O-16)とattestationを有効化し、署名検証できるReleaseを公開する |
| 同上 | MCIP案件IDの発番・配布 | MCIPに対外案件ID APIが無い(`V3.2整合性評価.md:14`)。条件: MCIPが発番APIと認可(Web-CADのclient登録)を提供する。Web-CADはadditive migrationで外部ID列を追加してから参照する |
| 同上 | CDEへの承認済み版登録 | CDEにWeb-CAD向けの登録API・クライアント登録が無い(§6.4)。条件: CDEが受入APIと認証方式を設計・提供する |
| 同上 | MCPサーバー公開 | Coreの`mcp_server_id`が`null`、`registries/mcp-allowlist.yaml`に`web-cad`が無い(§6.2)。条件: CoreでMCP契約を版管理しAllowlistへ登録したうえで、EntraのApp ID URI(`audience`)を確定する |
| 同上 | Staging E2E(Access Service Token) | オーナーがテスト時だけService Tokenを発行する必要がある([Staging構築手順書](../runbooks/staging-bringup.md)§12)。トークン値はGit・ログへ出さない |
| **第3段階まで実施しない** | MCIP案件IDを正本にすること(自採番の置換) | 台帳§4-7の決定どおり。API公開後に外部ID列を追加し、段階的に移行する |
| 同上 | CDEへの確定版登録の本番運用 | API提供後も、承認フロー・版確定・証跡の設計が決まるまで本番運用しない |
| 同上 | MCP公開とTool Gateway経由の実行 | 第3段階。ツール仕様・Allowlist・監査が揃うまで公開しない |
| **禁止(恒久)** | 他システムDBへの直接接続、他Repoコードの直参照、Core/Infra正本のコピー、`latest`/main直参照/submodule | [AGENTS.md](../../AGENTS.md)§1、本§1。2026-10-23の実測でも違反は無い |

### 6.8 Stagingが変えないこと(2026-10-23時点の稼働を含む)

- Stagingは稼働中だが、**新しいリポジトリ間結合を追加しない**。`mirai-web-cad-staging.service`(`127.0.0.1:18814`、DB `mirai_web_cad_staging`)は本番・MVPと同じTunnel/Accessの家族パターンで、他システムへ接続しない。
- 2026-10-23の実測: `mirai-web-cad-staging.service`はactive、`/api/health`は`ok=true`/`db.mode=connected`、DBは`mirai_web_cad_staging`、公開URLは未認証302(Accessログイン)、`mirai-web-cad-staging-monitor.service`は`success`(08:17:33のログに`database=mirai_web_cad_staging, Access redirect required=yes`)、backup/backup-check/restore-drillの各timerはenabledで直近実行はsuccess(復元ドリルは2026-10-18)。
- AI Providerの直接呼出し([ADR-0003](../adr/ADR-0003-ai-provider-direct-call-interim.md)の期限付き例外)は本番と同じくStagingでも継続し、新しい経路を作らない。Model Gateway(MCAH)への移行時に本番と同時に切り替える。
- 案件ID(MCIP発番)・確定版(CDE登録)・MCP公開は第3段階のままとし、Stagingでは実装しない。Stagingのデータは使い捨てで、本番・MCIP・CDEへは送らない。
- Core成果物の取り込み(`core-lock/`)は、署名付きReleaseが用意できるまで本番・Stagingともに行わない。
- migrationは自リポジトリのschemaだけを対象とする。他システムDBへ接続しない。

### 6.9 未確認として残す事項

- Coreの署名・attestation有効化の時期と、O-16(署名プロバイダー)の決定。2026-10-23時点では`signing-keys.yaml`が空で、Releaseに署名が無いことだけを実測した。
- MCIPの対外案件ID APIの発番形式・認可方式・提供時期。文書上の「未実装」を確認しただけで、実装計画は未確認。
- CDEの承認済み版登録の受入設計(API・認証・データ形式)。CDE側の設計文書にはWeb-CAD向けの記載が無い。
- CDE Stagingの公開疎通(DNS・connector・Accessログイン)。ローカルのhealthとコンテナ稼働だけを実測した。
- Portfolio Pages本番(`mirai-web-cad.pages.dev`)が現在も配信されているか。catalogのPagesエントリは履歴として残し、現在の配信はTunnel側とする(PORT-OPS-007)。
- Staging E2E(`npm run test:e2e:staging`)。Access Service Tokenがオーナー実施のため未実施。
- ArcSphereの後継連携(Mirai-Web-CADのAPI/MCP公開後)の時期と契約。凍結文書の記載のみで、実装は無い。
