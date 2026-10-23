# MCIP / CDE 連携アダプタ(フェイルクローズド設計)

更新日: 2026-10-23。状態: **アダプタと単体テストを実装済み。実API・実DBへは未接続。**
関連: [基盤連携の要件と現状](platform-integration.md) §6.3・§6.4・§6.7、[外部入力・確定待ち台帳](../external-input-status.md) §4-7・§4-9、[Core evidenceエクスポート](core-evidence-export.md)、[MCP読み取りツール契約(ドラフト)](mcp-tool-contract.md)、[AGENTS.md](../../AGENTS.md) §1。

## 1. 目的と非目標

目的:

- MCIP(案件ID・承認・証跡の正本)とCDE(確定版の正本)の将来APIに備え、**設定が無ければ外部へ一切接続しない**クライアントを用意する。
- APIが提供されたときに、呼び出し・タイムアウト・サイズ上限・エラー正規化・秘密非出力の作法を既存の`src/ai-provider.js`・`src/entra-graph.js`と同じ形で再利用できるようにする。
- 「何が未確定か」をコードと文書の両方に残し、推測のエンドポイント・項目・案件ID変換を実装しない。

非目標(今回のスコープ外。意図的に実施しない):

- MCIP/CDEへの実接続、疎通確認、レジストレーション、認証トークンの取得。
- MCIPの案件ID発番API・CDEの登録APIの実装(他リポジトリの責務)。
- Web-CADの`projects.id` / `drawings.project_id`の移行、外部ID列の追加、既存データの変換。
- APIハンドラ・UIへの配線(呼び出し元はまだ無い)、MCPサーバの実装・公開、Core Allowlistの変更。
- DBへの書き込み、migration、seed、他システムDBへの接続。

## 2. 許可される接続種別との関係

全体構成 V3.6 / リポジトリ構成 V3.6 の「許可する接続は原則4種類」に対する本アダプタの位置付け。

| 許可される接続 | 本アダプタとの関係 |
| --- | --- |
| ① Coreの版付き成果物をビルド/起動時に取り込む(版・digest固定) | 対象外。Core成果物は取り込んでいない([platform-integration.md](platform-integration.md) §3) |
| ② 実行時のAPI / MCP / Tool Gateway | **未対応**。MCP公開は第3段階([mcp-tool-contract.md](mcp-tool-contract.md))。実行時APIは未接続 |
| ③ データは正本API・CDE参照から取得 | **本アダプタの範囲**。MCIPの読み取りAPIとCDEの参照APIを呼ぶためのクライアント(現状は未接続) |
| ④ イベントは版付きschemaを介す | 対象外。イベント送信は未実装 |

禁止(恒久)との関係: 他システムDBへの直結、他リポジトリのコード直参照、Core/Infra正本のコピー、`latest`・main直参照・submoduleは行わない。本アダプタは**HTTP APIのクライアントのみ**で、DBドライバ・他リポジトリのコード・schemaファイルを持たない。

> 本アダプタは「接続を追加した」ものではない。設定が無い限り`not_configured`を返し、ネットワークへ出ない。現在の本番・StagingのAPIハンドラは本アダプタを呼び出していない。

## 3. 現状(2026-10-23実測)

### 3.1 MCIP

| 確認項目 | 実測 |
| --- | --- |
| 案件の読み取りAPI | あり。`GET /api/v1/projects`(自分に見える案件のみ、RLS)、`GET /api/v1/projects/:code`(MCIP `api/src/app-api.ts:686`・`:748`) |
| 対外案件IDの発番・配布API | **無い**。案件コンテキストの正本は`projects`/`assets`/`project_members`で実装済みだが、全社共通の案件IDを他システムへ配るAPIは未実装(MCIP `docs/architecture/V3.2整合性評価.md:14`) |
| OpenAPI | **無い**。API仕様はコードと文書が正本 |
| 認証・認可・レート制限・ページネーション | Web-CADのクライアント登録は無い。呼び出し方式・スコープ・レスポンスschemaは**未確認** |
| Web-CADの登録 | 無い(`grep -rn -i "web-cad"`がMCIPのコード・台帳で0件) |

### 3.2 CDE

| 確認項目 | 実測 |
| --- | --- |
| 確定版の登録API | **Web-CAD向けのAPI・ツールは無い**。REST APIとMCPツールはあるが、版の承認・登録を外部システムへ提供するものではない |
| クライアント登録 | 無い(`grep -rn -i "web-cad"`がコード・文書で0件) |
| 認証 | 利用者トークン(Entra)前提。非対話用のclient_credentials設定はあるが、Web-CAD用のアプリ登録は未確認 |
| Staging | 内部では稼働中(health OK)。公開入口は未提供で、Web-CADからの疎通は未確認 |

