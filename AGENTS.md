# AGENTS.md — Mirai-Web-CAD

AIコーディングエージェント(Claude Code / Codex / OpenCode等)と開発者が、このリポジトリで作業するときの規約です。
組織の上位方針(`/etc/claude-code/CLAUDE.md`、[GITHUB_POLICY.md](GITHUB_POLICY.md))と矛盾する場合は上位方針が優先します。

## 1. このリポジトリの位置付け

- 基盤全体構成 V3.6 の **08 Mirai-Web-CAD(Domain Product)**。ブラウザで土木2D図面を作成・修正・確認する試作版CAD。
- **正本として持つのは「編集中の2D図面」だけ**。確定版はCDE、案件ID・承認・証跡の正本はMCIP(将来)。
- 他リポジトリとの接続は、基盤で許可された4種類に限る。詳細と現状の差は[基盤連携の要件と現状](docs/architecture/platform-integration.md)。
  1. Mirai-Harness-Coreの版付き成果物をビルド/起動時に取り込む(版とdigestを固定。`latest`・main直参照・submodule禁止)
  2. 実行時はAPI / MCP / Tool Gateway
  3. データは正本API・CDE参照から取得
  4. イベントは版付きschemaを介す
- 禁止: 他システムDBへの直結、他リポジトリのコード直参照、Core/Platform-Infraの正本(Contracts等)のコピーや上書き。**Domain ProductからのAI Provider直接呼出しも基盤方針では禁止**(現状は暫定的に直接呼出し中。[ADR-0003](docs/adr/ADR-0003-ai-provider-direct-call-interim.md))。

## 2. 構成

| パス | 内容 |
| --- | --- |
| `src/` | ブラウザSPA(`app.js`)とCAD Core(`cad-*.js`)、API(`api-handler.js`)、DXF入出力 |
| `scripts/` | 開発/本番サーバー、build、lint、DB検証、デプロイ、バックアップ |
| `migrations/` | 自リポジトリのPostgreSQL schemaのみ(additive・後方互換のみ) |
| `tests/` | 単体(`node --test`)と`tests/e2e/`(Playwright) |
| `docs/` | 設計・運用・台帳。ADRは`docs/adr/` |

## 3. 検証コマンド

```bash
npm run verify:fast   # lint / ESLint / typecheck / a11y / 単体テスト / build
npm run test:e2e      # Playwright desktop/mobile(ポートが空いている前提)
```

- **本番の作業ツリーでbuildも依存導入もしない。** 本番とMVPのサービスはリポジトリ直下の`dist/`(`.releases/<sha>/dist`へのsymlink)をリクエストごとに読み、`node_modules/`(同じくsymlink)を実行時に使う。`npm run build`/`verify`/`dev`/`test:e2e`(`E2E_BASE_URL`なしだと`npm run dev`でbuildする)や`npm ci`を実行すると、未マージのコードの配信や依存の消失が起きる。検証は`git worktree`等の別ディレクトリで行う。worktreeの`node_modules`を本番へのsymlinkにした場合、そこで`npm ci`を実行しない。
- E2Eを別ディレクトリで流すときは、空いているポートで`PORT=<port> HOST=127.0.0.1 node scripts/serve-local.mjs`を起動し、`E2E_BASE_URL=http://127.0.0.1:<port> npx playwright test`とする(使用中ポートに別プロセスがあると誤った結果になる)。
- 追加したテストは、修正前のコードで失敗することを確かめる。

## 4. 変更の規約

- Branch → PR → CI → レビュー → squash merge。mainへの直接pushは禁止。
- AIエージェントはBot(`mirai-dx-bot`、Team `ai-authors`)の名義でcommit・push・PR作成する。Botは承認しない(組織の開発ガバナンス Portfolio `docs/operations/PORT-GOV-001`)。
- 本リポジトリの承認方式は**A型(承認必須)**(2026-09-25にB型から切替え): Bot名義で作成したPRに、CODEOWNER(オーナー)がGitHub上でApproveした後にマージする。承認後にcommitを追加すると承認し直しが必要。AI・Botは承認しない。オーナーのアカウントで代理承認もしない。高リスク変更(認証・secret・DNS・課金・公開範囲・破壊的migration・保護設定)は、Approveに加えてオーナーのY/Nを得る。
- オーナー不在時に本番障害を止める手順は[オーナー不在時のロールバック](docs/runbooks/owner-absence-rollback.md)(mainは変更しない)。
- PR本文は目的・変更・影響・テスト・セキュリティ・Migration・Deployment・Rollback・残課題・production-safe判定を記載する。
- 秘密値・資格情報・接続文字列・個人情報をGit、ログ、PR、テスト結果へ出さない。
- migrationはadditiveかつ後方互換のみ。本番DBへ`db:verify`を実行しない(手順は[ローカルデプロイ運用メモ](docs/deployment-local.md))。
- 仕様変更・機能追加ではREADMEの該当行と関連文書、E2Eバッジ(実数)を同じPRで更新する。
- 不明な仕様は推測で確定せず、[外部入力・確定待ち台帳](docs/external-input-status.md)やADRに選択肢と影響を記録する。

## 5. 基盤の正本文書(複製しない)

| 文書 | 正本 |
| --- | --- |
| 全体構成 V3.6 | `mirai-construction-dx/Mirai-Construction-DX-Portfolio` `docs/baseline/source-snapshots/`(commit `4d87890`) |
| リポジトリ構成 ベストプラクティス V3.6 | 同上 |
| OS・アプリケーション選定 ベストプラクティス V3.5 | `mirai-construction-dx/Mirai-Platform-Infra` リポジトリ直下(commit `9ba5375`) |
