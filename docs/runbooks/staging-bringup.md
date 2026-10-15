# Staging構築手順書（オーナー実施）

[ADR-0005](../adr/ADR-0005-staging-environment.md)で設計を確定したStaging環境を、本番ホスト(`kensan1969`)へ反映する手順です。Stagingは「本番と同一構成で、リリース候補・migration・デプロイ手順を本番反映前に検証する」ための常設環境で、MVP(機能の操作確認・評価)とは目的が異なります。

コード・設定ファイル・systemdユニット定義・CI・文書はPRでマージします。一方、次の項目は[GITHUB_POLICY.md](../../GITHUB_POLICY.md) §8および[AGENTS.md](../../AGENTS.md) §4の**Human Gate**として、コードのマージとは別に**オーナーのY/Nを得てから**実行します。

- Stagingホスト名のDNS route作成
- Access Application/Policyの新設
- `staging.env`・`staging-backup.env`の作成
- Staging用DB/ロールの作成
- systemdユニットの配置・enable

> [!IMPORTANT]
> 本手順書の作成時点で、**ホストへの反映は1つも実施していません**。DNS・Access・秘密情報・systemd配置・DBはいずれも未作成で、Stagingはまだ利用できません。各Human GateのY/Nを得た後に、上から順に実施してください。

対象サービスの固定値は次のとおりです。本書と[ローカルデプロイ運用メモ](../deployment-local.md)・[運用・復旧メモ](../operations.md)で同じ値を使います。

| 項目 | 値 |
| --- | --- |
| サービス | `mirai-web-cad-staging.service` |
| ポート | `18814` |
| ホスト名 | `mirai-web-cad-stg.mirai-dx-platform.com` |
| アプリDB | `mirai_web_cad_staging` |
| 復元用隔離DB | `mirai_web_cad_staging_recovery` |
| アプリenv | `~/.config/mirai-web-cad/staging.env` |
| バックアップenv | `~/.config/mirai-web-cad/staging-backup.env` |
| バックアップ先 | `/var/backups/mirai-web-cad/staging-postgres` |
| 認証モード | `AUTH_MODE=access` |
| healthスクリプト | `scripts/check-staging-health.sh` |

定期ジョブの初期値: バックアップ毎日03:50 JST、鮮度検査毎日06:45 JST、復元ドリル日曜04:50 JST、監視15分ごと。

## 1. コードで完了済み（PRでマージ）

次の項目はコード・設定として用意済みで、ホストへの反映操作は不要です。オーナーはここに挙げた資産を「配置・有効化する対象」として扱い、値を再定義しません。

- systemdユニット定義: `deploy/systemd/mirai-web-cad-staging.service`、`mirai-web-cad-staging-backup.service`/`.timer`、`mirai-web-cad-staging-backup-check.service`/`.timer`、`mirai-web-cad-staging-monitor.service`/`.timer`、`mirai-web-cad-staging-restore-drill.service`/`.timer`
- 監視スクリプト: `scripts/check-staging-health.sh`（ローカルAPI、接続DB名、公開URLのAccess境界を検査）
- デプロイスクリプト: `scripts/deploy-local.sh`を本番・MVP・Stagingの**3系統一括切替**へ拡張
- Cloudflare定義: `infra/cloudflare/`のStaging定義（変数化。`enable_management=false`は据え置き、import planが無差分になるまでapplyしない）
- CI: Staging構成の検査(`scripts/check-staging-config.sh`、CIジョブ「Staging Configuration」。ユニットの存在・必須ディレクティブ・`deploy-local.sh`の18814対応・DB名の一致・本番専用経路へ未配線を検査)
- 文書: ADR-0005、本書、[ローカルデプロイ運用メモ](../deployment-local.md)、[運用・復旧メモ](../operations.md)、README、`state.json`

`scripts/deploy-local.sh`は、本番・MVP・Stagingの3系統を一度の操作で切り替えます。ただしStagingのsystemdユニットが設置されていない間は、稼働中ツリーを変更しません（MVPと同じく、未設置の環境は対象外）。

## 2. Human Gateの全体像

