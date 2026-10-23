# Core evidence エクスポート(監査ログ・AI実行記録)

更新日: 2026-10-23。状態: **変換と読み取り専用CLIを実装済み。MCIP/CDEへの送信は未実装(対象外)**。
関連: [基盤連携の要件と現状](platform-integration.md) §3・§4、[外部入力・確定待ち台帳](../external-input-status.md) §4、[ADR-0003](../adr/ADR-0003-ai-provider-direct-call-interim.md)。

## 1. 目的と非目標

目的:

- Web-CADの `audit_logs`(監査ログ)と `agent_runs`(AI実行記録)の1行を、Coreの証跡schema
  `core.evidence.ai_run/1` へ**写像した射影(projection)** に変換する純粋関数を提供する。
- PostgreSQLから**SELECTのみ**で取得し、JSON Linesで出力する読み取り専用CLIを提供する。
- 将来MCIPへ証跡を送るときに埋めるべき差分を、コードと文書の両方で明示する。

非目標(今回のスコープ外。意図的に実施しない):

- MCIP・CDE・Coreへの送信、API/MCP呼び出し。
- Core schemaの採用(`core-lock/`の作成、schemaファイルのコピー)。
- DBへの書き込み・migration・seed・TRUNCATE等。
- 他システムDBへの接続、envファイルの読取り。
- Web-CADのID体系・認証方式の変更。

**この出力はCore schema準拠ではない。** 後述のとおり `source_system` の制約と、現行DBに存在しない必須項目のため、
Coreのvalidatorを通らない。「準拠している」と誤解される形で送信・保管してはならない。

## 2. 参照したCore正本(コピーしない)

正本はCoreリポジトリにのみ置き、本リポジトリへコピーしない(AGENTS.md §5)。
2026-10-23に読み取りのみで参照した。

| 文書 | 参照元 | SHA-256 |
| --- | --- | --- |
| Coreリポジトリ | `mirai-construction-dx/Mirai-Harness-Core`、`origin/main` commit `7e799e59078f3b438502cdf81f6a4bc94eebb7fd`(2026-10-21) | — |
| `schemas/evidence/ai-run.schema.json` (`$id`: `https://schemas.core.mirai/evidence/ai_run/1`) | 同上 | `ce76262d903eabbb1aaaf845d050dabba2944a3ae9cf62c118937f900d967a4e` |
| `schemas/evidence/citation.schema.json` | 同上 | `476e944787e05e39ebe30e1df4f687082eb2d35e67f5f82012eba0c3410e7781` |
| `schemas/event/envelope.schema.json` (`$id`: `https://schemas.core.mirai/event/envelope/1`) | 同上 | `3d3e6b3cf0d709e84edf3b3d73c511d7b84cc520d074f1275382a2eff809f08e` |
| `schemas/common/defs.schema.json` | 同上 | `91197dfd07809d0975a4ba1bf5f0e2cdf5ab2eb1c91301323f896f94b2735242` |
| `schemas/identity/identifiers.schema.json` | 同上 | `54f8dd6f9d513b04f99f0ad7b6a71394e042632fe2c1fc867c8f9d4f72b23d30` |
| `registries/systems.yaml` の `web-cad` 行 | 同上(8〜11行目) | `{id: web-cad, name: Mirai-Web-CAD, repo: Mirai-Web-CAD, audience: "api://web-cad", mcp_server_id: null, db_schema: mirai_web_cad}` |

補足:

- 参照時点のCore最新タグは `v0.8.0`。署名・attestation付きReleaseは未作成のため、[platform-integration.md](platform-integration.md) §3の
  手順で要求される `contracts.lock.json` は**作らない**(取り込んでいないものを固定すると実態と合わない)。
- 本リポジトリにはCore schemaのコピーを置かない。`src/core-evidence.js` は項目名・形式を文字列と検証関数で参照するだけ。
- Core側の `web-cad` 登録は system_id の登録であり、`ai_run` schemaが `source_system: "web-cad"` を許す意味ではない(§4.1)。

## 3. 出力形式

### 3.1 evidence射影(既定。JSON Lines 1行1レコード)

