# API/DBメモ

## 予定API

| Method | Path | 用途 |
| --- | --- | --- |
| `GET` | `/api/health` | 実装済み。匿名可。DB名などの内部情報は認証時のみ返す |
| `GET` | `/api/drawings/demo` | 実装済み。`visibility=public`のデモ図面だけ匿名取得可 |
| `POST` | `/api/drawings` | 実装済み。空/デモテンプレート、図面名、mm/mを指定して重複実行なしで作成 |
| `GET` | `/api/drawings/:drawingId` | 実装済み。図面取得 |
| `POST` | `/api/drawings/:drawingId/transactions` | 実装済み。CAD Coreコマンド一括適用 |
| `POST` | `/api/drawings/:drawingId/agent-runs` | 実装済み。AI提案作成。ルールベースが`needs_input`かつプロンプトありかつサーバー側でLLM(OpenAI/Anthropic)が設定済みの場合のみフォールバック(fail-soft、LLM障害時もルールベース結果を返す)。actor単位でLLM呼び出しのみレート制限(既定10回/分) |
| `POST` | `/api/agent-runs/:runId/approve` | 実装済み。AI提案を人の承認で適用。適用は1回だけで、適用済み(`status`が`planned`以外)の提案は409(同時の承認もDBの条件で1件に絞る。独立レビューM-2) |
| `POST` | `/api/drawings/:drawingId/review` | 実装済み。レビュー提出、承認、新版 |
| `POST` | `/api/drawings/:drawingId/comments` | 実装済み。`canComment`権限(reviewerも可)。コメント追加、監査ログに本文は記録しない |
| `GET` | `/api/audit-logs` | 実装済み。承認系権限のみ。`limit`/`offset`ページング付きの一覧(読取り専用。状態を変更しない) |
| `POST` | `/api/audit-logs/export` | 実装済み。承認系権限のみ。CSV export(数式注入ガード付き)。`content-type: application/json`必須。export操作自体が`audit.exported`として記録される |
| `GET` | `/api/ai/status` | 実装済み。`canRunAi`権限。`AI_PROVIDER`/`OPENAI_API_KEY`/`ANTHROPIC_API_KEY`/`AI_MODEL`環境変数から有効状態・プロバイダ名・モデル名のみ返す(APIキー自体は返さない)。APIキーはブラウザに一切保存・送信しない |
| `POST` | `/api/projects` | 実装済み(2026-09-18〜)。`cad_admin`限定。案件を作成し、`accessScope`(`open`既定/`restricted`)を指定 |
| `GET`/`PATCH` | `/api/projects/:projectId` | 実装済み。`cad_admin`限定。案件情報・メンバー一覧の取得、`accessScope`の変更 |
| `POST` | `/api/projects/:projectId/members` | 実装済み。`cad_admin`限定。`restricted`案件へメールアドレス単位でメンバーを追加 |
| `DELETE` | `/api/projects/:projectId/members/:member` | 実装済み。`cad_admin`限定。案件メンバーを削除(即座にアクセス失効) |

## DB設計方針