Y/Nは各ステップの実行前に個別に取得します。前のステップが失敗した状態で次へ進まないでください。

| # | Human Gate | 主なリスク | ロールバック |
| --- | --- | --- | --- |
| 1 | DNS route作成 + Tunnel ingress追加 | 公開DNS変更 | DNSレコード削除、ingress行の削除 |
| 2 | Access Application/Policy新設 | 公開範囲の変更 | Access Application削除 |
| 3 | `staging.env`・`staging-backup.env`作成 | 秘密情報の追加 | envファイルの削除（秘密情報の削除） |
| 4 | Staging用DB/ロール作成・初期migration | DB作成 | `drop database`（不可逆削除） |
| 5 | systemdユニット配置・enable | 本番デプロイ手順の変更 | ユニットのdisable・削除 |
| 6 | 復元ドリルの初回実行 | なし（隔離DB内で完結） | なし |
| 7 | 公開URLのAccess境界確認 | なし | 1・2のロールバックに同じ |

> [!WARNING]
> 秘密値・資格情報・接続文字列は**Git・ログ・チャットへ一切出さないでください**。値の存在確認は`grep -o '^KEY='`のようにキー名だけを出力し、値は画面へ出しません（[AGENTS.md](../../AGENTS.md) §4、`state.json`のlearning参照）。

## 3. Human Gate 1: DNS route作成とTunnel ingress追加

既存Tunnel`mirai-web-cad`にStagingホスト名を追加します。新しいTunnelは作りません。

**コマンド**

```bash
cloudflared tunnel route dns mirai-web-cad mirai-web-cad-stg.mirai-dx-platform.com
```

続けて、Tunnel ingress設定（`~/.cloudflared/mirai-web-cad-config.yml`、リポジトリ外のホスト設定）へStagingのingress行を追加し、Cloudflare Tunnelを再読込します。ingressはホスト名とオリジンの対応を定義するもので、`http://127.0.0.1:18814`を指します。

```bash
# ingress行を追加した後
cloudflared tunnel ingress validate --config ~/.cloudflared/mirai-web-cad-config.yml
sudo systemctl restart mirai-web-cad-cloudflared.service
cloudflared tunnel info mirai-web-cad
```

**期待結果**

- `cloudflared tunnel route dns`がCNAMEレコードを作成する
- `cloudflared tunnel ingress validate`が成功する
- `cloudflared tunnel info mirai-web-cad`でコネクタ登録が維持されている
- この時点ではStagingサービスが未起動のため、公開URLはオリジン接続エラーになる（想定どおり。手順7で解消する）

**ロールバック**

- CloudflareダッシュボードまたはAPIで、`mirai-web-cad-stg.mirai-dx-platform.com`のCNAMEレコードを削除する
- `~/.cloudflared/mirai-web-cad-config.yml`からStagingのingress行を削除し、`sudo systemctl restart mirai-web-cad-cloudflared.service`

## 4. Human Gate 2: Access Application/Policy新設

Stagingホスト名の**ホスト全体**をCloudflare Accessで保護します。許可対象は`kensan1969@gmail.com`のみとし、bypass policyは作りません（本番の公開デモ用bypassを引き継がない）。

**コマンド**

Cloudflare Zero Trustダッシュボード（またはCloudflare API）で次を作成します。

1. Access Application: 対象ホスト名`mirai-web-cad-stg.mirai-dx-platform.com`、サイト全体を保護
2. Policy: `allow`、`Include`に`Emails = kensan1969@gmail.com`のみ。`bypass`/`service_auth`は追加しない
3. 作成後のApplication `AUD`タグ（audience）を控える。これは手順5の`staging.env`の`CF_ACCESS_AUD`に使う

```bash
# 設定反映の確認（未認証アクセスはAccessログインへ302）
curl -sI https://mirai-web-cad-stg.mirai-dx-platform.com/ | head -1
```

**期待結果**

- 未認証アクセスが302でAccessログインへリダイレクトされる
- `kensan1969@gmail.com`だけがログインできる
- オリジン（サービス）が未起動でも、エッジ層でAccessが先に働く