いずれも[platform-integration.md](platform-integration.md) §6.3・§6.4の再実測に基づく。**本アダプタの実接続テストは行っていない。**

## 4. 実装

| ファイル | 内容 |
| --- | --- |
| `src/mcip-client.js` | MCIP読み取りクライアント(設定判定・`getProject`・`listProjects`・フェイルクローズド) |
| `src/cde-client.js` | CDE登録クライアントの設計インターフェース(常に`not_supported`。ネットワーク呼び出しを持たない) |
| `tests/integration-adapters.test.js` | fetchモックによる単体テスト24件(実API・実DBへ接続しない) |

### 4.1 MCIP(`src/mcip-client.js`)

```js
const config = describeMcipConfig(env);        // { enabled, reason, baseUrlOrigin } — 秘密値を含まない
const client = createMcipClient(env, { fetchImpl }); // fetchImpl省略時はglobal fetch
client.configured;                             // boolean
await client.getProject(projectId);            // { ok:true, projectId, payload } | { ok:false, error }
await client.listProjects({ limit, cursor });  // { ok:true, query, payload } | { ok:false, error }
```

- エンドポイントはMCIPの実APIに合わせて`GET /api/v1/projects`と`GET /api/v1/projects/:code`のみ。それ以外のパス・メソッド・登録APIを実装しない。
- 認証ヘッダは`Authorization: Bearer <token>`を仮置きしている。MCIPの認証方式(利用者委任/client credentials/audience)は未確認のため、確定時に見直す。
- **未設定時は`fetch`を一切呼ばない**。`createMcipClient`自体は常に返るが、`getProject`/`listProjects`は`not_configured`を返す。
- base URLが不正・資格情報入り・クエリ/ハッシュ付き・平文HTTP(ループバック以外)の場合は`invalid_configuration`を返し、呼び出さない。
- タイムアウトは既定10秒(`AbortSignal.timeout`)。fetchのリダイレクト追従は無効(`redirect: "error"`)とし、Authorizationヘッダを別オリジンへ送らない。
- レスポンスはサイズ上限256 KiB。超過時は読み取りを中断して`response_too_large`を返す。
- HTTPエラーは`http_error`+`status`のみを返し、上流の本文・ヘッダは返さない。
- 例外は投げない。`timeout` / `network` / `invalid_response`へ正規化し、例外のmessage・stack・URL・トークンを含めない。
- **リトライしない**(1回の呼び出しのみ)。再送は呼び出し側が用途と冪等性を判断して行う。
- レスポンスの`payload`は**そのまま返す**。項目名・案件IDの解釈・検証・変換はしない(応答schemaが未提供のため)。

戻り値の例:

```json
{
  "ok": true,
  "projectId": "PRJ-2026-0012",
  "payload": { "code": "PRJ-2026-0012", "name": "…" }
}
```

```json
{
  "ok": false,
  "error": { "code": "not_configured", "message": "MCIPのAPI設定が無いため、外部呼び出しを行いません。" }
}
```

エラーコード:

| code | 意味 | 外部呼び出し |
| --- | --- | --- |
| `not_configured` | `MCIP_API_BASE_URL`または`MCIP_API_TOKEN`が無い | しない |
| `invalid_configuration` | base URLが不正・資格情報入り・不安全 | しない |
| `invalid_argument` | 案件コード・limit・cursorが不正 | しない |
| `timeout` | 接続または応答がタイムアウト | する(1回) |
| `network` | 接続失敗・応答読み取り失敗 | する(1回) |
| `http_error` | 2xx以外(401/403/404/429/5xx等) | する(1回) |
| `response_too_large` | 応答が256 KiB超 | する(1回) |
| `invalid_response` | JSONでない、またはオブジェクトでない | する(1回) |

### 4.2 CDE(`src/cde-client.js`)

```js
const config = describeCdeConfig(env);          // { enabled, reason, baseUrlOrigin } — 秘密値を含まない
const client = createCdeClient(env);
client.configured;                              // boolean
await client.registerApprovedVersion(input);    // { ok:false, error:{ code, message } } のみ
```

- `CDE_API_BASE_URL` / `CDE_API_TOKEN`未設定時は`not_configured`。設定済みでも**`registerApprovedVersion`は常に`not_supported`**を返す。
- CDEの登録API・認証・受入形式が無いため、推測のエンドポイント・メソッド・ペイロードを実装しない。**このファイルに`fetch`・HTTPクライアント・エンドポイント文字列は存在しない**(テストで静的検証)。
- 将来の登録インターフェース(設計案。項目は外部入力で確定する):

  | 入力(案) | 内容 |
  | --- | --- |
  | `projectId` | Web-CADの案件ID(現行は`prj_…`)。MCIPの案件コードではない |
  | `drawingId` / `versionId` / `versionNo` | 登録する図面と確定済み版(`drawing_versions.id`は現在`ver_<drawingId>_<NNN>`) |
  | `contentHash` | 版の内容ハッシュ(改ざん検知・照合用) |
  | `approverId` | 承認者のIdP oid。メールアドレスは渡さない |
  | `approvalRef` | Web-CAD側の承認記録への参照(現行DBに専用列は無く、監査行を参照する想定) |
  | `idempotencyKey` | 再送時の重複登録を防ぐキー(方式はCDEと確定する) |

  これらは**設計案であり、現時点でコードは入力検証も送信もしない**。