- 図面は`drawings`、版は`drawing_versions`、操作は`command_events`へ分離
- AIは`agent_runs`にPrompt、Skill、Proposal、Riskを保存し、直接図面を書き換えない
- 承認は`reviews`へ記録し、承認済み版の上書きを禁止する
- 監査は`audit_logs`へ追記する
- `idempotency_keys`で更新リクエストの重複実行を拒否する
- `drawings.revision`を比較更新し、古いクライアントからの更新を409で拒否する
- `drawings.visibility`は既定`private`。匿名経路は`public`だけを取得する
- `projects.access_scope`は既定`open`(全ロールが認証済みなら閲覧・編集可、現行の単一案件運用と完全互換)。`restricted`にした案件は`project_members`に登録された利用者と`cad_admin`のみアクセス可(2026-09-18〜、`GET/POST/PATCH`各`/drawings`系エンドポイント全てで一貫して強制)。非会員は図面が存在しない場合と同一の404を返し、案件・図面IDの存在を推測されないようにする
- 図面、版、command event、監査、Idempotency、AI承認状態は単一SQL statementで原子的に確定する
- Localは既定でメモリストア、`DATABASE_URL`(`LOCAL_DB=1`明示時)またはProduction(`scripts/serve-production.mjs`)はローカルPostgreSQL 16へ`postgres`(postgres.js)経由で接続する(2026-08-30〜、Issue #22でNeon/Hyperdriveから移行)

## セキュリティ方針

- Cloudflare Access JWTをJWKS、issuer、audienceで検証し、Worker境界でfail-closed
- Accessロールは`ACCESS_ROLE_MAP`/`ACCESS_DEFAULT_ROLE`から決定し、クライアント指定を信頼しない
- Custom Domainの静的SPA、health、公開デモは匿名可。任意図面取得と全更新は署名済みAccess JWTがなければ401
- `Idempotency-Key`と`expected-version`を更新APIへ要求
- POST本文は`application/json`かつ1 MiB以下。Production CORSは既定でCustom Domain限定。`CORS_ORIGIN`にカンマ区切りで複数オリジンを設定すると、リクエストの`Origin`ヘッダが許可リスト内の場合のみそのオリジンを反映し(`Vary: Origin`付き)、リスト外や未指定時は許可リスト先頭のオリジンを返す(任意オリジンを無条件反映しない)
- CSP、frame拒否、Permissions-Policy、nosniffを静的/API応答の両方へ設定
- Tool CallはJSON Schema検証後、サーバー側で再認可
- 図面内文字列はPrompt命令ではなく非信頼データとして扱う

## ローカルAPI検証

```bash
npm run build
wrangler pages dev dist --port=4176
curl http://127.0.0.1:4176/api/health
```

`GET /api/health`の応答には、稼働中のコードの素性を示す`deploy`ブロックが含まれる(公開リポジトリのcommit/branchのみ。パス・資格情報・環境変数の値は含まない)。

```json
{
  "ok": true,
  "status": "ok",
  "auth": { "mode": "access", "role": "viewer", "anonymous": true },
  "db": { "provider": "postgres", "mode": "connected", "migrated": true },
  "deploy": { "commit": "<40桁SHA>", "branch": "main", "dirty": false }
}
```

`deploy`は`scripts/serve-production.mjs`が起動時に`env.DEPLOY_INFO`として渡す。`npm run dev`(ローカル開発サーバー)やテストでは未設定のため`null`になる。本番で`origin/main`と乖離していないかの判定は`npm run deploy:drift`が行う([運用・復旧メモ](operations.md)参照)。

### 認証モードのfail-closed

`AUTH_MODE`は`access`または`demo`のみ有効で、**未設定・想定外の値は`access`として扱う**。`demo`は認証をリクエストヘッダー(`x-demo-role`)の自己申告で決めるため、公開環境では使用しない。`APP_ENV=production`で`demo`が設定されている場合、`handleApiRequest`はリクエストを401で拒否する(`serve-production.mjs`はそもそも`AUTH_MODE=access`以外での起動を拒否する)。Cloudflare Pages Functions(`functions/api/[[path]].js`)は`AUTH_MODE=access`以外を503で拒否する。

5xxの応答本文は、ローカル開発(`demo`かつ`APP_ENV!=="production"`)以外では`{"ok":false,"error":"internal error"}`へ丸め、DB接続エラー等の内部詳細を未認証クライアントへ返さない(詳細はサーバーログにのみ記録)。

### API応答のセキュリティヘッダ

API応答(`JSON_HEADERS`)は`src/api-handler.js`の`API_SECURITY_HEADERS`を単一の出所とし、CSP・`Strict-Transport-Security`・`X-Frame-Options`・`X-Content-Type-Options`・`Referrer-Policy`・`Permissions-Policy`を付与する。

- **Cloudflare Pages Functionsの応答には`_headers`のルールが適用されない**(2026-09-18の実測: `pr-102`の`/api/health`にCSP/HSTSが付かない)。そのためヘッダは`_headers`ではなくAPI側に持たせ、`_headers`との値の一致をテスト(`tests/api-hardening.test.js`)で固定してドリフトを防ぐ。
- `scripts/serve-production.mjs`は、これに加えて`_headers`の`/*`ルールのうち不足しているものを`applyEdgeHeaders`で補う(アプリが設定したヘッダは上書きしない)。404/413/500のエラー応答にもHSTSを付与する。
- ローカル開発サーバー(`scripts/serve-local.mjs`)はHTTP配信のためHSTSのみ除去し、CSP等は本番と同じものを付与する(E2Eで検証される)。
- Pages Functionsの`AUTH_MODE!=access`による503応答にも同じヘッダを付与する。

### レート制限

利用者(Cloudflare AccessのJWT email、demo時は`x-demo-actor`)ごとに、60秒窓で回数を数える。超過時は`429`。

| バケット | 対象 | 既定 | 設定 |
| --- | --- | --- | --- |
| `write` | `POST`/`PATCH`/`PUT`/`DELETE`(公開読み取りと`OPTIONS`を除く) | 240回/分 | `WRITE_RATE_LIMIT_PER_MINUTE` |
| `ai` | `POST /api/drawings/:id/agent-runs`のうちLLMフォールバックを使う経路 | 10回/分 | `AI_RATE_LIMIT_PER_MINUTE` |

- 状態はプロセス内メモリに保持し、キー数上限(`10_000`)を超えた場合は期限切れ→最も古い順に破棄する。以前は利用者ごとの配列が無制限に増え続けていた。
- AI提案経路も更新系に含まれるため`write`バケットも消費する(別バケットのため片方だけでは素通りしない)。
- 単一プロセス常駐のため、これはプロセス単位の制限である。エッジ(WAF)側の制限は別途の検討事項。

## Migration

| File | 内容 |
| --- | --- |
| `0001_initial.sql` | project、drawing/version、command、agent、review、audit |
| `0002_idempotency.sql` | 更新APIの重複実行防止 |
| `0003_drawing_revision.sql` | 図面更新の楽観ロック用revision |
| `0004_drawing_visibility.sql` | 匿名公開を明示し、既定をprivateに固定 |
| `0005_audit_log_immutability.sql` | `audit_logs`をDBトリガーで追記専用化(UPDATE/DELETE拒否) |
| `0006_normalize_jsonb_columns.sql` | JSONBが文字列として二重保存されていた過去データをobject/arrayへ復元 |
| `0007_project_membership.sql` | `projects.access_scope`(既定`open`)と`project_members`を追加し、案件単位のアクセス制御を可能にする(既存案件は挙動不変) |
| `seeds/demo.sql` | 5レイヤー、4図形の再実行安全なデモ図面 |

Neon Preview/Productionへ`0004`を適用し、デモだけがpublicであることを確認しました(2026-08-27時点、Neon利用時代の記録)。2026-08-30の移行後は、ローカルPostgreSQL 16の本番DB(`mirai_web_cad`)へ全migrationを適用済みです。

`0005`(UPDATE/DELETE)と`0008`(TRUNCATE)は`db:verify`の中で、**トリガー3件**の存在と、UPDATE/DELETE/TRUNCATEが`42501`で拒否されることを機械検証します。拒否理由は「トリガ(`audit_logs is append-only`)」または「権限不足(`permission denied for table audit_logs`)」のいずれでも成立とします(所有権分離後は権限が先に拒否するため)。監査ログはDB権限保有者を含め改変・削除・切詰めできません。ただし所有者は`alter table ... disable trigger`を実行できるため、恒久的な保護には所有権分離が必要です(`scripts/sql/harden-audit-role.sql`)。