**ロールバック**

- Access ApplicationとPolicyを削除する
- 削除するとStagingホスト名はAccess保護外になる。公開オリジンを残したままにする場合は、先に手順1のDNS route/ingressを戻すか、オリジンサービスを停止してから削除する

## 5. Human Gate 3: envファイル作成（秘密情報）

アプリ用とバックアップ用の2ファイルを、所有者だけが読める`0600`で作成します。値は本番・MVPと同じ生成・保管方針に従い、Git・ログ・チャットへ出しません。ここでは**変数名のみ**を示し、実際の値は書きません。

**コマンド**

```bash
install -m 0600 /dev/null ~/.config/mirai-web-cad/staging.env
install -m 0600 /dev/null ~/.config/mirai-web-cad/staging-backup.env
```

`staging.env`に設定する変数名（MVPの`mvp.env`と同じ必須項目を持つ）:

```dotenv
DATABASE_URL=postgresql://mirai_web_cad_app:<password>@127.0.0.1:5432/mirai_web_cad_staging
APP_ENV=<既存環境と同じ規則の値>
AUTH_MODE=access
CF_ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com
CF_ACCESS_AUD=<手順2で控えたStaging ApplicationのAUDタグ>
ACCESS_ROLE_MAP={"kensan1969@gmail.com":"cad_admin"}
CORS_ORIGIN=https://mirai-web-cad-stg.mirai-dx-platform.com
```

`ACCESS_ROLE_MAP`の値は`src/cad-core.js`の`ROLE_POLICIES`に存在するロール名（`viewer`/`drafter`/`reviewer`/`approver`/`cad_admin`）のみを使ってください。`scripts/serve-production.mjs`は起動時にこれを検証し、不正な値があれば起動を拒否します。`DATABASE_URL`のDB名は必ず`mirai_web_cad_staging`にします。本番・MVPのDBを指してはいけません。

`staging-backup.env`に設定する変数名（MVPの`mvp-backup.env`と同じ2変数）:

```dotenv
DATABASE_URL=postgresql://mirai_web_cad_backup:<password>@127.0.0.1:5432/mirai_web_cad_staging
RESTORE_DATABASE_URL=postgresql://mirai_web_cad_backup:<password>@127.0.0.1:5432/mirai_web_cad_staging_recovery
```

`DATABASE_URL`は読取り専用backupロールでStagingアプリDBを参照し、`RESTORE_DATABASE_URL`は同じロールが所有する隔離DBだけを参照します。アプリDBへの書込み権限は付与しません。

**期待結果**

- 両ファイルが`0600`であること: `stat -c '%a %n' ~/.config/mirai-web-cad/staging.env ~/.config/mirai-web-cad/staging-backup.env`
- キー名の存在確認（値は出力しない）: `grep -o '^[A-Z_]*=' ~/.config/mirai-web-cad/staging.env`

> [!WARNING]
> envファイルを**シェルで`source`しないでください**。bashは代入値の引用符を除去するため、`ACCESS_ROLE_MAP`等のJSON値が壊れ、`serve-production.mjs`が「ACCESS_ROLE_MAP is not valid JSON」で起動を拒否します。必要な1変数だけを次のように取り出します。
>
> ```bash
> DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' ~/.config/mirai-web-cad/staging.env)"
> ```

**ロールバック**

- 両ファイルを`shred -u`等で削除する（秘密情報の削除はHuman Gate）
- 削除後、Stagingサービスが起動していれば停止する（`sudo systemctl stop mirai-web-cad-staging.service`）

## 6. Human Gate 4: DB/ロール作成と初期migration

Staging専用のDBを作成します。アプリ用ロール`mirai_web_cad_app`とbackupロール`mirai_web_cad_backup`は本番・MVPで既存のものを使い、新しく作りません。

**コマンド**

```bash
# アプリDB（所有者: 既存のアプリ用ロール）
sudo -u postgres psql -c "create database mirai_web_cad_staging owner mirai_web_cad_app"
```

初回だけ、PostgreSQL管理者がbackupロールへStaging DBの読取り権限を付け、隔離DBを作成します。MVPのSQLと同じ形で、DB名だけをStagingへ置き換えます。