```json
{"schema":null,"schema_target":"core.evidence.ai_run/1","schema_status":"unsupported","source_system":"web-cad","event_id":"01a16647-7cc0-79c3-9c40-3dec989fda74","event_id_status":"derived","run_id":null,"run_id_status":"unsupported","request_id":null,"request_id_status":"unsupported","correlation_id":null,"correlation_id_status":"unsupported","project_id":null,"project_id_status":"unsupported","organization_id":null,"requester_oid":null,"requester_oid_status":"unsupported","actor":{"id":null,"role":"drafter","status":"unavailable"},"status":null,"status_source":null,"status_mapping":"unsupported","created_at":"2026-10-23T01:02:03.456Z","created_at_status":"mapped","finished_at":null,"finished_at_status":"unsupported","ai_generated":null,"skill":null,"skill_status":"unsupported","models":null,"models_status":"unsupported","usage":null,"usage_status":"unsupported","policy":null,"policy_status":"unsupported","verification":null,"verification_status":"unsupported","citations":null,"citations_status":"unsupported","deployment":null,"deployment_status":"unsupported","source":{"table":"audit_logs","kind":"audit_log","id":"audit_abc123def456","drawing_id":"dwg_demo_001","project_id":null,"action":"drawing.saved","target_type":"drawing","target_id":"dwg_demo_001","run_status":null,"risk":null,"skill":null,"models":null,"role":"drafter"},"unsupported":["schema","run_id","request_id","project_id","requester_oid","skill","status","citations","verification","policy","models","usage","deployment"]}
```

(上は `audit_logs` 行の例。実際の出力は1行1JSONで、この例は整形していない。)

CLIは `actor_id`(メールアドレスであり得る)をSELECTしないため、CLI出力の `actor.status` は通常 `unavailable` になる。
変換関数へメールアドレスが渡った場合は `redacted` となり、値自体は出力しない(§6)。

フィールドの意味:

| フィールド | 意味 |
| --- | --- |
| `schema` | 常に `null`。Core schemaを採用したと偽らないため。 |
| `schema_target` | 対応先のCore `$id`(`core.evidence.ai_run/1`)。**Core schema名を新設していない**。 |
| `schema_status` | 常に `unsupported`(本射影はCore schema非準拠)。 |
| `source_system` | 常に `web-cad`(Core `registries/systems.yaml` 登録済みの system_id)。 |
| `event_id` | Web-CADが導出した決定的UUIDv7(§4.2)。 |
| `*_status` | `mapped`=値を写像、`derived`=決定的に導出、`redacted`=PIIのため出力せず、`unsupported`=未対応/形式不一致/該当なし。 |
| `source` | Web-CAD側の元情報(テーブル・ID・action・target・skill・models・role)。Core項目に写像できた場合も追跡用に残す。 |
| `unsupported` | Core ai_run/1 の**必須項目**のうち、この行で `null` のもの。順序はCoreのrequired順で決定的。 |

`agent_runs` 行では `source.kind` が `agent_run`、`source.action`/`target_*` が `null`、`source.run_status`/`risk`/`skill`/`models` が入る。
`ai_generated` は `engine` が `llm` のときだけ `true`(ルールベース生成はAI生成ではないため `null`)。

### 3.2 イベント封筒(`--envelope`)

`--envelope` を付けると、各行をCoreの `core.event.envelope/1` で包む。封筒自体は必須項目を満たす
(`id` は導出UUIDv7、`time` は作成時刻)。`data` には3.1の射影がそのまま入るため、封筒は準拠・中身は非準拠である。

```json
{"schema":"core.event.envelope/1","specversion":"1.0","id":"01a16647-7cc0-79c3-9c40-3dec989fda74","source":"web-cad","type":"evidence.recorded","time":"2026-10-23T01:02:03.456Z","datacontenttype":"application/json","data":{"schema":null,"schema_target":"core.evidence.ai_run/1","source_system":"web-cad","…":"…"}}
```

- `type` はCore enumの `evidence.recorded` を使う(新しいイベント種別を作らない)。
- `subject` は元レコードID、`actor` は監査行のrole(既知のroleのみ)。
- `project_id` / `correlation_id` / `classification` / `schema_version` は、確定値が無いため**省略**する。
  Coreでは `classification` 省略は安全側(既定 `HIGHLY_CONFIDENTIAL`)として扱われるため、推測値を入れない。

