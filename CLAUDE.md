# CLAUDE.md — Mirai-Web-CAD

作業規約は [AGENTS.md](AGENTS.md) にまとめています。着手前に必ず読んでください。特に重要な点:

- 本番とMVPはこの作業ツリーの`dist/`を配信します。**ここで`npm run build`/`verify`/`dev`を実行しない**(検証は`git worktree`等の別ディレクトリで)。
- Web-CADは基盤のDomain Productです。他システムDBへの直結、Core/Platform-Infraの正本の複製・上書きはしません([基盤連携の要件と現状](docs/architecture/platform-integration.md))。
- 秘密値をGit・ログ・PRへ出さない。migrationはadditiveのみ。本番DBへ`db:verify`を実行しない。
