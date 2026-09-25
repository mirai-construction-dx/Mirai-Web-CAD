# ADR-0004: 技術スタックとOS・アプリケーション選定 V3.5 の標準との差の扱い

## ステータス

承認済み(Accepted、2026-09-25) — オーナーの委任によりCTOが決定。アプリ構成は例外として維持し、実行環境(Node・PostgreSQL)だけを期限付きで標準へ更新する。

## コンテキスト

OS・アプリケーション選定 ベストプラクティス V3.5 は、PostgreSQL 18、Node 24 LTS(buildのみ)、React + TypeScript + Vite、APIはFastAPIを標準として挙げる。Web-CADの現状は次のとおり。

| 項目 | 標準(V3.5) | Web-CAD現状 |
| --- | --- | --- |
| DB | PostgreSQL 18 | PostgreSQL 16(本番ローカル、CIも16) |
| Node | 24 LTS、build時のみ | CIはNode 22、`engines`は`>=20`、実行時にNode製APIサーバー(`scripts/serve-production.mjs`)を使用 |
| フロントエンド | React + TypeScript + Vite | vanilla JS(ES modules)+ esbuild、`checkJs`で型検査 |
| API | FastAPI | Node(`src/api-handler.js`) |

## 選択肢

| 案 | 内容 | 影響 |
| --- | --- | --- |
| A. Domain Productには適用しない(現状維持) | 標準は基盤共通部品向けと解釈 | 変更なし。適用範囲の明文化が必要 |
| B. 段階的に標準へ寄せる | まずPostgreSQL 18とNode 24へ更新し、フロントエンド・APIの置換は別途判断 | DBのメジャー更新は本番移行・復元ドリルを伴う。React/FastAPIへの置換は実質的な再実装 |
| C. 例外として登録 | 標準からの逸脱をPlatform-Infra等の例外台帳へ登録 | 他リポジトリでの登録が必要 |

## 決定

1. **アプリ構成は例外として維持する**(案A)。vanilla JS(ES modules)+ esbuild + `checkJs`、Node製API。React + TypeScript + Vite / FastAPI への置換は実質的な再実装であり、行わない。
2. **実行環境は標準へ更新する**(案Bのうち実行環境のみ)。
   - Node: 24 LTSへ更新する(CI → `engines` → 本番の順)。**期限 2027-01-31**(Node 22のサポート終了 2027-04-30 の3か月前)。
   - PostgreSQL: 18へ更新する(バックアップ・復元ドリルを含む移行手順で実施)。**期限 2027-11-30**(PostgreSQL 16のサポート終了 2028-11 の1年前)。PostGIS/pgvector等が必要になった場合は前倒しする。
3. 標準との差(アプリ構成)はPortfolioの基礎資料適用マトリクスに例外として記録することを推奨する。

2026-09-25時点の実測: 本番ホストは Node v22.22.3(nvm)、PostgreSQL 16.14。ホストにはPostgreSQL 17/18のバイナリも導入済み。

## 結果

- 差分は[基盤連携の要件と現状](../architecture/platform-integration.md)と[外部入力・確定待ち台帳](../external-input-status.md)§4に記録する。