## 4. Core `ai_run/1` との対応表

`agent_runs` / `audit_logs` の列は `migrations/0001_initial.sql`〜`0008_audit_truncate_guard.sql` を根拠とする。

| Core項目 | Coreの要求(正本schema) | Web-CADの元データ | 本アダプタの出力 | 状態 |
| --- | --- | --- | --- | --- |
| `schema` | `const core.evidence.ai_run/1` | — | `null` + `schema_target` | **unsupported**(§4.1) |
| `source_system` | `const "mcah"` | system_id `web-cad` 登録済み | `"web-cad"` | **構造的不適合**(§4.1) |
| `event_id` | `format uuid` | `audit_logs.id` / `agent_runs.id`(text) | 決定的UUIDv7 | derived |
| `run_id` | `executionId`(UUIDv7) | `agent_runs.id`(`run_<12hex>`) | `null` + `source.id` | unsupported(形式不一致) |
| `request_id` | `requestId`(UUIDv7) | APIの `x-request-id` はDBへ未保存 | `null` | unsupported |
| `correlation_id` | envelope任意・証跡では未定義 | 未保存 | `null` | unsupported |
| `project_id` | `projectId`(`^[A-Z][A-Z0-9]{1,7}-[0-9]{4}-[0-9]{4,8}$`) | `drawings.project_id`(`prj_…`、MCIP発番でない) | `null` + `source.project_id` | unsupported(形式・発番主体) |
| `organization_id` | `organizationId`(UUID) | 未保存 | `null` | unsupported |
| `requester_oid` | `userId`(UUID、IdPのoid) | `actor_id` / `created_by`(**メールアドレス**であり得る。CLIはSELECTしない) | UUID形式なら写像、それ以外は `null` | redacted / unsupported |
| `status` | enum 7値 | `agent_runs.status`(10状態) | 6状態のみ写像(§4.3) | mapped / unsupported |
| `created_at` | `dateTime`(RFC 3339) | `created_at`(timestamptz) | UTCミリ秒`Z`へ正規化 | mapped |
| `finished_at` | `dateTime`(任意) | 保存なし(状態更新時刻なし) | `null` | unsupported |
| `skill` | `{id,version,tier}`、id=`^r[0-3]-…`、tier=R0-R4 | `agent_runs.skill_id`/`skill_version`(`llm-proposal`等) | `null` + `source.skill` | unsupported(パターン・tier不一致) |
| `models` | 配列。`route/provider/via/model_version/fallback`、provider=openai/anthropic、model_versionは日付入り | `agent_runs.proposal` の `engine/provider/model`、監査行は `detail.engine/provider/model`(provider/modelのみ) | `null` + `source.models` | unsupported(route/via/fallback/model_version欠落) |
| `usage` | `{cost_jpy}`(required) | 保存なし(トークン・原価の計測なし) | `null` | unsupported |
| `policy` | `{version}`(required) | 保存なし | `null` | unsupported |
| `verification` | `{passed,…}`(required) | 保存なし | `null` | unsupported |
| `citations` | 配列(必須項目)。citation schemaはsource_system/document_id/version/locator/content_hash/fetched_at/license/classification必須 | 保存なし | `null` | unsupported |
| `deployment` | `{profile,image_digest,core_version}`(required) | 保存なし(Web-CADはCoreのデプロイではない) | `null` | unsupported |
| `approval` | 任意。approval_id/result_ref/action_hash/verified | 承認は別の監査行で、runのapproval_id/action_hashへ結合していない | 出力しない | unsupported |
| `tools` | 任意。実行Toolと版 | MCP/Tool Gateway未使用(直接呼出し) | 出力しない | unsupported |
| `ai_generated` | `const true`(任意) | `proposal.engine` | `llm` のときだけ `true`、他は `null` | mapped / unsupported |

補足: Coreの `schemas/evidence/ai-run.schema.json` は `additionalProperties: true` のため、
`source`・`*_status`・`schema_target`・`unsupported` などの追加フィールドはCore validatorを妨げない
(ただし `source_system` 等の不適合で全体は通らない)。

