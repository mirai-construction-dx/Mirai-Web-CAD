# Staging E2Eと公開境界の検証

Stagingの受入で使う検証コマンドをまとめる。いずれも**読み取り専用**で、Stagingのデータを変更しない範囲を基本とする。秘密値はGit・ログ・チャットへ出さない。

## 1. ローカルE2E(トークン不要)

Stagingサービスへ直接アクセスし、desktop/mobileの画面・Canvas・`/api/health`・DBプローブ・配信commitを検証する。`AUTH_MODE=access`のStagingでは、ユーザーJWTが無いため書込み操作は行わない(ヘルスは匿名viewerで200、書込みはfail-closed)。

```bash
# Stagingサービスが 127.0.0.1:18814 で稼働していること
E2E_EXPECT_COMMIT="$(git rev-parse HEAD)" npm run test:e2e:staging -- --local
```

- `--local` を付けると `http://127.0.0.1:18814` を対象にし、Access Service Tokenを要求しない。
- `E2E_EXPECT_COMMIT` を指定すると、`/api/health` の `deploy.distCommit`(無ければ `deploy.commit`)と照合する。配信commitの取り違えを検出する。
- 出力はJSONで、`mode: "local"`、`apiStatus`、`dbMode`、`deployedCommit` を含む。

## 2. 公開URLのAccess境界(トークン不要)

未認証アクセスが**302でCloudflare Accessのログインへ遷移**すること、`/api/health`もAccessの内側にあること(bypassが無いこと)、本番/MVPが従来どおりであることを検査する。

```bash
bash scripts/check-staging-public-boundary.sh
```

- 環境変数 `E2E_STAGING_URL`、`E2E_PRODUCTION_HEALTH_URL`、`E2E_MVP_URL`、`E2E_HTTP_TIMEOUT` で対象を変更できる。
- 期待値: Staging `/` と `/api/health` は302で `cloudflareaccess.com` へ、本番 `/api/health` は200、MVP `/` は302。
- 302以外、200、リダイレクト先がAccessでない場合はexit 1。

## 3. 公開URLのE2E(Access Service Token。テスト時のみ)

公開URLをAccess Service Tokenで認証し、desktop/mobileの画面を検証する。Service Tokenは**テストのためだけ**に作成し、テスト直後にpolicyとtokenの両方を削除する。通常利用のAccess policyへService Tokenを残さない。

```bash
E2E_CF_ACCESS_CLIENT_ID=... E2E_CF_ACCESS_CLIENT_SECRET=... \
  E2E_EXPECT_COMMIT="$(git rev-parse HEAD)" \
  npm run test:e2e:staging
```

- Service TokenはユーザーJWTではないため、`/api/health`は401(fail-closed)になるのが正常。スクリプトは401を「正しく拒否している」証跡として扱い、200のときだけDBプローブを検証する。
- 401でも画面・Canvasの描画は検証する。編集操作は行わない。
- トークン値はコマンド履歴・ログ・Issue・チャットへ残さない。テスト後はStaging Applicationのpolicyが `allow` + `kensan1969@gmail.com` のみに戻ったことを確認する。

## 4. 受入での使い分け

| 目的 | コマンド | 期待 |
| --- | --- | --- |
| Stagingが候補commitを配信している | `E2E_EXPECT_COMMIT=<sha> npm run test:e2e:staging -- --local` | exit 0、`deployedCommit=<sha>` |
| 公開境界がAccessで保護されている | `bash scripts/check-staging-public-boundary.sh` | exit 0、Staging=302 |
| 公開URLの画面が配信されている | Service Token付き `npm run test:e2e:staging` | exit 0(または401を許容した成功) |
| DB・env・systemd・監視 | `bash scripts/check-staging-readiness.sh` | exit 0 |
| 本番/MVPが不変 | `bash scripts/check-staging-public-boundary.sh` | 本番200、MVP302 |

## 5. 注意

- `--local` はAccessを経由しないため、Access境界の証明にはならない。境界は §2 で別途検証する。
- 公開URLのE2EはService Tokenの作成・削除を伴う。自動化する場合も、トークン値を標準出力・ログへ出さない実装にする。
- Stagingのデータは使い捨てであり、本番・MVPへ昇格させない。
