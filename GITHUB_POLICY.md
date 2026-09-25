# Mirai-Web-CAD GitHub運用ポリシー

状態: 2026-09-25 改定(v2)。以前このファイルにあった「DeepSeek-Harness-StartUpTools GitHub Policy」(中央配布の自動マージ方針、2026-08-15 v1)は、**本リポジトリには適用しない**(独立レビュー H-2)。そのポリシーは存在しない必須チェック名(`quality (20)`等)と別リポジトリのスクリプトを前提にし、「mergeは人間承認が必要」との記述を無視するよう定めていたため、本リポジトリの承認方式(A型)と矛盾していた。

## 1. 正本と優先順位

1. 組織方針(`/etc/claude-code/CLAUDE.md`)と、組織の開発ガバナンス(`mirai-construction-dx/Mirai-Construction-DX-Portfolio` の `docs/operations/PORT-GOV-001_開発ガバナンスと役割分担.md`)
2. GitHubの実設定(Ruleset・Branch Protection)。本ファイルと食い違う場合は実設定が優先し、本ファイルを直す
3. 本ファイル
4. [AGENTS.md](AGENTS.md)・`CLAUDE.md`・README

中央から再配布される文書で本ファイルを上書きしない。

## 2. 承認方式: A型(承認必須、2026-09-25〜)

| 役割 | 担当 | すること | しないこと |
| --- | --- | --- | --- |
| 作成 | Bot `mirai-dx-bot`(Team `ai-authors`) | AIの変更をBot名義でcommit・push・PR作成。オーナーのApprove後にsquashマージ | 承認しない。保護設定を変更しない |
| レビュー | CI、CodeRabbit、AIエージェント | 指摘をPRのスレッドに残す。指摘は修正するか根拠を返信して解決する | GitHubの「Approve」をしない |
| 承認 | オーナー(CODEOWNER `@Kensan196948G`) | GitHub上でApproveする。高リスク変更はY/Nも判断する | ― |

- AIエージェントはオーナーのアカウントで代理承認しない。
- 承認後にcommitを追加した場合は承認し直しが必要(最後のpush後の承認を必須化)。
- 2人目の承認者は2026-10以降に決定(見直し期限2026-10-31、[外部入力・確定待ち台帳](docs/external-input-status.md)§4)。

## 3. main の保護(実設定)

Ruleset `central-auto-merge`(対象 `refs/heads/main`、bypassなし):

- Pull request: 承認1件、CODEOWNERの承認、最後のpush後の承認、レビュースレッドの解決、pushで古い承認を取消、マージ方法はsquashのみ
- 必須チェック(strict: mainの最新を取り込んでいること):
  - `Lint, Test, Build, E2E, A11y`
  - `Empty PostgreSQL Migration`
  - `PostgreSQL Backup and Restore Drill`
  - `PostgreSQL Data Store Integration`
  - `Secret Scan`
  - `Dependency Vulnerability Audit`
  - `SBOM (CycloneDX)`
  - `Synthetic DXF Generation and Audit`
  - `Terraform Format and Validate`
  - `Deploy Preview`
- 直接push(non-fast-forward)と削除は禁止

Branch Protection(main): 必須チェックは上記のうち `Lint, Test, Build, E2E, A11y`、`Empty PostgreSQL Migration`、`PostgreSQL Backup and Restore Drill`、`Secret Scan`、`Dependency Vulnerability Audit`。管理者にも適用、レビュースレッドの解決必須、履歴は直線のみ、force push禁止。

必須チェックの名前は `.github/workflows/*.yml` のジョブ名と一致させる(`tests/github-policy.test.js` が検査する)。

確認コマンド(読み取りのみ):

```bash
gh api repos/mirai-construction-dx/Mirai-Web-CAD/rulesets --jq '.[].id' \
  | xargs -I{} gh api repos/mirai-construction-dx/Mirai-Web-CAD/rulesets/{}
gh api repos/mirai-construction-dx/Mirai-Web-CAD/branches/main/protection
```

## 4. 必ずオーナーのY/Nを取る変更(高リスク)

Approveに加えて、次はオーナーの明示的なY/Nを得てから実行・マージする(PORT-GOV-001 §5)。

- 認証方式・認可モデルの変更
- 公開DNS・custom domain・production routeの変更
- production secretの追加・変更・削除・ローテーション
- 課金・契約・費用構造に影響する変更
- 公開範囲(Cloudflare Accessのポリシー等)・データ保持期間・監査方式の変更
- destructive migration・本番データの削除
- Ruleset・Branch Protection・CODEOWNERSによる保護の変更
- 本番のデプロイ手順・systemd設定の変更

## 5. 禁止事項

- mainへの直接push、force push、ブランチ保護の無効化・迂回
- Botやエージェントによる承認、オーナーのアカウントでの代理承認
- 秘密値・資格情報・接続文字列・個人情報をGit・PR・ログへ出すこと
- 他Repositoryのコード・DBへの直接依存(基盤で許可された接続のみ。[基盤連携の要件と現状](docs/architecture/platform-integration.md))