### 4.1 構造的な不適合: `source_system`

Core `ai_run/1` の `source_system` は `const "mcah"`(Mirai-Construction-Agent-Harness固定)である。
Web-CADは `registries/systems.yaml` に `web-cad` として登録済みだが、`ai_run` schemaはWeb-CADの発行を
想定していない。したがって:

- `source_system: "web-cad"` を出力する以上、`schema: "core.evidence.ai_run/1"` を名乗ることはできない。
  本アダプタは `schema: null` + `schema_target` とし、`unsupported` に `schema` を入れる。
- 解消にはCore側の判断(consumer別profileの新設、`source_system` 制約の緩和、またはWeb-CAD向けの
  evidence schema追加)が必要。Web-CAD側でCore schema名を新設・改変しない(AGENTS.md §1・§5)。
- これは[外部入力・確定待ち台帳](../external-input-status.md)の「4. 基盤V3.6との整合」で確定させる。

### 4.2 `event_id` の決定的導出

- 入力: `source_system`(`web-cad`)・テーブル名・行の `id`・`created_at`(UTCミリ秒)。
  `SHA-256("web-cad:<table>:<id>")` の一部と48bitミリ秒からUUIDv7を構成する。
- 同じ行からは常に同じ `event_id`(再送時の重複排除に使える)。テーブルが違えば別ID。
  `created_at` が変われば別ID(`audit_logs` は追記専用トリガで不変、`agent_runs.created_at` も更新されない)。
- `created_at` が不正・欠落の場合は時系列UUIDv7を構成できないため `event_id: null`(推測で埋めない)。
- **このUUIDはWeb-CADが導出したイベント識別子**であり、Core/MCIP発番のIDではない。元の行IDは
  `source.id` に残す。将来MCIPが採番する場合は、そのIDへ移行する。
- SHA-256は本モジュール内の実装(ブラウザ相当環境でNode APIに依存しないため)。暗号用途ではなく、
  決定的IDの生成専用。正しさはテストで `node:crypto` のSHA-256と全パターン照合している。

### 4.3 `status` の写像(10状態 → 6状態+4未対応)

| Web-CAD `agent_runs.status` | Core `status` | 根拠 |
| --- | --- | --- |
| `completed` | `completed` | 実行完了 |
| `failed` | `failed` | 実行失敗 |
| `rejected` | `rejected` | 却下 |
| `rolled_back` | `cancelled` | 適用後の巻き戻し |
| `planned` | `awaiting_approval` | 提案が人間の承認待ち(自動適用しない) |
| `previewed` | `awaiting_approval` | プレビュー提示後の承認待ち |
| `received` | `null` | Coreに対応状態なし |
| `needs_input` | `null` | Coreに対応状態なし |
| `user_approved` | `null` | 承認済み・未適用。Coreに対応状態なし |
| `executing` | `null` | 実行中。Coreに対応状態なし |

監査行(`audit_logs`)では、`action` が `agent.` で始まる行だけ `detail.status` を同じ表で写像する。
それ以外の監査行の `status` は `null`(AI実行の状態ではないため)。

## 5. 未対応項目と、それが解消する条件

