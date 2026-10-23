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

公開URLをAccess Service Tokenで認証し、desktop/mobileの画面を検証する。Service Tokenは**テストのためだけ**に作成し、テスト直後にpolicyとtokenの両方を削除する。通常利用のAccess policyへService Tokenを残さない。**トークンの作成・Access policyの変更・削除はオーナーの手動**であり、リポジトリ内のスクリプトは行わない。

### 3.1 自動ラッパー(トークン値を出力しない)

`scripts/run-staging-access-e2e.sh` は、次の順に実行する。

1. `scripts/check-staging-public-boundary.sh`(未認証の公開境界。Staging 302 / 本番200 / MVP302)
2. `npm run test:e2e:staging`(公開URL + Access Service Token。`E2E_EXPECT_COMMIT`は任意)
3. `scripts/check-staging-public-boundary.sh` の再実行(E2E後もAccess境界が維持されていること)

```bash
# 1. 実行計画の確認(トークン不要・ネットワークへ接続しない)
bash scripts/run-staging-access-e2e.sh --dry-run

# 2. トークンを対話入力する(シェル履歴に値を残さない)
read -rs -p "Client ID: " E2E_CF_ACCESS_CLIENT_ID; echo
read -rs -p "Client Secret: " E2E_CF_ACCESS_CLIENT_SECRET; echo
read -r -p "Expect commit (任意・空でも可): " E2E_EXPECT_COMMIT
export E2E_CF_ACCESS_CLIENT_ID E2E_CF_ACCESS_CLIENT_SECRET E2E_EXPECT_COMMIT

bash scripts/run-staging-access-e2e.sh

# 3. 使い終えたらシェルの環境からも削除する
unset E2E_CF_ACCESS_CLIENT_ID E2E_CF_ACCESS_CLIENT_SECRET E2E_EXPECT_COMMIT
```

- トークン値は環境変数として子プロセスへ渡すだけで、`echo`・エラーメッセージ・実行計画・ログには出さない。実行計画には「設定済み/未設定」だけを表示する。
- 子プロセスへは`env -i`で必要な変数だけを渡す。トークン不要の境界チェックにはトークンを渡さず、`E2E_STAGING_LOCAL`のようなローカルモード切替も渡さない。
- どちらかが未設定の場合は、実行計画(dry-run相当)を表示して **exit 78** で終了する。実テストもネットワークアクセスも行わない。
- `--dry-run` はトークンの有無にかかわらず、実行するコマンド・対象URL・期待commitだけを表示し、何も実行しない(exit 0)。
- **`bash -x`(xtrace)で実行しない。** スクリプトはトークンを読む前に`set +x`でxtraceを無効化してその旨をstderrへ出すが、呼び出し側のDEBUGトラップ、シェル履歴、`set -x`を有効にしたままのターミナルなど、スクリプト外の経路までは防げない。
- **CIでは実行しない。** トークンをCIへ置かず、実ネットワークへ依存しない。CIで実行されるのは`node --test tests/staging-access-e2e.test.js`のスタブ検証だけ。
- 実行ログをIssue・チャットへ貼る場合も、トークンが含まれていないことを確認する。`npm`/Playwrightの出力全文をそのまま共有しない。
- トークンは子プロセスの環境変数として渡るため、同一ホストの他利用者がプロセス環境を覗ける構成では実行しない(オーナー単独利用のホストで実行する)。

### 3.2 ラッパーを使わずに実行する場合

```bash
E2E_CF_ACCESS_CLIENT_ID=... E2E_CF_ACCESS_CLIENT_SECRET=... \
  E2E_EXPECT_COMMIT="$(git rev-parse HEAD)" \
  npm run test:e2e:staging
```

- この形式はトークン値がシェル履歴に残る。履歴へ残さない設定にするか、§3.1の`read -rs`を使う。
- 境界チェックとE2E後の再確認は行われない。実行前後に`bash scripts/check-staging-public-boundary.sh`を別途実行する(§2)。
- Service TokenはユーザーJWTではないため、`/api/health`は401(fail-closed)になるのが正常。スクリプトは401を「正しく拒否している」証跡として扱い、200のときだけDBプローブを検証する。
- 401でも画面・Canvasの描画は検証する。編集操作は行わない。
- トークン値はコマンド履歴・ログ・Issue・チャットへ残さない。テスト後はStaging Applicationのpolicyが `allow` + `kensan1969@gmail.com` のみに戻ったことを確認し、Service Tokenを削除する。

## 4. 受入での使い分け

| 目的 | コマンド | 期待 |
| --- | --- | --- |
| Stagingが候補commitを配信している | `E2E_EXPECT_COMMIT=<sha> npm run test:e2e:staging -- --local` | exit 0、`deployedCommit=<sha>` |
| 公開境界がAccessで保護されている | `bash scripts/check-staging-public-boundary.sh` | exit 0、Staging=302 |
| 公開URLの画面が配信されている | Service Token付き `npm run test:e2e:staging` | exit 0(または401を許容した成功) |
| 公開URL E2Eと境界をまとめて検証(推奨) | Service Token付き `bash scripts/run-staging-access-e2e.sh` | exit 0、境界→E2E→境界がすべて成功 |
| DB・env・systemd・監視 | `bash scripts/check-staging-readiness.sh` | exit 0 |
| 本番/MVPが不変 | `bash scripts/check-staging-public-boundary.sh` | 本番200、MVP302 |

## 5. 注意

- `--local` はAccessを経由しないため、Access境界の証明にはならない。境界は §2 で別途検証する。
- 公開URLのE2EはService Tokenの作成・削除を伴う。自動化する場合も、トークン発行・policy変更・削除はオーナーの手動とし、トークン値を標準出力・ログへ出さない実装(§3.1)を使う。
- 実行ログを共有するときも、トークン値が含まれていないことを確認する。シェルの履歴・一時ファイル・CIログにも残さない。
- Stagingのデータは使い捨てであり、本番・MVPへ昇格させない。
