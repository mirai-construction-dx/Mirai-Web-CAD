# MCP 読み取りツール契約(ドラフト)

更新日: 2026-10-23。状態: **ドラフト。CoreのMCP契約/Allowlistが未提供のため登録しない。サーバ実装・公開・Allowlist変更は行わない。**
関連: [基盤連携の要件と現状](platform-integration.md) §6.2・§6.7、[外部入力・確定待ち台帳](../external-input-status.md) §4-7、[MCIP/CDE連携アダプタ](integration-adapters.md)、[AGENTS.md](../../AGENTS.md) §1。

> 本文書は**契約案**である。MCPサーバの実装、ツールの公開、Core `registries/mcp-allowlist.yaml` への登録、Tool Gatewayの設定変更を一切行っていない。実装はCoreで契約が版管理され、Allowlistへ`web-cad`が登録され、EntraのApp ID URI(`audience`)が確定した後に、別PRで行う。

## 1. 位置付けと前提

2026-10-23時点の実測([platform-integration.md](platform-integration.md) §6.2):

- Core `registries/systems.yaml` に `web-cad` は登録済み(`audience: "api://web-cad"`、`db_schema: mirai_web_cad`)。ただし **`mcp_server_id: null`**。
- Core `registries/mcp-allowlist.yaml` に `web-cad` は**無い**。
- MCP公開は第3段階。ツール仕様は基盤の文書にまだ無い。

したがって本ドラフトは、**ツール名・入力schema・出力・認可・監査・レート制限・禁止事項の候補**を先に固定してレビュー可能にするためのものである。Coreの契約・Allowlist方式に対する拘束力は無く、Core側の決定で変更され得る。

前提とするAllowlist方式:

- ツールは **`server_id` + `tool_name`** の組でAllowlistに登録する。`server_id`は`web-cad`(Core登録済みのsystem_id)。
- `tool_name`は安定したsnake_caseとし、名前に`latest`・版番号・環境名を入れない。契約の版はツール定義の版(`tool_version`)で管理し、名前の変更(=Allowlist変更)を伴わずに更新できるようにする。
- Allowlistに無いツールは公開しない。動的なツール登録・動的な名前解決をしない。
- 実行時はTool Gateway経由。Web-CADがMCPサーバを直接インターネットへ公開することは前提にしない。

## 2. 共通契約(全ツール)

### 2.1 読み取り専用

- すべてのツールは**読み取り専用**。図面・版・案件・承認・コメント・監査を変更しない。副作用は監査ログの追記だけとする。
- 書き込み系(作成・更新・承認・却下・削除・コメント追加)のツールは提供しない。
- ツール実行の成否にかかわらず、Web-CADのデータを変更しない。

### 2.2 認可

- 認証はEntra ID + Tool Gateway。呼び出し利用者のoidを`x-request-id`とは別に受け取り、既存の`resolveActor`と同じ規則でロールを解決する。
- 必要なロールは**`viewer`以上**(`viewer` / `drafter` / `reviewer` / `approver` / `cad_admin` のいずれか)。
- 対象図面の案件に対するアクセス権を必須とする。`projects.access_scope = 'open'`なら認証済み利用者、`restricted`なら`project_members`該当者または`cad_admin`のみ([migrations/0007](../../migrations/0007_project_membership.sql))。
- 認可はツール側の都合で緩めない。RLS・案件メンバーシップ・ロールの既存判定を迂回するサービスアカウント・管理者トークンを使わない。
- 権限が無い場合と存在しない場合は、応答を区別しない(`not_found`)。存在の推測(列挙)を防ぐ。

### 2.3 版の固定(latest禁止)

- **内容を返すツールは`version_id`を必須**とする。`latest`・`current`・`head`・ブランチ・タグ・「最新版」の暗黙解決を受け付けない。
- `list_drawings`は図面のメタデータのみを返し、版の内容や「最新版ID」を返さない。版の特定は`get_drawing_versions`で行い、利用者が明示的に`version_id`を選ぶ。
- `version_id`は不変の版ID(`drawing_versions.id`、現行形式は`ver_<drawingId>_<NNN>`)。作成後に内容が変わらないことを前提とし、`content_hash`で照合できるようにする。
- 本ドラフトでは外部公開する版を**`approved`(または`deprecated`)に限定**する。`draft`・`in_review`・`rejected`はMCPから返さない。編集中の2D図面はWeb-CAD内の正本であり、外部公開は承認後とする(この限定は確定事項ではなく、Core・オーナーの確認を要する)。
- `content_hash`は現行実装では**暗号学的ハッシュではない**(32bitの安定ハッシュ。`src/cad-core.js`の`stableHash`)。改ざん証明には使わず、変更検知の補助に限定する。暗号学的な照合はCDE登録APIの外部入力待ち。