```sql
grant connect on database mirai_web_cad_staging to mirai_web_cad_backup;
\connect mirai_web_cad_staging
grant usage on schema public to mirai_web_cad_backup;
grant select on all tables in schema public to mirai_web_cad_backup;
alter default privileges for role mirai_web_cad_app in schema public
  grant select on tables to mirai_web_cad_backup;
create database mirai_web_cad_staging_recovery owner mirai_web_cad_backup;
```

続けて初期migrationを適用します。Staging DBは使い捨てデータのため`db:verify`（migration + `seeds/demo.sql`）で初期化してよいですが、**本番DB・MVP DBへは実行しないでください**。

```bash
DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' ~/.config/mirai-web-cad/staging.env)" npm run db:verify
```

**期待結果**

- `mirai_web_cad_staging`と`mirai_web_cad_staging_recovery`が存在する
- backupロールがStaging DBの`SELECT`のみを持ち、書込み権限を持たない
- `db:verify`が成功し、続けて`db:check`が成功する
  - `DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' ~/.config/mirai-web-cad/staging.env)" npm run db:check`

**ロールバック**

- 次の削除は**不可逆な破壊的操作のため、実施前にY/Nが必要**です。
  ```sql
  drop database mirai_web_cad_staging_recovery;
  drop database mirai_web_cad_staging;
  ```
- ロールのgrant（`grant connect`等）はDB削除で実質不要になる。個別に戻す場合は`revoke`する

## 7. Human Gate 5: systemdユニットの配置・enable

ユニット定義を`/etc/systemd/system/`へ配置し、サービスとタイマーを有効化します。失敗通知は既存の`mirai-web-cad-notify-failure@.service`（H-3で導入済み）へ`OnFailure=`で接続します。

**コマンド**

```bash
sudo install -o root -g root -m 0644 \
  deploy/systemd/mirai-web-cad-staging.service \
  deploy/systemd/mirai-web-cad-staging-backup.service \
  deploy/systemd/mirai-web-cad-staging-backup.timer \
  deploy/systemd/mirai-web-cad-staging-backup-check.service \
  deploy/systemd/mirai-web-cad-staging-backup-check.timer \
  deploy/systemd/mirai-web-cad-staging-monitor.service \
  deploy/systemd/mirai-web-cad-staging-monitor.timer \
  deploy/systemd/mirai-web-cad-staging-restore-drill.service \
  deploy/systemd/mirai-web-cad-staging-restore-drill.timer \
  /etc/systemd/system/
sudo systemctl daemon-reload

sudo systemctl enable --now mirai-web-cad-staging.service
sudo systemctl enable --now mirai-web-cad-staging-backup.timer mirai-web-cad-staging-backup-check.timer
sudo systemctl enable --now mirai-web-cad-staging-monitor.timer
sudo systemctl enable --now mirai-web-cad-staging-restore-drill.timer
```

**期待結果**

- `systemctl status mirai-web-cad-staging.service`が`active`、`journalctl -u mirai-web-cad-staging.service -n 20`にエラーがない
- `curl -fsS http://127.0.0.1:18814/api/health`が`ok: true`、`db.mode: connected`、接続DB名が`mirai_web_cad_staging`、`deploy.commit`が配信中のcommitと一致
- 4タイマーが`enabled`/`active (waiting)`である

**ロールバック**

```bash
sudo systemctl disable --now \
  mirai-web-cad-staging-monitor.timer \
  mirai-web-cad-staging-restore-drill.timer \
  mirai-web-cad-staging-backup-check.timer \
  mirai-web-cad-staging-backup.timer
sudo systemctl disable --now mirai-web-cad-staging.service
sudo rm /etc/systemd/system/mirai-web-cad-staging*.service /etc/systemd/system/mirai-web-cad-staging*.timer
sudo systemctl daemon-reload
```

## 8. Human Gate 6: 復元ドリルの初回実行

週次ドリルが動く前提を整えるため、初回だけバックアップと復元ドリルを手動実行します。

**コマンド**

