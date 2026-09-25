# ADR-0004: 技術スタックとOS・アプリケーション選定 V3.5 の標準との差の扱い

## ステータス

提案(Proposed、2026-09-25)。OS・アプリケーション選定 V3.5 の標準がDomain Product(Web-CAD)にも適用されるかが文書から判断できないため、適用範囲の確認を待つ。決定まではスタックを変更しない。

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

## 提案する決定

適用範囲の確認を先に行う。確認までは案Aとし、Node 22のサポート期限など外部要因で更新が必要になった時点で、案Bのうち実行環境の更新(PostgreSQL・Node)だけを個別のADRで判断する。

## 結果

- 差分は[基盤連携の要件と現状](../architecture/platform-integration.md)と[外部入力・確定待ち台帳](../external-input-status.md)§4に記録する。