## 5. 設定

| 変数 | 用途 | 必須 |
| --- | --- | --- |
| `MCIP_API_BASE_URL` | MCIP APIのbase URL(例: `https://<host>/…`) | MCIP利用時 |
| `MCIP_API_TOKEN` | MCIP APIのアクセストークン | MCIP利用時 |
| `CDE_API_BASE_URL` | CDE APIのbase URL | CDE利用時 |
| `CDE_API_TOKEN` | CDE APIのアクセストークン | CDE利用時 |

- 本番・Stagingの環境変数として**未設定のまま**とする。値をGit・ログ・PR・テスト結果・この文書へ書かない。
- アダプタは渡された`env`オブジェクトから該当変数だけを読む。`.env`ファイルや秘密ストアを直接読む処理は持たない。
- base URLは`https`のみ。例外は開発用のループバック(`http://localhost`・`http://127.0.0.1`・`http://[::1]`)だけ。
- 秘密値は`describe*Config`・戻り値・エラーメッセージ・`console`へ出さない。ヘッダに載るのは設定済みトークンのみ。

## 6. フェイルクローズドの規則

| 状況 | 動作 | 呼び出し元がしてはいけないこと |
| --- | --- | --- |
| 設定が無い | `not_configured`・ネットワークなし | 推測値での代替、別環境のURLの流用 |
| 設定が不正 | `invalid_configuration`・ネットワークなし | 資格情報をURLへ埋め込む、HTTPへ切り替える |
| タイムアウト/接続失敗/HTTPエラー | 正規化エラーを返す・**リトライなし** | 無限リトライ、部分的な成功としての扱い |
| 応答サイズ超過/不正JSON | エラーを返し、内容を採用しない | 本文の一部を案件データとして解釈する |
| CDE登録APIが無い | `not_supported` | 「登録した」とみなす、代替のローカル保管を正本扱いする |

フェイルクローズドは「接続できないときに、正本の代替を作らない」ことを意味する。Web-CADは引き続き編集中の2D図面だけを正本として保持し、MCIP/CDEのデータを推測で補完しない。

## 7. 移行しないもの(意図的)

- `projects.id`(`prj_…`)・`drawings.project_id`・`drawing_versions.id`(`ver_…`)の値・形式・採番主体は変更しない。
- MCIPの案件コード/IDをWeb-CADの`project_id`へ**自動で書き換えない**。対応表・変換関数・双方向同期も作らない。
- 外部ID列の追加(additive migration)は、MCIPの発番・配布APIの提供後に別PRで行う。本PRではmigrationを追加しない。
- MCIPのレスポンスから`projects`行の作成・更新をしない(読み取りのみ)。CDEへは何も送らない。
- Web-CADのRBAC(案件メンバーシップ・RLS)をMCIPの案件一覧で置き換えない。MCIPの「見える案件」は認可の正本ではない。
- 監査・証跡の送信は行わない([core-evidence-export.md](core-evidence-export.md) §10)。

## 8. 外部入力待ち(確定待ち)

| # | 対象 | 必要な外部入力 | 本アダプタへの影響 | 参照 |
| --- | --- | --- | --- | --- |
| 1 | MCIP | 対外案件IDの発番・配布API(または読み取りAPIが契約であることの確認)、案件コードの形式・安定性 | 呼び出し可否、`getProject`の位置付け | [platform-integration.md](platform-integration.md) §6.3・§6.7 |
| 2 | MCIP | Web-CAD用の認証・認可(Entra App登録/audience/スコープ、利用者委任かclient credentialsか) | ヘッダ・トークン取得方式 | 同上・[外部入力・確定待ち台帳](../external-input-status.md) §4-7 |
| 3 | MCIP | レスポンスschema/OpenAPI、エラーモデル、ページネーションの契約(limit上限・cursorの不透明性) | 応答の受入検証、limit既定値 | §6.3 |
| 4 | MCIP | レート制限・監査要件・相関ID(`x-request-id`)の要否 | 呼び出し頻度、監査記録 | §6.3 |
| 5 | CDE | 承認済み版の受入API(エンドポイント・メソッド・版管理) | `registerApprovedVersion`の実装可否 | §6.4・§6.7 |
| 6 | CDE | 認証方式(Entraのclient credentials / on-behalf-of、Web-CAD用アプリ登録・audience) | トークン取得・送信ヘッダ | §6.4 |
| 7 | CDE | 登録ペイロードの形式(図面データ/DXF/参照のみ、content hashのアルゴリズム、版・承認・証跡の参照形式) | 入力項目・変換の要否 | §6.4 |
| 8 | CDE | 冪等キーの方式、再送・競合(409)・エラーの扱い | 再送設計 | §6.4 |
| 9 | CDE | Stagingの公開入口・Access・クライアント登録 | 疎通テスト | §6.4・§6.9 |
| 10 | 基盤 | MCP契約・Allowlist・Tool Gateway、Entra App ID URI | 本アダプタをMCPから使うか | [mcp-tool-contract.md](mcp-tool-contract.md) |