| 未対応項目 | 理由 | 解消に必要な外部入力・変更 |
| --- | --- | --- |
| `schema` 採用 | Core `ai_run/1` は `source_system: "mcah"` 固定 | Coreの署名済みReleaseとschema版確定、consumer別profile/制約緩和のCore判断 |
| `run_id` | Web-CADのIDはUUIDv7でない | MCIP/MCAHと共通の実行ID採番への移行(またはCore側で許容形式を定義) |
| `request_id` / `correlation_id` | `x-request-id` をDBへ保存していない | `audit_logs`/`agent_runs` への列追加(migration)、UI→API→Agent→DBの伝搬 |
| `project_id` | 独自 `prj_…`。MCIP発番でない | MCIP案件IDの発番・参照API |
| `requester_oid` | メールアドレスで保存。Entra oidでない | 認証時のoid保存への移行(actorのPII最小化も同時に解決) |
| `skill` | Web-CAD skill idは `r0-r3-` 形式でなく、tierが無い | Skill台帳(Core `registries/skills.yaml`)への登録とID移行 |
| `models` / `usage` | route/via/fallback/日付版/model_version・原価が無い | MCAH(Model Gateway)経由への移行(ADR-0003)とusage計測 |
| `policy` / `verification` | ポリシー版・検証結果を保存していない | Core PDP/PEP採用と実行時記録 |
| `citations` | 図面・標準・出典の引用登録が無い | 引用(source_system/document_id/version/locator/content_hash/fetched_at/license/classification)の保存 |
| `deployment` | Web-CADはCoreのデプロイではない | 対象外のまま(送信時にCore側と表現を合意) |
| `approval` / `tools` | 承認と実行の結合、Tool定義ハッシュが無い | 承認ID・action_hashの保存、MCP/Tool Gateway採用 |
| `classification`(envelope) | 機密区分を保存していない | 区分の保存とCore `confidentiality` への対応付け(省略時は安全側) |
| `finished_at` | 状態更新時刻を保存していない | 状態遷移の時刻列追加 |

## 6. 秘密値・PIIの扱い

- CLIは `agent_runs.prompt`(利用者入力)、`agent_runs.created_by`、`audit_logs.actor_id`(メールアドレスであり得る)を
  **SELECTしない**。プロセスへ読み込まないことを第一の防御にする。
- 変換関数は、渡された `actor_id`/`created_by` が
  - `system` / `anonymous` → そのまま出力(PIIでない運用主体)
  - UUID形式 → `requester_oid` と `actor.id` へ写像(Entra oid等)
  - それ以外(メールアドレス・role名等) → 出力しない(`actor.status: "redacted"`)
- `audit_logs.detail` は `role` / `status` / `engine` / `provider` / `model` / `risk` のみ読む。未知キーは出力しない。
- ID・action・target種別は `[A-Za-z0-9_.-]` と長さで検証し、`@` や空白を含む値は出力しない。
- `source_system` 以外の自由文字列(`risk`・`provider`・`model` 等)も文字種と長さを制限する。
- 出力にはプロンプト・メール・トークン・接続文字列を含めない(テストで検証、§9)。
- ただし出力には図面ID・案件ID・action等の業務メタデータが含まれる。**内部取扱い**とし、外部共有・
  コミットはしない(`--output` の出力先はリポジトリ外を推奨)。

## 7. 実行方法

前提:

- Node.js >= 20(`package.json` の `engines`)。
- 依存導入済みのworktree(本番ツリーでは `npm ci` しない。AGENTS.md §3)。
- `DATABASE_URL`(PostgreSQL接続文字列)。CLIは環境変数のみ読み、envファイルは読まない。
- migration `0001`〜`0008` 適用済みのWeb-CAD DB。テーブル `audit_logs` / `agent_runs` / `drawing_versions` / `drawings` を読む。
- 読み取り専用ロールの利用を推奨(CLI側でも `set transaction read only` を強制する)。

```bash
# DB不要の自己検査(固定fixture)
node scripts/export-core-evidence.mjs --self-test

# 最新100件をJSON Linesで標準出力へ(ログは標準エラー)
DATABASE_URL='postgres://…' node scripts/export-core-evidence.mjs --limit 100 > evidence.jsonl

# 図面単位(その図面への監査行 + その図面のAI実行記録)
DATABASE_URL='postgres://…' node scripts/export-core-evidence.mjs \
  --drawing-id dwg_demo_001 --output ../evidence-dwg_demo_001.jsonl

# イベント封筒として出力
DATABASE_URL='postgres://…' node scripts/export-core-evidence.mjs --limit 10 --envelope --output -

# 監査ログだけ / AI実行記録だけ
DATABASE_URL='postgres://…' node scripts/export-core-evidence.mjs --source audit-logs --limit 50
DATABASE_URL='postgres://…' node scripts/export-core-evidence.mjs --source agent-runs --limit 50
```

