# 基盤連携の要件と現状(全体構成 V3.6 / リポジトリ構成 V3.6 / OS・アプリ選定 V3.5)

更新日: 2026-09-25。基盤の設計文書がMirai-Web-CADに求める他リポジトリとの連携を抽出し、現状との差を記録する。
正本の文書は複製しない(下表)。判断が必要な事項は推測で確定せず、[外部入力・確定待ち台帳](../external-input-status.md)の「4. 基盤V3.6との整合」に記録する。

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
| マージ前の人間レビュー(通常2名/重要3名) | 決定(B型を継続、Botは代替にしない) | 組織の開発ガバナンス(Portfolio `docs/operations/PORT-GOV-001`、Core ADR-0016)でWeb-CADは**B型(品質ゲートを満たせば自動マージ、承認0)**。低リスクの変更は品質ゲート(必須チェック等)だけでマージでき、オーナーのY/Nは高リスク変更(PORT-GOV-001 §5: 認証・secret・DNS・課金・公開範囲・破壊的migration・保護設定)に限る。2026-09-25時点では、オーナーの指示により全マージでY/Nを取得している(運用上の追加措置で、規則上の要件ではない)。V3.6の2名/3名は、2人目(security-reviewers、2026-09-28提示予定)の参加後にADR-0016の見直し条件で再判断 |
| CODEOWNERSはTeam指定 | 決定(B型のため置かない) | PORT-GOV-001 §2.2でB型のRepositoryにCODEOWNERSは不要(承認を要求しないため)。`.github/CODEOWNERS`(個人)は既存のまま。承認型への変更時にTeam(Write以上)で整備する |
| AIの結果の反映に人間承認(承認者の分離・承認記録) | **未充足** | 反映には利用者の明示操作が必要だが、編集権限があれば誰でも適用でき、オフライン時は承認記録を残さない([ADR-0003](../adr/ADR-0003-ai-provider-direct-call-interim.md)) |
| AIはModel Gateway(MCAH)経由。キーを持つのはGatewayのみ | **承認済み例外(期限付き)** | `src/ai-provider.js`がOpenAI/Anthropicを直接呼び、本番はキーを保持。[ADR-0003](../adr/ADR-0003-ai-provider-direct-call-interim.md)(承認済み、見直し期限2026-12-25) |
| Coreの版付き成果物を版・digest固定で取り込む(`core-lock/`等) | 未対応(現時点で利用対象なし) | Web-CADはCoreの契約(event/evidence/MCP)をまだ使っていない。取込み時の手順は§3 |
| 基盤の台帳(Core `registries/systems.yaml`等)への登録 | 決定・登録申請中 | system_idは`web-cad`(2026-09-25オーナー決定)。Core PR #27で登録申請(audienceは論理値`api://web-cad`、MCPなし)。Platform-Infraの台帳は未作成 |
| MCPサーバー公開(契約はCoreで版管理、`server_id`+`tool_name`のAllowlist) | 未対応 | 第3段階。ツール仕様は文書に無い |
| 案件IDはMCIPが発番 | 不整合(将来) | `migrations/0001`の独自`projects`と`0007`の`project_members` |
| 確定版をCDEへ登録 | 未対応 | CDE連携なし。承認済み版はWeb-CAD内で保持 |
| UI→Agent→Tool→DBまで相関IDを維持 | 一部 | APIは`x-request-id`を受け取り応答へ返す(`src/api-handler.js`)。監査・AI Runへの保存と下流への伝搬は未対応 |
| 証跡の共通項目(Core evidence schema) | 一部 | 対応表は§4 |
| 技術標準(OS・アプリ選定 V3.5) | 承認済み例外・更新計画あり | PostgreSQL 16、Node 22(CI)/`engines >=20`、vanilla JS、実行時にNode APIを使用。[ADR-0004](../adr/ADR-0004-tech-stack-vs-os-selection.md)(承認済み: アプリ構成は例外として維持、Node 24へ2027-01-31・PostgreSQL 18へ2027-11-30までに更新) |
| SSOはEntra ID → Cloudflare Access | 一部 | Cloudflare Accessは稼働。Entra連携の実装(`src/entra-graph.js`)はあるが対象利用者のtenant登録は未完了(台帳§2) |

## 3. Coreの版付き成果物を取り込むときの手順(未実施)

現時点でWeb-CADが利用するCore成果物は無いため、lockファイルは置かない(使っていないものを固定すると実態と合わない記録になる)。取り込むときは次による。

1. 取り込む契約(例: `schemas/evidence/*`、`schemas/event/envelope.schema.json`、MCP tool定義)と、利用する版を決める。2026-09-25時点でCoreのGitHub Releaseは`v0.1.0`のみ(SHA256SUMS・aibom付き)、タグは`v0.6.0`まで(`VERSION`=0.6.0)。他のConsumer(CEOS)はタグ`v0.6.0`をvendoringで固定している。どちらに合わせるかは判断事項。
2. `contracts/harness-core.lock.json`(CEOSと同じ形式: `core_version`、`source.repo/tag/commit`、ファイルごとのSHA256)で固定する。`contracts/`配下は取得物として手編集しない。`latest`・main直参照・submoduleは使わない。
3. CIでlockのハッシュを照合する検査を追加する。
4. system_id(Core `registries/systems.yaml`への登録)を先に確定する。

参考(照合用、取込みは未実施): Core Release `v0.1.0` の`contracts.tar.gz`のSHA256は`bbbacae714dcecb3102fbacf0e51e0f538eb04fcc32c0de9bd5ca2ddb0949c26`(同Releaseの`SHA256SUMS`)。

## 4. 監査・AI実行記録とCore evidence schemaの対応(現状)

Core `schemas/evidence/ai-run.schema.json`と`schemas/event/envelope.schema.json`(タグ`v0.6.0`。2026-09-25時点のCore作業ツリーと内容同一)の必須項目に対する、Web-CADのDB列(`migrations/0001`ほか)の対応。変換処理は未実装で、将来MCIPへ証跡を送る際の差分を示す。

| Core必須項目 | Web-CADの対応 | 状態 |
| --- | --- | --- |
| `source_system` | `web-cad`(2026-09-25決定、Core PR #27で登録申請中)。証跡への出力・変換は未実装 | 未対応(値は確定) |
| `event_id` / envelope `id` | `audit_logs.id`、`agent_runs.id` | 対応可 |
| `run_id` | `agent_runs.id` | 対応可 |
| `request_id` / `correlation_id` | APIの`x-request-id`はDBへ保存していない | 未対応 |
| `project_id` | `drawings.project_id`(独自の案件ID。MCIP発番ではない) | 一部 |
| `requester_oid` / `actor` | `audit_logs.actor_id`、`agent_runs.created_by`(メール/ロール。Entra OIDではない) | 一部 |
| `status` / `created_at` / `time` | `agent_runs.status`(received〜rolled_backの10状態)、`created_at` | 対応可(状態名の対応付けは要定義) |
| `skill` | `agent_runs.skill_id`、`skill_version` | 対応可 |
| `models` / `usage` / `policy` / `verification` / `citations` / `deployment` | `agent_runs.proposal`にengine程度のみ | 未対応(ADR-0003の移行で扱う) |

## 5. 本リポジトリ内で実施済み・今後の対応

- 実施済み: `CLAUDE.md`・`AGENTS.md`の新設、本文書、ADR-0003(承認済み)/0004(提案)、判断事項の台帳化と2026-09-25のオーナー決定の反映。
- 他リポジトリ・設計判断が必要(記録のみ。本リポジトリでは実施しない): 台帳§4を参照。