### 2.4 応答

- JSON(UTF-8)。HTML・バイナリ・リダイレクトを返さない。
- 応答には`schema_version`(本ドラフトの識別子。例:`web-cad.mcp.drawing_list/1-draft`)と`request_id`を含める。`schema_version`は**Coreのschema名ではない**。Coreで契約化する際に確定する。
- 一覧はカーソルページネーション。既定25件、最大100件。`next_cursor`が`null`なら終端。
- 1応答の内容サイズ上限は1 MiB(案)。超過時は切り詰めずにエラー`response_too_large`を返す。
- 時刻はUTCのRFC 3339(ミリ秒`Z`)。IDはWeb-CADのIDであり、MCIP/CDEのIDではない。
- 個人情報を返さない: メールアドレス・`created_by`・`actor_id`の生値・プロンプト・コメント本文・監査ログの詳細は返さない。

### 2.5 監査

各呼び出し(拒否・失敗を含む)について、少なくとも次を追記専用の監査記録へ残す。

| 項目 | 内容 |
| --- | --- |
| `request_id` | Tool Gateway/呼び出し元の相関ID |
| `timestamp` | UTC |
| `actor_oid` | 呼び出し利用者のEntra oid |
| `actor_role` | 解決したロール |
| `server_id` / `tool_name` / `tool_version` | Allowlistの組と契約版 |
| `project_id` / `drawing_id` / `version_id` | 対象(取得できた範囲) |
| `outcome` / `error_code` | 成功・拒否・失敗 |
| `latency_ms` / `response_bytes` | 性能・濫用検知 |
| `arguments_hash` | 引数の正規化JSONのSHA-256(生のcursor等は保存しない) |

- 図面内容・トークン・接続文字列・個人情報は監査へ保存しない。
- 監査記録に失敗した場合、読み取りを成功として返さない(`unavailable`)。記録できない読み取りを許さない(案。可用性とのバランスはCore/運用と確定する)。
- 監査の保管期間・参照方法はCoreの監査方針に従う。

### 2.6 レート制限(案)

| ツール | 利用者あたり | 全体 |
| --- | --- | --- |
| `list_drawings` | 30回/分 | 300回/分 |
| `get_drawing_versions` | 60回/分 | 600回/分 |
| `get_drawing` | 60回/分 | 600回/分 |

- 超過時は429と`Retry-After`。無限リトライを促す応答をしない。
- これは案であり、Core/Tool Gatewayの全体制限と運用実測で確定する。
- 高コストな一括取得(全案件・全図面・全版の列挙)は提供しない。

### 2.7 エラー

```json
{
  "ok": false,
  "error": {
    "code": "not_found",
    "message": "対象の図面または版が見つかりません。",
    "request_id": "req_0123456789ab"
  }
}
```

| code | HTTP相当 | 意味 |
| --- | --- | --- |
| `invalid_argument` | 400 | 入力schema違反・未固定版の要求(`latest`等) |
| `unauthorized` | 401 | 認証なし・audience不一致 |
| `not_found` | 404 | 存在しない、またはアクセス権が無い(区別しない) |
| `rate_limited` | 429 | レート制限 |
| `response_too_large` | 413 | 応答サイズ上限超過 |
| `unavailable` | 503 | 監査記録不可・DB不可・依存障害 |
| `internal` | 500 | 想定外(内部詳細・秘密値を返さない) |

### 2.8 禁止事項(恒久)

- 書き込み・状態変更・承認・削除・コメント追加。
- 他システムDBへの直結、任意SQL、ファイルパス・URLの受け取り、SSRF。
- `latest`・未固定版・暗黙の最新解決。`version_id`なしで内容を返すこと。
- 全案件・全図面・全版の一括列挙、無制限の`limit`、無制限のページ取得。
- 認可の迂回(RLS無効化、サービス全体トークン、`cad_admin`の貸与)、テナント・audienceの混在。
- 個人情報(メール・プロンプト・コメント・監査詳細)の返却。
- 動的ツール登録、Allowlist外のツール公開、`latest`を含むツール名。
- 書込みを伴うMCPツールの追加。

