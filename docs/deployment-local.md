# ローカルデプロイ運用メモ

2026-08-30に、本番の永続化先をNeon PostgreSQLからローカルPostgreSQL + Cloudflare Tunnelへ移行済み(Issue #22、ユーザー指示による。移行完了としてclose)。2026-09-05には、本番とデータを分離したMVP URLを同じTunnelへ追加した。この文書は日常運用手順、およびセットアップ手順の記録(再構築・障害復旧時の参考)を兼ねる。移行の背景・設計判断は`docs/operations.md`の該当節を参照。

## 構成

```
Cloudflare Tunnel(mirai-web-cad-cloudflared.service)
  → mirai-web-cad-mvp.mirai-dx-platform.com
  → http://127.0.0.1:18813 (mirai-web-cad-mvp.service)
  → ローカルPostgreSQL 16(127.0.0.1:5432, DB=mirai_web_cad_mvp)

Cloudflare Tunnel(mirai-web-cad-cloudflared.service)
  → mirai-web-cad.mirai-dx-platform.com
  → http://127.0.0.1:18812 (mirai-web-cad.service, scripts/serve-production.mjs)
  → ローカルPostgreSQL 16(127.0.0.1:5432, DB=mirai_web_cad, role=mirai_web_cad_app)
```

## 初回セットアップ

### MVP環境(2026-09-05追加)

- URL: `https://mirai-web-cad-mvp.mirai-dx-platform.com/`
- Access: ホスト全体をCloudflare IdPで保護し、`kensan1969@gmail.com`だけをallow
- Origin: `127.0.0.1:18813` (`mirai-web-cad-mvp.service`)
- DB: ローカルPostgreSQLの`mirai_web_cad_mvp`。本番DB`mirai_web_cad`とは分離
- 秘密値: `~/.config/mirai-web-cad/mvp.env` (mode 0600、Git管理外)
- Backup: `mirai-web-cad-mvp-backup.timer`が専用DBを`/var/backups/mirai-web-cad/mvp-postgres/`へ日次保存し、`mirai-web-cad-mvp-backup-check.timer`が鮮度を検査
- Restore drill: `mirai-web-cad-mvp-restore-drill.timer`が毎週、隔離DB`mirai_web_cad_mvp_recovery`へ最新dumpを復元してSHA-256、取得時刻、backup manifestとの内容一致、JSONB型を検査し、終了時に復元データを消去
- Monitor: `mirai-web-cad-mvp-monitor.timer`が15分ごとにローカルAPI、接続DB名、公開URLのAccess境界を検査

MVP用envは`production.env`と同じ必須項目を持つ。ただし`DATABASE_URL`のDB名、`CF_ACCESS_AUD`、`CORS_ORIGIN`をMVP専用値にし、`ACCESS_ROLE_MAP`は許可メール1件だけにする。Access Applicationはbypass policyを作らず、サイト全体へ適用する。

バックアップと復元ドリルは、アプリ用envとは分離した`~/.config/mirai-web-cad/mvp-backup.env`を使用する。ファイルは所有者だけが読める`0600`とし、次の2変数を必ず設定する。`DATABASE_URL`は読取り専用backupロールでMVP DBを参照し、`RESTORE_DATABASE_URL`は同じロールが所有する隔離DBだけを参照する。

```bash
install -m 0600 /dev/null ~/.config/mirai-web-cad/mvp-backup.env
```

```dotenv
DATABASE_URL=postgresql://mirai_web_cad_backup:<password>@127.0.0.1:5432/mirai_web_cad_mvp
RESTORE_DATABASE_URL=postgresql://mirai_web_cad_backup:<password>@127.0.0.1:5432/mirai_web_cad_mvp_recovery
```

初回だけ、PostgreSQL管理者がbackupロールへMVP DBの読取り権限を付け、隔離DBを作成する。アプリDBへの書込み権限は付与しない。

```sql
grant connect on database mirai_web_cad_mvp to mirai_web_cad_backup;
\connect mirai_web_cad_mvp
grant usage on schema public to mirai_web_cad_backup;
grant select on all tables in schema public to mirai_web_cad_backup;
alter default privileges for role mirai_web_cad_app in schema public
  grant select on tables to mirai_web_cad_backup;
create database mirai_web_cad_mvp_recovery owner mirai_web_cad_backup;
```

公開URLの自動確認には`npm run test:e2e:mvp`を使う。PC/スマホ表示、Canvas描画、health、接続DB名、新規図面、LINE作図、サーバー同期を確認する。自動テスト用Access Service Tokenはテスト時だけ作成し、テスト直後にpolicyとtokenの両方を削除する。通常利用のAccess policyへService Tokenを残してはいけない。

### 1. DB/ロール作成(実施済み)

```bash
sudo -u postgres psql -c "create role mirai_web_cad_app login password '<生成したパスワード>'"
sudo -u postgres psql -c "create database mirai_web_cad owner mirai_web_cad_app"
```

### 2. 接続情報ファイル(実施済み、mode 0600、リポジトリ外)

`~/.config/mirai-web-cad/production.env`:

```
DATABASE_URL=postgresql://mirai_web_cad_app:<password>@127.0.0.1:5432/mirai_web_cad
APP_ENV=production
AUTH_MODE=access
CF_ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com
CF_ACCESS_AUD=<Access Application作成後に取得するAUD tag>
ACCESS_ROLE_MAP={"user@example.com":"cad_admin"}
CORS_ORIGIN=https://mirai-web-cad.mirai-dx-platform.com
```

`ACCESS_ROLE_MAP`の値は`src/cad-core.js`の`ROLE_POLICIES`に存在するロール名(`viewer`/`drafter`/`reviewer`/`approver`/`cad_admin`)のみを使うこと。`scripts/serve-production.mjs`は起動時にこれを検証し、不正な値があれば起動を拒否する。

**外部LLM連携(任意)**: 以下を追加すると`POST /api/drawings/:id/agent-runs`がルールベースAIで拾えなかったプロンプトをOpenAI/Anthropicへフォールバックする。未設定の場合はルールベースAIのみで動作し続ける(fail-soft)。

```
AI_PROVIDER=openai            # または anthropic。未設定なら外部LLMは無効
OPENAI_API_KEY=sk-...         # AI_PROVIDER=openaiの場合必須
ANTHROPIC_API_KEY=sk-ant-...  # AI_PROVIDER=anthropicの場合必須
AI_MODEL=<現行モデルID>        # AI_PROVIDER設定時は必須。値は各社公式ドキュメントで実装時点の現行版を確認しコードにはハードコードしない
AI_RATE_LIMIT_PER_MINUTE=10   # 任意、既定10。actor単位でLLM呼び出しのみを制限(ルールベース応答は制限しない)
WRITE_RATE_LIMIT_PER_MINUTE=240 # 任意、既定240。actor単位で更新系API(POST/PATCH/PUT/DELETE)を制限。公開読み取りとOPTIONSは対象外
```

APIキーはサーバーの環境変数のみで管理され、ブラウザには一切保存・送信されない(`GET /api/ai/status`は有効状態・プロバイダ名・モデル名のみを返し、鍵自体は返さない)。設定後は各プロバイダの管理コンソールで「学習利用オフ」等のデータガバナンス設定を人手で確認すること(コード外の運用手順)。

**Entra IDグループ同期(任意、Issue #5)**: 利用者ログインはCloudflare AccessのCloudflare IdPを使い、案件単位RBACのためのグループ所属取得のみをMicrosoft Graph APIへ非対話式(client credentials flow)でアクセスして行う。`ACCESS_ROLE_MAP`(メール直接指定)による解決が優先され、そこに一致しない利用者だけがEntra IDグループ経由で解決される。以下を追加すると有効化される。未設定の場合は`ACCESS_ROLE_MAP`とその後の`ACCESS_DEFAULT_ROLE`(既定`viewer`)のみで動作し続ける(fail-soft)。

```
ENTRA_TENANT_ID=<Entra IDテナントID>
ENTRA_CLIENT_ID=<App RegistrationのApplication (client) ID>
ENTRA_CLIENT_SECRET=<Client secret値>
ENTRA_GROUP_ROLE_MAP={"<グループGUID>":"reviewer","<グループGUID>":"approver"}
ENTRA_GROUP_CACHE_TTL_MINUTES=15   # 任意、既定15分。グループ変更の反映遅延の上限になる
```

- `ENTRA_TENANT_ID`/`ENTRA_CLIENT_ID`/`ENTRA_CLIENT_SECRET`は1つでも設定すると3つとも必須(`scripts/serve-production.mjs`が起動時検証)
- `ENTRA_GROUP_ROLE_MAP`の値も`ACCESS_ROLE_MAP`と同じくROLE_POLICIESに存在するロール名のみ許容。1人が複数のマッピング済みグループへ所属する場合は`cad_admin > approver > reviewer > drafter > viewer`の順で最も権限の強いロールを採用する(`src/api-handler.js`の`ROLE_PRECEDENCE`)
- App Registration側でMicrosoft Graphの**Application permissions**(Delegatedではない)`GroupMember.Read.All`または`Group.Read.All`にテナント管理者のadmin consentが必要
- グループGUIDはEntra管理センターの「グループ」詳細画面の「オブジェクトID」で確認できる
- Client Secretには有効期限がある(登録時に選択。運用チームは2026-08-30時点で1年の期限を設定済み)。期限切れ前にEntra管理センターで再発行し、`production.env`を更新して`systemctl restart mirai-web-cad.service`すること。期限切れ後はEntra解決が失敗し続けるが、fail-softにより`ACCESS_ROLE_MAP`/`ACCESS_DEFAULT_ROLE`へ縮退するだけでサービス全体は停止しない
- Entra解決の失敗(タイムアウト・認証エラー・応答不正)はいずれもログへメールアドレスを出力せずfail-softで`ACCESS_DEFAULT_ROLE`(既定`viewer`)へ縮退する。過大な権限へは決して昇格しない
- グループ所属変更の反映には最大`ENTRA_GROUP_CACHE_TTL_MINUTES`分の遅延がある(インメモリキャッシュ、プロセス再起動で即時クリアされる)
- キャッシュが空(プロセス起動直後・TTL切れ直後)の状態で複数利用者が同時にアクセスすると、各リクエストが独立してMicrosoft Graphへ問い合わせるため(リクエスト合流は未実装)、Entra ID側が輻輳中の場合に一時的な負荷集中が起き得る。7名規模のIT/DX部門での利用スケールでは実害は小さいと判断し、本実装では対応していない。将来の利用者数拡大時は再検討する

### 3. Migration適用(初回セットアップ)

```bash
DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' ~/.config/mirai-web-cad/production.env)" npm run db:verify
```

> [!WARNING]
> 環境変数ファイルを**シェルで`source`しないでください**。bashは代入値の引用符を除去するため、`ACCESS_ROLE_MAP`等のJSON値が壊れます(実測: `{"kensan1969@gmail.com":"cad_admin"}` が `{kensan1969@gmail.com:cad_admin}` になり、`serve-production.mjs` が「ACCESS_ROLE_MAP is not valid JSON」で起動を拒否します)。systemdの`EnvironmentFile`は引用符を保持するため通常運用では問題ありません。手動で必要な変数を取り出す場合は、上記のように`sed`で**必要な1変数だけ**を抽出してください。

### 4. systemdユニット配置

```bash
sudo install -o root -g root -m 0644 \
  deploy/systemd/mirai-web-cad.service \
  deploy/systemd/mirai-web-cad-mvp.service \
  deploy/systemd/mirai-web-cad-mvp-backup.service \
  deploy/systemd/mirai-web-cad-mvp-backup.timer \
  deploy/systemd/mirai-web-cad-mvp-backup-check.service \
  deploy/systemd/mirai-web-cad-mvp-backup-check.timer \
  deploy/systemd/mirai-web-cad-mvp-monitor.service \
  deploy/systemd/mirai-web-cad-mvp-monitor.timer \
  deploy/systemd/mirai-web-cad-mvp-restore-drill.service \
  deploy/systemd/mirai-web-cad-mvp-restore-drill.timer \
  deploy/systemd/mirai-web-cad-cloudflared.service \
  deploy/systemd/mirai-web-cad-backup.service \
  deploy/systemd/mirai-web-cad-backup.timer \
  deploy/systemd/mirai-web-cad-backup-check.service \
  deploy/systemd/mirai-web-cad-backup-check.timer \
  deploy/systemd/mirai-web-cad-deploy-drift.service \
  deploy/systemd/mirai-web-cad-deploy-drift.timer \
  deploy/systemd/mirai-web-cad-restore-drill.service \
  deploy/systemd/mirai-web-cad-restore-drill.timer \
  /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mirai-web-cad.service
sudo systemctl enable --now mirai-web-cad-mvp.service
sudo systemctl enable --now mirai-web-cad-mvp-backup.timer mirai-web-cad-mvp-backup-check.timer
sudo systemctl enable --now mirai-web-cad-mvp-monitor.timer
sudo systemctl enable --now mirai-web-cad-mvp-restore-drill.timer
sudo systemctl enable --now mirai-web-cad-backup.timer mirai-web-cad-backup-check.timer
```

`mirai-web-cad-cloudflared.service`はCloudflare Tunnel作成後に有効化する(下記)。

`mirai-web-cad-deploy-drift.service`/`.timer`(30分間隔)も同じ要領で配置・有効化する。稼働中のcommitがレビュー済み`origin/main`と乖離していないかを定期検査し、乖離時はユニットが失敗してjournalに理由を残す。詳細は[運用・復旧メモ](operations.md)の「デプロイ素性(稼働commit)と乖離検知」を参照。`mirai-web-cad-restore-drill.service`/`.timer`(週次)も同様に配置・有効化する(初回準備は「本番DBの復元ドリル」を参照)。この4ユニットは上の配置一覧・有効化一覧にも含めてある。

### 5. Cloudflare Tunnel作成

```bash
cloudflared tunnel list | grep -i mirai-web-cad   # 名前衝突がないことを確認
cloudflared tunnel create mirai-web-cad            # UUIDとcredentials JSONパスが出力される
cp deploy/cloudflared/mirai-web-cad-config.example.yml ~/.cloudflared/mirai-web-cad-config.yml
# ~/.cloudflared/mirai-web-cad-config.yml のtunnel/credentials-fileをUUIDで置換
cloudflared tunnel ingress validate --config ~/.cloudflared/mirai-web-cad-config.yml
sudo systemctl enable --now mirai-web-cad-cloudflared.service
cloudflared tunnel info mirai-web-cad               # コネクタ登録を確認(この時点でDNS未設定・公開影響ゼロ)
```

**DNS route作成(`cloudflared tunnel route dns mirai-web-cad mirai-web-cad.mirai-dx-platform.com`)は高リスク操作。** 既存のCloudflare Pages Custom Domain設定を人間が解除し、DNSレコードの消失を確認した後に、改めてY/N確認のうえ実行すること。詳細は`docs/operations.md`のリリース判定基準を参照。

## 日常運用

### Cloudflare設定のコード管理

Tunnel登録、本番/MVPのDNS、MVP Access Applicationは`infra/cloudflare/`でTerraform化した。稼働中資源の重複作成を防ぐため、既存IDの棚卸しと入力が完了するまで`enable_management=false`を維持する。その後に`true`へ変更してimport planを作成し、差分レビューが完了するまでapplyしない。詳細は[Cloudflare Terraform](../infra/cloudflare/README.md)と[Access変更Runbook](runbooks/cloudflare-access-change.md)を参照。

### デプロイ(手動)

環境変数ファイルを一括で`source`すると、JSON値(`ACCESS_ROLE_MAP`等)の引用符がシェルにより除去され、手動起動時に「ACCESS_ROLE_MAP is not valid JSON」で失敗する。必要な変数だけを`sed`で取り出す(「3. Migration適用」の注意書き参照)。

```bash
DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' ~/.config/mirai-web-cad/production.env)" bash scripts/deploy-local.sh
```

2026-09-25〜(独立レビュー H-1)、次の順で行う。本番とMVPは作業ツリーの`dist/`と`node_modules/`をそのまま使うため、稼働中のツリーでは依存導入もbuildもしない。

1. 対象commit(origin/main)を`.releases/<sha>/`へ`git archive`で書き出し、そこで`npm ci --ignore-scripts`と`npm run build`(`BUILD_COMMIT`を`dist/build-info.json`へ記録)を行う
2. 本番DB・MVP DBへ読み取り専用の`db:check`を実行する。MVPは`mirai-web-cad-mvp.service`が設置されている場合だけ対象で、接続先は、ユニットの`EnvironmentFile=`(通常`~/.config/mirai-web-cad/mvp.env`)の`DATABASE_URL`(外側の引用符はsystemdと同じく外す)で、サービスが実際に使うDBと同じものを検証する。対象commitが既に配信中の再デプロイでは、配信中のリリースを消さずに再利用する。**ここまでに失敗した場合、稼働中のツリーは何も変わらない**
3. 作業ツリーをfast-forwardし、`dist`と`node_modules`を`.releases/<sha>/`へのsymlinkとして一度の操作(rename)で切り替える。初回だけ、実体のディレクトリを`.releases/legacy-<直前のcommit>/`へ退避する
4. 本番とMVPを再起動し、両方の`/api/health`で`deploy.commit`(サーバーのコード)と`deploy.distCommit`(配信物のbuild元)が対象commitと一致することを確認する
5. 手順3以降で失敗した場合は、作業ツリー・symlinkを直前の状態へ戻し、両サービスを再起動して直前のcommitで一致することを確認する(ロールバック中は途中の失敗で止めず、各手順の結果を出力する。`build-info.json`を持たない以前の配信物へ戻した場合は、以前のサーバーが`distCommit`を返さないため、healthと稼働commitだけで確認する)

`.releases/`には直近3件のリリース(と直前の向き先)を残す。`npm run deploy:drift -- --url http://127.0.0.1:18812`は、稼働commitと配信物のbuild元の不一致も乖離として報告する。

対象commitでこのスクリプト自体が更新される場合は、何も変更しないうちに新しい手順で1回だけ自動的に再実行する(ロールバック先は更新前のコミットを引き継ぐ。新しい手順に構文エラーがあれば何も変えずに中止)。bashは起動時点のスクリプトを実行し続けるため、以前は手順の変更が次回デプロイまで反映されなかった(2026-09-25、`db:check`切替の初回デプロイで旧手順の`db:verify`が走った。DB指紋の比較でデータ差異なしを確認済み)。

DB検証は読み取り専用の`db:check`で、本番DBへ書き込まない(2026-09-25〜、改善台帳P0-74)。以前の`db:verify`はmigrationと`seeds/demo.sql`を毎デプロイで適用し、デモ行の投入、`dwg_demo_001`の`name`上書きと`visibility='public'`強制、監査トリガのdrop→再作成を本番DBへ起こしていた。

#### Migrationを含むリリース

`db:check`はmigrationを適用しない。検証するのは、スクリプト内の`covered_migrations`に登録したmigration(現在0001〜0008)の適用後状態として明示的に列挙したもの(9テーブル、追加列3、検証済み(`convalidated`)のCHECK制約7、有効(`indisvalid`)な索引7、監査の追記専用トリガ3件と拒否動作、JSONB形状)に限られ、migrationの全作用を網羅するものではない。

新しいmigrationを追加するPRは、その適用後状態の検査を`scripts/check-database-state.sh`へ追加し、`covered_migrations`へ登録する。登録のない`migrations/*.sql`があると`db:check`とCI(`tests/deploy-script.test.js`)が失敗するため、検査を追加し忘れたリリースはデプロイ前に止まる。未適用のままデプロイした場合は`db:check`が欠落を列挙してexit 1となり、稼働中の作業ツリー・配信物を何も切り替えずに中止する。

**本番DBへ`db:verify`を実行してはならない**(全migrationに加えて`seeds/demo.sql`を適用し、デモ行の投入・`dwg_demo_001`の上書き・監査トリガの再作成が起きる)。次の順で、対象migrationだけを適用してからデプロイする。

1. 事前バックアップを取得する(「バックアップ」節)
2. 検証用DB(本番の復元コピー等)で対象migrationを適用し、続けて`db:check`が成功することを確認する
3. 本番DBへ**対象migrationファイルだけ**を単一トランザクションで適用する。監査ログの所有権分離後は所有者ロールまたは管理者の接続文字列で実行する([運用・復旧メモ](operations.md)参照)

   ```bash
   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f migrations/0009_example.sql
   ```

   `MIGRATION_DATABASE_URL`は所有者ロール等の接続文字列(`production.env`とは別に安全に管理し、リポジトリへ置かない)。
4. 本番DB(`production.env`)とMVP DB(`mvp.env`)の両方で`db:check`が成功することを確認してから`scripts/deploy-local.sh`を実行する(`DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' ~/.config/mirai-web-cad/<env>)" npm run db:check`)

デプロイ後は必ず**稼働commitの素性確認**を行う。

```bash
npm run deploy:drift
```

`verified`(終了コード0)であれば、本番はレビュー済みの`origin/main`と同一である。`ahead`または`dirty`(終了コード1)の場合は未レビューのコードが稼働しているため、業務利用を止めて原因を解消する(2026-09-18のIssue #98と同じ事故)。詳細は[運用・復旧メモ](operations.md)の「デプロイ素性(稼働commit)と乖離検知」を参照。

### バックアップ

`mirai-web-cad-backup.timer`が毎日03:10(JST、`RandomizedDelaySec=30min`)に`scripts/backup-local.sh`を実行し、`/var/backups/mirai-web-cad/postgres/`へdumpを保存する(保持14日)。`mirai-web-cad-backup-check.timer`が毎日06:00に鮮度(36時間以内・0バイト超)を検証する。

MVPは本番と別に、`mirai-web-cad-mvp-backup.timer`が毎日03:40(JST、最大20分のランダム遅延)に`/var/backups/mirai-web-cad/mvp-postgres/`へ保存する。鮮度検査は毎日06:30、隔離DBへの復元ドリルは毎週日曜04:30、公開境界を含むhealth検査は15分ごとに行う。復元スクリプトは接続先DB名が`mirai_web_cad_mvp_recovery`と完全一致し、かつ元DBと異なる場合だけ初期化を許可する。復元した図面データは成功・失敗にかかわらず終了時に隔離DBから消去する。手動確認は次のとおり。

```bash
sudo systemctl start mirai-web-cad-mvp-backup.service
sudo systemctl start mirai-web-cad-mvp-backup-check.service
sudo systemctl start mirai-web-cad-mvp-monitor.service
sudo systemctl start mirai-web-cad-mvp-restore-drill.service
```

手動実行:

```bash
sudo systemctl start mirai-web-cad-backup.service
sudo systemctl start mirai-web-cad-backup-check.service
journalctl -u mirai-web-cad-backup.service -n 20
```

### オフサイト転送と失敗通知(独立レビュー H-3)

同じホストのディスクだけでは、ホストの故障・盗難・誤削除で本番DBとバックアップを同時に失う。`mirai-web-cad-offsite-backup.timer`が毎日05:00(JST、最大10分のランダム遅延)に`scripts/offsite-backup.sh`を実行し、本番とMVPの最新dump(manifestを含む)を**ageで暗号化してから**Cloudflare R2の`mirai-web-cad-backups`へ転送する(`production/`・`mvp/`)。転送後はリモートのサイズを照合し、最新dumpが36時間より古い場合は転送せずに失敗する。決定事項と初期値は[外部入力・確定待ち台帳](external-input-status.md)§5。

バックアップ・鮮度検査・復元ドリル・オフサイト転送の各ユニットは、失敗すると`OnFailure=`で`mirai-web-cad-notify-failure@<ユニット名>.service`を起動する。これはBot名義で「[運用通知] <ユニット名> が失敗しました」のIssueを作り、未解決の同じIssueがあればコメントを追記する(本文はユニット名・時刻・systemdの結果だけで、ログは載せない)。Issueは自動では閉じないため、原因を解消して再実行が成功したら**手動で**閉じる(閉じた後に再び失敗すると、新しいIssueが作られる)。

初回セットアップ(本番のsecret追加とsystemd設定の変更を含むため、オーナーのY/N後に行う):

0. 転送処理は `age`・`rclone`・`jq` を使う(このホストには導入済み)。
1. R2 bucketとライフサイクルルールを作る: `wrangler r2 bucket create mirai-web-cad-backups`、`wrangler r2 bucket lifecycle add mirai-web-cad-backups expire-90d --expire-days 90`
2. Cloudflareダッシュボードで、このbucketだけを対象にしたR2 API token(Object Read & Write)を作る。
3. `~/.config/mirai-web-cad/offsite.env`(mode 0600)へ次の変数を書く。値はGit・ログ・チャットへ出さない。
   ```
   RCLONE_CONFIG_R2_TYPE=s3
   RCLONE_CONFIG_R2_PROVIDER=Cloudflare
   RCLONE_CONFIG_R2_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
   RCLONE_CONFIG_R2_ACCESS_KEY_ID=<token のアクセスキーID>
   RCLONE_CONFIG_R2_SECRET_ACCESS_KEY=<token のシークレット>
   RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true
   ```
4. age鍵を作り、**復号鍵をホストから外す**: `age-keygen -o /tmp/mirai-offsite.key`の後、`age-keygen -y /tmp/mirai-offsite.key > ~/.config/mirai-web-cad/offsite-age-recipients.txt`で公開鍵を置き、`/tmp/mirai-offsite.key`はオーナーがパスワードマネージャー等へ移して`shred -u`で消す。受信者ファイルに復号鍵(`AGE-SECRET-KEY`)が含まれていると転送は失敗する。
5. ユニットを配置する(「4. systemdユニット配置」と同じ手順): `mirai-web-cad-offsite-backup.service`・`.timer`、`mirai-web-cad-notify-failure@.service`、および`OnFailure=`を加えた既存のバックアップ・鮮度検査・復元ドリルのユニット。`sudo systemctl daemon-reload`の後、`sudo systemctl enable --now mirai-web-cad-offsite-backup.timer`。
6. 試験: `sudo systemctl start mirai-web-cad-offsite-backup.service`が成功し、R2に両方のファイルがあること。`sudo systemctl start mirai-web-cad-notify-failure@mirai-web-cad-offsite-backup.service.service`で通知Issueが作られること(確認後に閉じる)。

オフサイトからの復元(隔離DBへ):

```bash
umask 077                                                             # 平文を他ユーザーから読めないようにする
work="$(mktemp -d)"                                                   # 展開は必ず専用の空ディレクトリで行う
trap 'rm -rf "$work"' EXIT                                           # 終了時(失敗時も)に平文のdumpを消す
rclone copyto r2:mirai-web-cad-backups/production/<name>.dump.tar.age "$work/in.tar.age"   # offsite.env の変数を渡して実行
age -d -i <オーナーが保管する復号鍵> "$work/in.tar.age" > "$work/in.tar"
tar -tf "$work/in.tar"                                                # <name>.dump と <name>.dump.manifest の2件だけであることを確認
tar -x --no-same-owner -C "$work" -f "$work/in.tar"
RESTORE_DATABASE_URL=<隔離DB> BACKUP_FILE="$work/<name>.dump" ALLOW_DATABASE_RESTORE=yes MAX_BACKUP_AGE_HOURS=<経過時間> \
  bash scripts/restore-database.sh
```

復号した平文(`in.tar`と展開したdump)は作業ディレクトリにだけ置き、復元が終わったらシェルを閉じて(`trap`で)消す。ageの暗号化は機密性を守るが、作成元は証明しない(公開鍵を知る者は誰でも暗号化できる)。R2への書込権限は転送用tokenだけに限り、そのtokenを他の用途・主体と共有しない。展開前に中身の一覧を確かめ、作業ディレクトリ以外へは展開しない。

### 本番DBの復元ドリル(初回セットアップが必要)

MVPは隔離DBへの復元ドリルを週次で実行しているが、**本番DBには同等の自動ドリルが無い**(2026-09-18時点)。`deploy/systemd/mirai-web-cad-restore-drill.service`と`.timer`(日曜04:10 JST)を追加したので、初回のみ次の準備を行えば以降は自動化される。

1. 復元専用の隔離DB`mirai_web_cad_recovery`を作成する。**2026-09-18の実測では、本番の接続ロールにCREATEDB権限が無く`create database`が`permission denied to create database`で失敗した。** DB管理者ロールでの作成が必要(実施者: DB管理者)。
2. `~/.config/mirai-web-cad/backup.env`へ`RESTORE_DATABASE_URL`(手順1の隔離DBを指す。本番DBと同一にしてはならない)を追加する。
3. `mirai-web-cad-restore-drill.service`と`.timer`を配置して有効化する。配置手順は「4. systemdユニット配置」と同じ。

`scripts/restore-drill-local.sh`は復元先DB名が`EXPECTED_RESTORE_DATABASE`と完全一致し、かつ元DBと異なる場合のみ初期化を許可する。復元したデータは成功・失敗にかかわらず終了時に隔離DBから消去される。実行結果は`journalctl -u mirai-web-cad-restore-drill.service`で確認する。

完了基準は「週次ドリルが成功し続けること」であり、設定が存在するだけではPASSとしない。復元できた行数・最新版がバックアップ時点と一致することまで確認する。

### ログ確認

```bash
journalctl -u mirai-web-cad.service -f
journalctl -u mirai-web-cad-cloudflared.service -f
```

`scripts/serve-production.mjs`は1行1 JSONの構造化ログをstdoutへ出力する(journaldが収集)。接続文字列・JWT・Cookieはログに出力しない設計。

### ロールバック

オーナー不在時(承認必須のためmainを戻せない場合)は[オーナー不在時のロールバック](runbooks/owner-absence-rollback.md)に従う。

`dist`と`node_modules`は`.releases/<sha>/`へのsymlinkのため、**稼働中のツリーで`npm ci`・`npm run build`を実行せず**、向き先を直前のリリースへ戻す(`.releases/`に無い場合だけ別ディレクトリでbuildしてから切り替える)。

```bash
prev=<直前の正常コミットSHA>
rel=.releases/$prev               # 初回切替時に退避した分は .releases/legacy-$prev
git checkout --quiet "$prev"
ln -sfn "$rel/node_modules" .swap-node_modules && mv -Tf .swap-node_modules node_modules
ln -sfn "$rel/dist" .swap-dist && mv -Tf .swap-dist dist
sudo systemctl restart mirai-web-cad.service mirai-web-cad-mvp.service
```

Cloudflare Tunnel/DNSに問題がある場合は、Cloudflare Pages Custom Domainを再アタッチする(Pagesプロジェクト・`functions/`・`wrangler.toml`はロールバック手段として当面残置している)。

## Cloudflareエッジキャッシュ(リポジトリ外設定、重要)

2026-08-30、UI更新を本番反映してもブラウザに変化が反映されない障害が発生した(P0-30参照)。原因はCloudflareのZone設定`Browser Cache TTL`が`14400`(4時間、固定値)になっており、`_headers`でオリジンが`/src/*`に`Cache-Control: no-cache, must-revalidate`を送っても、CloudflareがこれをZone設定のTTLで上書きしていたため。

対応として、`mirai-web-cad.mirai-dx-platform.com`ホスト名限定(他サブドメイン非対象)のCache Rule(`http_request_cache_settings`フェーズ、式`(http.host eq "mirai-web-cad.mirai-dx-platform.com" and starts_with(http.request.uri.path, "/src/"))`、アクション`set_cache_settings` / `cache: false`)をCloudflare API経由で追加し、`/src/*`をエッジキャッシュから完全にバイパスするよう設定した。**この設定はGitリポジトリ管理外(Cloudflareダッシュボード/APIのみ)であり、コードやCIから再現できない。** Zoneを作り直す場合や他ホスト名へ切り替える場合は、このCache Ruleを再作成すること。

確認方法:

```bash
curl -sI https://mirai-web-cad.mirai-dx-platform.com/src/app.js | grep -i "cache-control\|cf-cache-status"
# cache-control: no-cache, must-revalidate
# cf-cache-status: DYNAMIC (bypassされていることを示す。HITが出たら要調査)
```

デプロイ後に古いUIが表示される場合の緊急対応(Cache Ruleが機能していない・別途キャッシュ層が挟まった等の異常時のみ):

```bash
# Cloudflare API経由でキャッシュを強制パージ(mcp__cloudflare-api__executeまたはdashboardから)
# 対象: https://mirai-web-cad.mirai-dx-platform.com/ 、/src/app.js 、/src/styles.css 等
```

## 既知の制約

- 本番サービスがこのホスト(kensan1969)の稼働に依存する。ホスト停止・ネットワーク断で本番が停止する
- `mirai-web-cad.service`のsystemdユニットは`IPAddressDeny=any`を採用していない(Cloudflare Access JWKS取得の外向きHTTPSに必要なため)。インバウンド制限は`127.0.0.1`バインドと`RestrictAddressFamilies`で担保している
- CI(GitHub Actions)からはこのホストへ直接デプロイできないため、デプロイは`scripts/deploy-local.sh`の手動実行に依存する。self-hosted runner化は将来の別Issueとする
- バックアップのオフサイト転送(R2等)は未実施。保存先・暗号鍵・保持期間・費用・復元責任者の合意が別途必要
