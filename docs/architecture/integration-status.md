# 統合ステータスAPI(GET /api/integration/status)

更新日: 2026-10-23。状態: **実装済み(読み取り専用。外部システムへの送信・登録は未実装)**。
関連: [基盤連携の要件と現状](platform-integration.md) §6、[Core evidence エクスポート](core-evidence-export.md)、
[Staging E2Eと公開境界の検証](../runbooks/staging-e2e.md)。

## 1. 目的と非目標

目的:

- Portfolio・MCIPなど基盤側から「Web-CADが今どの連携状態にあるか」を**読み取り専用**で確認できるようにする。
- 連携の「できている/いない」を外部システムへ推測させず、Web-CAD自身が定数として表明する。
- 稼働中サーバーのcommitと配信物のbuild元commitを返し、版の取り違えを検出できるようにする。

非目標(意図的に実施しない):

- Core・MCIP・CDE・MCPへの接続、API/MCP呼び出し、データ送信。
- DBの読み書き(監査ログの追記を含む)。
- 秘密値・環境変数の値・利用者情報の返却。
- 「本番利用可能」の判定。このAPIは**状態の表明**であり、連携の認可・契約・受入の完了を意味しない。

## 2. エンドポイントと認可

| 項目 | 内容 |
| --- | --- |
| メソッド/パス | `GET /api/integration/status`(`/api/v1/...` も同じ) |
| 認可 | `viewer` 以上(`ROLE_POLICIES` の全ロール)。未認証は **401** |
| 公開 | しない。`/api/health`・`/api/drawings/demo` と違い、`isPublicReadRoute` に含めない |
| CORS | 既存のAPIと同じ。`CORS_ORIGIN` の許可リストに従う |
| キャッシュ | `cache-control: no-store` |
| セキュリティヘッダ | API共通のCSP・HSTS・`x-content-type-options`・`x-frame-options`・`referrer-policy`・`permissions-policy` |
| 状態変更 | なし(GETのみ。監査ログも書かない。他のメソッドは404) |

`viewer` 未満のロールは現状定義していない。将来追加した場合に誤って通さないよう、未知のロールは403で拒否する(fail-closed)。

## 3. 返却例

```json
{
  "ok": true,
  "system_id": "web-cad",
  "environment": "staging",
  "deployment": {
    "commit": "61c8b9d0e2f7a4c8d9b1a0f3e5c7d9b2a4f6e8c0",
    "distCommit": "61c8b9d0e2f7a4c8d9b1a0f3e5c7d9b2a4f6e8c0"
  },
  "integrations": {
    "core": {
      "registered": true,
      "lock": "absent",
      "signed_release": "unverified"
    },
    "mcip": {
      "configured": false,
      "project_id_api": "unavailable"
    },
    "cde": {
      "configured": false,
      "approved_version_api": "unavailable"
    },
    "mcp": {
      "exposed": false,
      "allowlisted": false
    }
  }
}
```

`deployment.commit` は稼働中サーバーのcommit、`distCommit` は配信中の画面(`dist/`)のbuild元commit。
どちらも不明な場合は `null`。`environment` は `APP_ENV` の値(未設定は `null`)。ブランチ・dirty・ファイルパスは返さない。

## 4. 値の意味

### 4.1 core

| フィールド | 現在値 | 意味 |
| --- | --- | --- |
| `registered` | `true` | Web-CADにCore連携口(証跡の射影 `src/core-evidence.js`・読み取り専用CLI)が実装されていること。**Core契約への準拠や版固定の完了を意味しない** |
| `lock` | `absent` | `core-lock/contracts.lock.json`(Coreの版付き成果物の取込み)がリポジトリに存在しないこと。存在すれば `present` |
| `signed_release` | `unverified` | 署名・attestation付きのCore Releaseを検証して取り込んでいないこと(2026-10-23時点で署名付きReleaseが無い。[platform-integration.md](platform-integration.md) §6.2) |

`lock` はNode実行時にファイルシステム(`core-lock/contracts.lock.json` の有無)で判定する。Cloudflare Pages Functions(workerd)のようにファイルシステムが無い環境では、誤って「取込み済み」と報告しないよう `absent` に倒す(fail-safe)。判定に失敗した場合も `absent`。

### 4.2 mcip

| フィールド | 現在値 | 意味 |
| --- | --- | --- |
| `configured` | `false` | MCIPへの接続設定・クライアント登録が無い |
| `project_id_api` | `unavailable` | 全社共通の案件IDを発番・配布するAPIがMCIPに無い([platform-integration.md](platform-integration.md) §6.3) |

### 4.3 cde