| オプション | 内容 |
| --- | --- |
| `--limit <n>` | 最大出力件数(1〜1000、既定100)。監査ログ・AI実行記録を合わせて `created_at` 昇順で上位n件。 |
| `--drawing-id <id>` | 図面IDで絞り込む。図面が存在しない場合はエラー。 |
| `--source <name>` | `all`(既定)/ `audit-logs` / `agent-runs`。 |
| `--output <path>` | 出力先。既定はstdout。`-` もstdout。既存ファイルは `--force` が無いと失敗。 |
| `--envelope` | 各行を `core.event.envelope/1` で包む。 |
| `--force` | `--output` の既存ファイルを上書き。 |
| `--self-test` | DBへ接続せず固定fixtureで変換を検査。成功時 `self-test ok (N checks)`。 |
| `-h`, `--help` | ヘルプ。 |

- 標準出力はJSON Linesのみ(ログは標準エラー)。パイプで `jq` 等へ渡せる。
- 表示する接続情報は**データベース名のみ**。ホスト・利用者・パスワードは表示しない。
- 終了コード: 成功0、引数・接続・出力エラー1。エラーメッセージに接続文字列を含めない。

## 8. 読み取り専用の担保

- SQLは `SELECT` と `set transaction read only` のみ。書き込み・migration・seed・TRUNCATEを一切含まない。
- 各実行は `set transaction read only` で開始したトランザクション内でSELECTする。仮に将来書き込みクエリを
  足してもDBが拒否する(多層防御)。
- 接続は `DATABASE_URL` の1つのみ(`max: 1`、`connect_timeout: 10s`)。Web-CAD以外のDBへ接続しない。
- `audit_logs` は追記専用トリガ(0005/0006/0008)を持つが、CLIはそもそも書き込み経路を持たない。

## 9. 検証

worktree(`.wt-core-evidence`)で実行した結果:

| コマンド | 結果 |
| --- | --- |
| `node --test tests/core-evidence.test.js` | 21 tests / 21 pass / 0 fail |
| `npm run lint:static`(eslint .) | 成功(エラー0) |
| `npm run lint`(scripts/lint.mjs) | `lint ok` |
| `npm run typecheck`(tsc checkJs) | 成功 |
| `npm test` | 542 tests / 541 pass / 0 fail / 1 skipped |

テストの観点:

- 正常系(監査行・AI実行記録)、`source_system: "web-cad"`、`schema: null` の明示。
- 欠落列・空行・壊れたJSON文字列でも例外にしない。未対応は `null` と `unsupported` で残す。
- 時刻: Date / `Z` / `+09:00` / 数値の正規化、タイムゾーン無し文字列の拒否、不正値の `null`。
- PII: メールアドレス・prompt・detailの未知キー・`@` を含むIDが出力に現れないこと。
- `event_id` の安定性(同一行で同一、Date/文字列で同一、テーブル・時刻で別ID)。
- `status` 10状態の写像表と未対応4状態。
- JSONL(1行1JSON、末尾改行、空配列、パース可能性)。
- イベント封筒の必須項目・許可キーのみ・欠落時の拒否。
- CLI: 引数検証、`--self-test`/`--help` がDBなしで成功、`DATABASE_URL` 欠落の明確な失敗、
  DB名抽出と資格情報の非表示、不正引数でDBへ接続しないこと。
- CLIのSELECT文(偽トランザクションで捕捉): `SELECT`のみ・書き込みSQLなし・`prompt`/`created_by`/`actor_id` を読まない・
  `--drawing-id` の絞り込み・`--source` によるクエリ省略。読み取り専用トランザクションと環境変数が
  `DATABASE_URL` だけであることも静的検査。
- SHA-256実装を `node:crypto` と照合(パディング境界・UTF-8を含む)。

**実DBに対するSQLの実行検証はこのタスクでは行っていない**(本番・ステージングDBへ接続しない制約)。
ステージングでのスモークテスト(§12)を別途行うこと。

## 10. なぜ今は送信しないか

1. Core schemaに準拠しない(§4.1)。準拠しないレコードを「証跡」として送ると、受信側で検証失敗するか、
   検証を緩めた場合は誤った監査記録が残る。
2. Coreの署名済みRelease・attestationが無く、`contracts.lock.json` を作れない([platform-integration.md](platform-integration.md) §3)。
   版を固定せずに送信すると、送信先のschema版が変わったときに検知できない。
