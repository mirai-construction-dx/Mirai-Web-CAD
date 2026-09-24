# テスト方針

## Gate

| Gate | コマンド | 主な検査 |
| --- | --- | --- |
| Lint | `npm run lint` | 必須成果物、JavaScript構文、未解決マーカー、`_headers`の書式 |
| Static | `npm run lint:static` | ESLint(flat config)。未定義参照、重複キー/引数、到達不能コード、未使用変数、定数条件、`await`後の`state`更新(warnのみ) |
| Type | `npm run typecheck` | `checkJs`によるUI、CAD Core、API、PostgreSQL層の型整合 |
| Unit/API | `npm test` | CAD不変条件、CLI、Import、公開/private境界、JWT、RBAC、本文制限、原子更新、AI承認、10k図形Core baseline。`TEST_DATABASE_URL`(DB名に"test"を含む場合のみ)設定時は実PostgreSQLに対する統合テスト(`tests/data-store.pg.test.js`)も実行 |
| A11y static | `npm run a11y` | lang、ARIA、focus-visible、Responsive規則 |
| Build | `npm run build` | Cloudflare Pages配信物生成 |
| E2E | `npm run test:e2e` | desktop/mobile UI、新規作成、CLI、Undo/Redo、Import、Canvas、API同期、AI承認、Keyboard、axe |
| DB | `npm run db:verify` | 空PostgreSQLへMigration 0001〜0008/Seedを2回適用、監査追記専用トリガー**3件**(UPDATE/DELETE/TRUNCATE)の存在と各操作の拒否を検証 |
| DB(読み取り専用・手動確認) | `npm run db:check` | 書き込みを行わず、migration作成物・監査トリガー3件と拒否・JSONB形状を検証。未適用ならexit 1。デプロイ手順(`scripts/deploy-local.sh`)もこれを実行する(2026-09-25〜、改善台帳P0-74) |
| Recovery | `npm run db:backup` / `db:restore` | custom archive検証、空DB復元、主要件数確認 |
| Secret | GitHub Actions | Gitleaksで独立リポジトリ全体を走査 |

`npm run verify`はDB以外のローカルGateを一括実行します。DB検証は`DATABASE_URL`を明示した隔離DB、CIではPostgreSQL service containerを使用します。

## Preview E2E

```bash
E2E_BASE_URL=https://mvp-round-5.mirai-web-cad.pages.dev npm run test:e2e
```

正常、空、Loading、Error、viewer拒否、新規作成、コマンドライン、Undo/Redo、JSON Import、Escapeキー、狭幅レイアウト、axe Critical/Serious 0件をdesktop/mobile Chromiumで確認します。AI変更はPreview表示後の明示承認でのみ適用します。

## 2026-08-26 本ラウンド証跡

### 独立リポジトリ移行

- 新repo PR #1、merge commit `c93a917fe5632234b5cbb5f46abfba9fb1a78ece`
- CI run `32936884367`: Lint/Type/34 Unit・API・性能/12 E2E/A11y/Build、Migration、Recovery、Secret Scan成功
- Preview deployment `6950bcc0`: 実Neonに対するdesktop/mobile E2E 12/12成功
- Previewで検出したdrawing version外部キー不整合を修正し、再試験で作図・AI承認・監査同期成功
- Production deployment `81194e17`: SPA/health/demo 200、private drawing/write 401、CSP違反0
- Construction OSは別Pages projectで既存302を維持

### Production release

- PR #19 / merge commit `b20340001bc069b45774482e76238b7d3dfbaba1`
- GitHub Actions `32934876851`: Verify Release、Deploy Cloudflare Pagesともに成功
- Cloudflare deployment `7eaa57b7-c7ff-4ac0-89dc-5d8da6e11991`
- 本番smoke: SPA / health / public demo 200、private drawing / write 401
- Browser smoke: viewer固定、Canvas描画、主要操作面の非重複をdesktop/mobileで確認
- Cloudflare Web Analyticsの配信元だけをCSP許可し、inline script/styleおよび未知の外部配信元は引き続き拒否

| 検証 | 結果 |
| --- | --- |
| `npm run verify:fast` | PASS。Lint、Type、static A11y、34 Unit/API/性能baseline、Build |
| PostgreSQL 16空DB(CIは`postgres:16-alpine`) | PASS。Migration 0001-0008/Seedを2回適用、監査追記専用トリガー3件の検証込み |
| Neon Preview原子更新 | PASS。revision 2、audit 2、idempotency 2を別queryで確認後、試験レコード削除 |
| backup/restore drill | PASS。custom archiveを空DBへ復元、SHA-256・取得時刻、backup manifestとの4表件数・最新版署名一致、JSONB形状、全図面の最新版参照を検証 |
| 未実施 | Production実データbackup/restore、100k図形負荷、障害注入、SSO実利用者E2E |