| フィールド | 現在値 | 意味 |
| --- | --- | --- |
| `configured` | `false` | CDEへの接続設定・クライアント登録が無い |
| `approved_version_api` | `unavailable` | Web-CADの承認済み版を受け入れるAPIがCDEに無い([platform-integration.md](platform-integration.md) §6.4) |

### 4.4 mcp

| フィールド | 現在値 | 意味 |
| --- | --- | --- |
| `exposed` | `false` | Web-CADをMCPサーバーとして公開していない |
| `allowlisted` | `false` | Tool Gateway等の許可リストへ登録していない |

### 4.5 値の語彙

- `unavailable`: 外部システム側にAPI・受入設計が無く、Web-CADから利用できない。
- `absent`: 取り込むべき成果物・設定がリポジトリ/環境に存在しない。
- `unverified`: 成果物は存在し得るが、署名・attestation等の検証をしていない。
- `configured`/`exposed`/`allowlisted`: 設定・公開の有無(秘密値そのものは返さない)。

## 5. 実装上の保証

`src/api-handler.js` の `GET /integration/status` は次を守る。

- **外部呼び出しなし**: `fetch` 等でCore・MCIP・CDE・MCPへアクセスしない(応答は定数とファイル有無だけ)。
- **DB書き込みなし**: `createDataStore` はリクエスト処理の共通経路で生成されるが、このルートはストアを呼ばない。監査ログ(`audit_logs`)への追記もしない。
- **秘密非出力**: `APP_ENV`・`DEPLOY_INFO.commit`・`DEPLOY_INFO.distCommit` 以外の環境変数値を返さない。`DATABASE_URL`・`*_SECRET`・`ACCESS_ROLE_MAP`・利用者メールは応答に含めない。
- **状態の凍結**: `INTEGRATION_STATUS` は `Object.freeze` 済みの定数。状態が変わったときは定数・本ドキュメント・テストを同じPRで更新する。
- **Pages互換**: `node:fs` を静的にimportしない(`functions/api/[[path]].js` が `src/api-handler.js` を読み込むため)。ファイル判定はNode実行時だけ `process.getBuiltinModule` 経由で行う。

## 6. Portfolio/MCIPからの利用想定

本APIは[platform-integration.md](platform-integration.md) §6.7の「連携状況の記録(`integration status`)」を、静的な文書ではなく読み取り専用APIとして実装したものである。Web-CAD自身が実測した接続状態を応答で表明し、他システムへの接続は行わない。

- **Portfolio**: システム台帳の `web-cad` エントリから、稼働環境の連携状態を確認する。Portfolio側の登録・更新はPortfolioの手順(PORT-OPS)に従い、本APIは読み取り専用の参照先として使う。Stagingの登録はPortfolio側の作業(2026-10-23時点で未登録)。
- **MCIP**: 将来、案件IDの発番APIが提供されたときに「Web-CADが連携可能か」を確認する。ただし `project_id_api: "unavailable"` の間は連携しない。
- 参照する側は、`unavailable`/`absent`/`unverified` を「未完了」として扱い、`ok: true` を「連携完了」と読み替えない。値はAPIを呼んだ時点の表明であり、次回リリースで変わり得る。
- 認証はCloudflare AccessのJWTが必要(viewer以上)。Portfolio等が機械的に参照する場合は、Access Service Token等の既存の認可境界に従う(新しい認証方式は追加しない)。

## 7. 更新方針

状態を変える変更(Core成果物の取込み、MCIP/CDEのAPI提供開始、MCP公開など)では、次を同じPRで更新する。

1. `src/api-handler.js` の `INTEGRATION_STATUS`(または `coreLockStatus`)。
2. 本ドキュメントの「現在値」「値の意味」。
3. `tests/integration-status.test.js` の期待値。

署名付きReleaseを検証して `core-lock/contracts.lock.json` を作成した場合は、`lock: "present"` となり、`signed_release` の扱いも併せて見直す。

## 8. 制約・残課題

- 現状は**情報提供のみ**で、連携の登録・承認・送信は行わない。PortfolioへのStaging登録、MCIP案件IDの連携、CDEへの確定版登録は外部入力待ち([platform-integration.md](platform-integration.md) §6.9)。
- `deployment.commit`/`distCommit` は `DEPLOY_INFO` が設定されている環境でのみ値が入る。ローカル開発やテストでは `null`。
- レスポンスの`lock`判定はリポジトリ直下の `core-lock/contracts.lock.json` の有無だけを見る。ファイル内容(digest・版)の妥当性は検証しない(取込み手順の実装時に別途検証する)。
- このAPIの可用性はWeb-CADの稼働に依存する。外部監視から参照する場合は既存のhealth監視と併用する。