## 3. ツール候補

| `tool_name` | 目的 | 必要なロール | 固定版 |
| --- | --- | --- | --- |
| `list_drawings` | 案件内の公開可能な図面メタデータ一覧 | viewer以上 | 版を返さない |
| `get_drawing_versions` | 図面の公開可能な版ID一覧 | viewer以上 | 版IDを返す |
| `get_drawing` | 指定した不変版の内容取得 | viewer以上 | `version_id`必須 |

`list_projects`・`get_project`・`list_audit_logs`・`export_dxf`・`get_ai_run`は**候補に含めない**。案件の正本はMCIP、監査・AI実行記録の外部提供はCoreの証跡契約と別の判断が必要、DXF出力は形式・透かし・承認の設計が未確定のため。

### 3.1 `list_drawings`

説明: 指定案件のうち、外部公開可能な(承認済み版を持つ)図面のメタデータを返す。図面内容・版内容・版IDは返さない。

入力schema:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": ["project_id"],
  "properties": {
    "project_id": { "type": "string", "pattern": "^prj_[A-Za-z0-9_-]{1,60}$" },
    "limit": { "type": "integer", "minimum": 1, "maximum": 100, "default": 25 },
    "cursor": { "type": "string", "minLength": 1, "maxLength": 512, "pattern": "^[!-~]+$" }
  }
}
```

出力例:

```json
{
  "schema_version": "web-cad.mcp.drawing_list/1-draft",
  "request_id": "req_0123456789ab",
  "items": [
    {
      "drawing_id": "dwg_demo_001",
      "name": "道路拡幅 仮設施工図",
      "unit": "mm",
      "state": "approved",
      "updated_at": "2026-10-23T01:02:03.456Z"
    }
  ],
  "next_cursor": null
}
```

- `project_id`は**Web-CADの案件ID**(`prj_…`)であり、MCIPの案件コードではない。対応付けは未確定([integration-adapters.md](integration-adapters.md) §7)。
- `state`は`approved`または`deprecated`のみ。承認済み版を持たない図面は返さない。
- `name`は図面名。個人情報・コメント・内容は返さない。

### 3.2 `get_drawing_versions`

説明: 指定図面の公開可能な版(承認済み・廃止)の一覧を返す。版内容は返さない。

入力schema:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": ["drawing_id"],
  "properties": {
    "drawing_id": { "type": "string", "pattern": "^dwg_[A-Za-z0-9_-]{1,60}$" },
    "state": { "type": "string", "enum": ["approved", "deprecated"], "default": "approved" },
    "limit": { "type": "integer", "minimum": 1, "maximum": 100, "default": 25 },
    "cursor": { "type": "string", "minLength": 1, "maxLength": 512, "pattern": "^[!-~]+$" }
  }
}
```

出力例:

```json
{
  "schema_version": "web-cad.mcp.drawing_versions/1-draft",
  "request_id": "req_0123456789ab",
  "items": [
    {
      "version_id": "ver_dwg_demo_001_002",
      "version_no": 2,
      "state": "approved",
      "content_hash": "3f2a1b0c",
      "content_hash_kind": "web-cad-stable-hash-32",
      "created_at": "2026-10-23T01:02:03.456Z"
    }
  ],
  "next_cursor": null
}
```

- `created_by`は返さない(個人情報であり得るため)。
- `content_hash`は変更検知用の32bit値であり、暗号学的な完全性証明ではない。CDE登録時の照合には別途、暗号学的ハッシュの導入が必要(外部入力待ち)。
- 承認日時(`approved_at`)は現行DBに列が無いため返さない。推測値・`created_at`での代用をしない。

### 3.3 `get_drawing`

説明: `drawing_id`と`version_id`で指定した不変版の内容を返す。承認済み(または廃止)版のみ。