3. AI Provider直接呼出しの期限付き例外(ADR-0003)のため、`policy`・`verification`・`citations`・`models`・`usage` を
   正しく記録できない。これらを空のまま送ると「検証済み・根拠あり」と誤認され得る。
4. MCIPの証跡受信API/MCPと、案件ID・承認IDの発番が未提供(第3段階)。
5. 本タスクの制約(送信しない・他システムDBへ接続しない)。

## 11. 次の外部入力(確定待ち)

| 外部入力 | 確定する内容 | 参照 |
| --- | --- | --- |
| Coreの署名付きRelease(GitHub Release + attestation) | 参照するschema版と `contracts.lock.json` のdigest | [platform-integration.md](platform-integration.md) §3 |
| Core側の `source_system` 制約の扱い | Web-CAD証跡を `ai_run/1` とするか、consumer別profile/新schemaを作るか | Coreへの変更依頼([外部入力・確定待ち台帳](../external-input-status.md) §4) |
| MCIPの案件ID発番・参照API | `project_id` の写像 | 同上 |
| IdP(Entra ID)oidの保存 | `requester_oid` とactorのPII最小化 | 同上 |
| `x-request-id`/相関IDの保存 | `request_id`/`correlation_id` | 同上 |
| MCAH(Model Gateway)への移行 | `models`/`usage`/`policy`/`verification`/`citations` | [ADR-0003](../adr/ADR-0003-ai-provider-direct-call-interim.md) |
| MCIPの証跡受信API/MCP | 送信方式・冪等キー・再送 | 基盤 V3.6 第3段階 |
| 機密区分の保存 | envelope `classification` | Core `common/confidentiality/1` |

## 12. 残リスク・既知の制約

- **SQL未実測**: 実DBへ接続していないため、PostgreSQL上での構文・型・プランは未検証。ステージングで
  `--limit 1` と `--drawing-id` のスモークテストを行うこと(本番DBは対象外)。
- **導出IDの位置付け**: `event_id` はWeb-CAD導出のUUIDv7。MCIP/Core発番のIDではない。監査上の意味を
  「Web-CAD内で一意な証跡イベントID」に限定する。将来MCIP採番へ移行する場合は移行規則を別途決める。
- **SHA-256の自前実装**: 暗号用途ではないが、実装の正しさはテストで `node:crypto` と照合している。
  将来ブラウザ/Node共通の標準手段が使えるなら置き換える。
- **監査行の案件ID**: `audit_logs` には `project_id` 列が無いため、全件エクスポートでは監査行の
  `source.project_id` は `null`。`--drawing-id` 指定時は、その図面の案件IDを補う。
- **`--limit` の意味**: 監査ログ・AI実行記録をそれぞれ `created_at` 昇順でn件取得してマージするため、
  全体の古い順上位n件になる。片方に偏ることはない。
- **`platform-integration.md` §4 の記述**: 「変換処理は未実装」は本実装で古くなった。更新は本PRの
  スコープ外(LeadのPRで反映する)。
- **`scripts/lint.mjs` の必須ファイル一覧**: 新規ファイルを追加していない。CIでの存在保証を強めるなら
  別PRで追加する。
- **Core schemaの変更**: 参照commitを本docに固定した。lockが無いため、Core `origin/main` の更新を
  自動検知しない。送信開始時に必ずlockを導入する。

## 13. 変更ファイル

- `src/core-evidence.js` — 純粋変換(evidence射影・イベント封筒・決定的UUIDv7)
- `scripts/export-core-evidence.mjs` — 読み取り専用CLI(`--self-test` 含む)
- `tests/core-evidence.test.js` — 実DB不要の単体テスト
- `docs/architecture/core-evidence-export.md` — 本文書

## 14. 参考

- Core `schemas/evidence/ai-run.schema.json`、`schemas/event/envelope.schema.json`(§2のcommitで参照)
- [基盤連携の要件と現状](platform-integration.md)
- [外部入力・確定待ち台帳](../external-input-status.md)
- [ADR-0003 AI Provider直接呼出し(暫定)](../adr/ADR-0003-ai-provider-direct-call-interim.md)
- [AGENTS.md](../../AGENTS.md) §1・§3・§5