決定は推測で行わず、[外部入力・確定待ち台帳](../external-input-status.md) §4へ記録する。

## 9. 検証

worktree(`.wt-integration-adapters`)で実行:

| コマンド | 結果 |
| --- | --- |
| `node --test tests/integration-adapters.test.js` | 24 tests / 24 pass / 0 fail |
| `npx eslint src/mcip-client.js src/cde-client.js tests/integration-adapters.test.js` | エラー0 |
| `npm run lint:static`(eslint .) | エラー0 |
| `npm run typecheck`(tsc checkJs) | 成功 |
| `npm run lint` | `lint ok` |
| `npm test` | 585 tests / 584 pass / 0 fail / 1 skipped |

テストの観点:

- MCIP: 正常系(URL・メソッド・Authorization・Accept・redirect・AbortSignal)、レスポンスの無変換、案件IDを書き換えないこと。
- 未設定/不正設定のフェイルクローズド(fetch呼び出し0回)、資格情報入りURLの拒否と非出力。
- タイムアウト(実際に`AbortSignal`で中断)、HTTPエラー(500/429)、不正JSON、非オブジェクト、サイズ超過(reader中断)。
- 入力検証(案件コード・limit・cursor)でネットワークに出ないこと、リトライしないこと(呼び出し1回)。
- 秘密非出力: 設定・結果・例外メッセージにトークン/URL資格情報/ホスト名を含めないこと。
- CDE: 未設定は`not_configured`、不正設定は`invalid_configuration`、設定済みは入力に依存せず`not_supported`。ソースにネットワーク呼び出し・エンドポイントが無いこと(静的検査)。
- 実API・実DBへは接続していない。fetchはすべてモック。

## 10. 残リスク・未対応

- **未配線**: `src/api-handler.js`から本アダプタを呼ぶ経路は無い。実運用の認可・監査・レート制限・エラー表示は未接続。
- **実API未検証**: MCIPのレスポンス形式・エラー形式・ページネーション・認証は実測していない。受入時には応答の項目検証と契約テストを追加する必要がある。
- **サイズ・タイムアウト値**: 10秒・256 KiBは暫定。一覧の件数・図面サイズに応じて見直す。
- **リトライなし**: 一時障害時の再送は呼び出し側の責務。冪等性が未確定なため、自動リトライを実装していない。
- **トークン管理**: 環境変数の静的トークン前提。有効期限・更新・ローテーションは未実装(MCIP/CDEの認証方式確定後)。
- **HTTPS強制**: 内部サービスがHTTPのみの場合、ループバック以外は設定不可。必要ならCDE/MCIP側のTLS構成を確認してから例外を検討する。
- **CDEのインターフェース**: 入力項目は設計案であり、CDEの受入設計と一致する保証はない。
- **文書の他箇所**: [platform-integration.md](platform-integration.md) §2の現状表・§6.7の仕分けは本PRのスコープ外。本アダプタの実装状況を反映する更新はLeadがまとめる。
- **MCP**: サーバ実装・Allowlist登録は行っていない([mcp-tool-contract.md](mcp-tool-contract.md)はドラフト)。

## 11. 変更ファイル

- `src/mcip-client.js` — MCIP読み取りクライアント(フェイルクローズド)
- `src/cde-client.js` — CDE登録クライアントの設計インターフェース(常に`not_supported`)
- `tests/integration-adapters.test.js` — fetchモックの単体テスト
- `docs/architecture/integration-adapters.md` — 本文書

## 12. 参照

- [基盤連携の要件と現状](platform-integration.md) §1・§6.3・§6.4・§6.7
- [外部入力・確定待ち台帳](../external-input-status.md) §4
- [MCP読み取りツール契約(ドラフト)](mcp-tool-contract.md)
- [Core evidenceエクスポート](core-evidence-export.md)
- `src/ai-provider.js`・`src/entra-graph.js`(既存の外部呼び出しの作法)
- [AGENTS.md](../../AGENTS.md) §1・§3・§5