入力schema:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": ["drawing_id", "version_id"],
  "properties": {
    "drawing_id": { "type": "string", "pattern": "^dwg_[A-Za-z0-9_-]{1,60}$" },
    "version_id": { "type": "string", "pattern": "^ver_[A-Za-z0-9._-]{1,128}$" }
  }
}
```

出力例(内容はWeb-CADの図面JSON。ここでは省略):

```json
{
  "schema_version": "web-cad.mcp.drawing/1-draft",
  "request_id": "req_0123456789ab",
  "drawing": {
    "drawing_id": "dwg_demo_001",
    "project_id": "prj_demo_road_001",
    "name": "道路拡幅 仮設施工図",
    "unit": "mm",
    "version_id": "ver_dwg_demo_001_002",
    "version_no": 2,
    "state": "approved",
    "content_hash": "3f2a1b0c",
    "content_hash_kind": "web-cad-stable-hash-32",
    "created_at": "2026-10-23T01:02:03.456Z"
  },
  "content": { "schemaVersion": 1, "entities": [], "layers": [] }
}
```

- `latest`・`current`等の入力は受け付けない(`invalid_argument`)。`version_id`省略時も返さない。
- `version_id`が`drawing_id`に属さない、存在しない、非公開state(`draft`等)、またはアクセス権が無い場合は`not_found`(区別しない)。
- `content`は1 MiB上限。超過時は`response_too_large`で失敗し、切り詰めない。
- 内容は読み取り専用のスナップショット。適用・保存・再登録のAPIは提供しない。

## 4. Allowlist登録の候補(登録はしない)

Coreで契約化する際に必要になると想定される項目の**候補**。値はドラフトであり、登録も送信もしていない。

```json
{
  "server_id": "web-cad",
  "tool_name": "get_drawing",
  "tool_version": "0.1.0-draft",
  "contract_version": "web-cad.mcp.drawing/1-draft",
  "read_only": true,
  "required_role": "viewer",
  "audience": "api://web-cad",
  "input_schema_sha256": "<Coreで確定後に算出>",
  "output_schema_sha256": "<Coreで確定後に算出>",
  "status": "draft-not-registered"
}
```

- `server_id`はCore `systems.yaml`の`web-cad`。`mcp_server_id`は現在`null`のため、登録にはCore側の採番・Allowlist追加が必要。
- `tool_version`・`contract_version`・schema hashは未確定。推測値で登録しない。
- Allowlistへ登録するまで、どの環境でもツールを公開しない。

## 5. 登録・実装の前提条件(すべて未充足)

| # | 前提条件 | 現状(2026-10-23) |
| --- | --- | --- |
| 1 | CoreでMCPツール契約が版管理される | 未提供 |
| 2 | Core `registries/systems.yaml`の`mcp_server_id`採番 | `null` |
| 3 | Core `registries/mcp-allowlist.yaml`へ`server_id`+`tool_name`登録 | `web-cad`は未登録 |
| 4 | Entra App ID URI(`audience`)の確定・Web-CAD側の受入 | `audience: "api://web-cad"`は登録済みだがApp登録は未確認 |
| 5 | Tool Gatewayの認可・監査・レート制限の仕様 | 未確認 |
| 6 | 外部公開する版の範囲(approved限定)の承認 | 本ドラフトの提案。未承認 |
| 7 | 監査保存先・保管期間・相関IDの契約 | 未確定 |
| 8 | 暗号学的ハッシュ/CDE照合との関係 | 外部入力待ち([integration-adapters.md](integration-adapters.md) §8) |

## 6. 残リスク・未対応

- 本文書はドラフトであり、Core契約・Allowlist・Tool Gatewayの実仕様と一致する保証はない。
- ツール実装・公開・認可の実装・監査の実装・レート制限の実装は行っていない。
- `approved`限定の公開範囲、`content`のJSON形式の外部互換性、1 MiB上限、レート制限値は案であり、Core・オーナー・運用の確認が必要。
- `content_hash`は32bitの安定ハッシュで、暗号学的な完全性を提供しない。
- MCP経由の利用者oidの受け渡し方法(Tool Gatewayのヘッダ仕様)は未確認。なりすまし防止のため、Web-CAD側で利用者ヘッダを直接信頼しない設計が必要。
- 図面内容の著作権・機密区分・監査証跡の外部提供範囲は、Coreのclassification方針と合わせて確定する必要がある。

## 7. 参照

- [基盤連携の要件と現状](platform-integration.md) §1・§6.2・§6.7
- [外部入力・確定待ち台帳](../external-input-status.md) §4-7
- [MCIP/CDE連携アダプタ](integration-adapters.md)
- `migrations/0001_initial.sql`・`0007_project_membership.sql`
- `src/cad-core.js`(`ROLE_POLICIES`・`stableHash`)
- [AGENTS.md](../../AGENTS.md) §1・§5