```bash
sudo systemctl start mirai-web-cad-staging-backup.service
journalctl -u mirai-web-cad-staging-backup.service -n 20

sudo systemctl start mirai-web-cad-staging-restore-drill.service
journalctl -u mirai-web-cad-staging-restore-drill.service -n 20
```

**期待結果**

- `/var/backups/mirai-web-cad/staging-postgres/`に最新dumpが作られる
- 隔離DB`mirai_web_cad_staging_recovery`へ復元され、行数・最新版・backup manifestとの内容一致（JSONB型を含む）が検査される
- 復元スクリプトは成功・失敗にかかわらず終了時に隔離DBから復元データを消去する
- 完了基準は「週次ドリルが成功し続けること」。設定が存在するだけではPASSとしない

**ロールバック**

- なし。復元ドリルは隔離DB内で完結し、本番・MVPへ影響しない

## 9. Human Gate 7: 公開URLの検証

**コマンド**

```bash
# 未認証アクセスはAccessログインへ302
curl -sI https://mirai-web-cad-stg.mirai-dx-platform.com/ | head -1

# 15分ごとの監視を1回手動実行
sudo systemctl start mirai-web-cad-staging-monitor.service
journalctl -u mirai-web-cad-staging-monitor.service -n 20
```

**期待結果**

- 公開URLが未認証で302（Accessログイン）を返す
- 監視がローカルAPI・接続DB名・公開URLのAccess境界を検査して成功する
- 自動テスト用のAccess Service Tokenを使う場合、**テスト時だけ**作成し、テスト直後にpolicyとtokenの両方を削除する。通常利用のAccess policyへService Tokenを残してはいけない

**ロールバック**

- Human Gate 1・2のロールバックに同じ（DNS route/ingress削除、Access Application削除）

## 10. 検証チェックリスト

すべて満たした場合にのみ「Staging構築完了」とします。

- [ ] ローカルhealth: `curl -fsS http://127.0.0.1:18814/api/health`が`ok: true`、`db.mode: connected`、接続DB名`mirai_web_cad_staging`、`deploy.commit`が配信中のcommitと一致
- [ ] DB名: `staging.env`の`DATABASE_URL`のDB名が`mirai_web_cad_staging`、`staging-backup.env`の`RESTORE_DATABASE_URL`のDB名が`mirai_web_cad_staging_recovery`
- [ ] `npm run db:check`がStaging envで成功する
- [ ] 公開URL: `https://mirai-web-cad-stg.mirai-dx-platform.com/`が未認証でAccessログインへ302。bypass policyが存在せず、許可は`kensan1969@gmail.com`のみ
- [ ] 本番・MVPへ影響なし: `curl -fsS http://127.0.0.1:18812/api/health`と`http://127.0.0.1:18813/api/health`が変更なく成功し、本番・MVPの公開URLが従来どおり動作する
- [ ] タイマー: backup/backup-check/monitor/restore-drillの4タイマーが`enabled`かつ`active (waiting)`
- [ ] ジョブ初回成功: バックアップ・鮮度検査・復元ドリル・監視がそれぞれ1回以上成功している
- [ ] 記録: 各Human GateのY/N、実施時刻、結果をGitHub Issueへ記録した

## 11. 本番・MVPとの分離境界（再確認）

[ADR-0005](../adr/ADR-0005-staging-environment.md) §3の必須境界を、構築後にも確認します。

- Stagingは専用DB`mirai_web_cad_staging`のみを読み書きし、本番・MVPのDBへ接続しない（`db:check`の接続DB名とhealthで検証）
- 本番・MVPと別のsystemdユニット・別のenvファイル・別のバックアップディレクトリを持つ
- Stagingからの本番データ参照は行わない。実データ形状が必要な場合は`seeds/demo.sql`または合成データを使う
- 本番・MVPのDNS/Access/Ruleset設定を変更しない。Terraformの`enable_management`は`false`を維持し、import planが無差分になるまでapplyしない
- Stagingのバックアップ保持期間は14日。オフサイト転送（R2）の対象には当面含めない（本番・MVPのみ）
