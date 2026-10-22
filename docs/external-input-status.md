# 外部入力・確定待ち台帳

更新日: 2026-10-23

コードだけでは確定できない運用情報を、推測値で埋めないための台帳です。秘密値、個人の電話番号、実案件名、図面本体はGitへ保存しません。

## 1. Cloudflare Terraform移管

2026-10-16に、オーナーがCloudflare自動化(CTO)をY委譲しました。Web-CAD自身の資源(account・zone・Tunnel・本番/MVP/StagingのDNSとAccess)のread-only棚卸しは完了し、実IDを下表と`terraform.tfvars`(Git管理外、ローカル作成)へ記録しました。共通基盤側を含む一般的なimport/applyは引き続き未実施です。移行設計と手順は[Cloudflare Terraform手順](../infra/cloudflare/README.md)を参照してください。

| 確認項目 | 2026-10-16の実測 | 次に必要な入力 |
| --- | --- | --- |
| API token自体 | 対象account/zoneへのread-only棚卸しが成功(旧`403/code 10000`は解消) | なし |
| account / zone | account `4f1e888469df7e0b896bb4e211b12633`("Kensan1969@gmail.com's Account")、zone `mirai-dx-platform.com` = `e375e651e49a40801a305b89e297bff0` | なし(Web-CAD分は棚卸し完了) |
| Tunnel | `mirai-web-cad` = `f8c9fb57-fb21-4a24-b1be-f7dd5699badc`(status healthy) | なし |
| 本番DNS | CNAME `mirai-web-cad.mirai-dx-platform.com` = `8db3c9fbe3c71daf42e86786849b157a`(→`f8c9fb57-...cfargotunnel.com`、proxied) | なし |
| MVP DNS | CNAME `mirai-web-cad-mvp.mirai-dx-platform.com` = `7651bc461b8c7f7c7dc7d8789115539c`(→同じTunnel) | なし |
| Staging DNS | CNAME `mirai-web-cad-stg.mirai-dx-platform.com` = `1ce6a00f970aa00c1b152d33bebec2a8`(→同じTunnel、2026-10-16作成) | なし |
| MVP Access | Application `mirai-web-cad-mvp` = `434a047a-4277-4423-8b91-eed6d7989116`(aud `0c1341f13d88180c1ae1cfaca70b175891c1b72b373567c51cab8e29ba7ce64c`、session 24h)、allow policy `allow-kensan-only` = `44230a75-b7b2-454c-a454-35b2afd2a26e`(decision allow、include email `kensan1969@gmail.com`、precedence 1) | なし |
| Staging Access | Application `mirai-web-cad-stg` = `552bd803-cd79-4376-a388-278917378955`(aud `826bd6bc9d3b8e74214dbcd09376c0e803092e272db1d9ce4e8190d98d6302bf`、self_hosted、session 24h、http_only_cookie_attribute true、app_launcher_visible false、auto_redirect_to_identity false、options_preflight_bypass true)、allow policy `allow-kensan-only` = `6a4e42ff-8133-4225-ad80-d2ca654a8d75`(decision allow、include email `kensan1969@gmail.com`、precedence 1、exclude/requireなし) | なし |
| 本番専用Access(不変) | `mirai-web-cad-api` = `e0ac286f-412e-4ae4-a969-8befeb7a0b56`、`mirai-web-cad-demo-bypass` = `d03ef7a8-9507-410b-b43c-1a0387b49bde`、`mirai-web-cad-health-bypass` = `89e00d5d-40ff-4c57-98d3-65a2f215656e` | なし |
| `terraform.tfvars` | 未コミット(ローカル作成、Git管理外)。上記の実IDを記載 | 共通基盤側のID確認(必要な範囲で) |
| import/plan/apply | 未実施(`enable_management=false`を維持) | 上記IDを用いたimport-only planが無差分であること |

[Cloudflare Terraform手順](../infra/cloudflare/README.md)の順にread-only棚卸しを実施しました。Access policyにメール完全一致1件以外の差分、DNS/Tunnelの置換、`everyone`/`bypass`が出た場合はapplyしません。

## 2. Entra ID・運用体制

| 確認項目 | 2026-09-05の実測 | 確定担当が入力するもの |
| --- | --- | --- |
| App credentials | 本番環境に3変数があり、OAuth client credentials token取得はHTTP 200 | 秘密値はGitへ記録しない |
| 対象利用者 | Graphの`kensan1969@gmail.com/memberOf`はHTTP 404 `Request_ResourceNotFound` | 対象メールを当該tenantへ招待/登録するか、tenant内の実UPNを確定 |
| グループ対応 | `ENTRA_GROUP_ROLE_MAP`は未設定 | EntraグループGUIDと`viewer/drafter/reviewer/approver/cad_admin`の対応 |
| Client Secret | 所有者・有効期限は環境変数から判定不能 | 主担当、副担当、期限、90/30/7日前通知先、ローテーション記録の安全な参照ID |
| 障害当番 | 実名・連絡先は未確定 | 主当番、副当番、連絡手段、エスカレーション先 |
| SLA | 未確定 | 対応時間帯、初動目標、復旧目標、利用者への通知基準 |

実名や連絡先はアクセス制御された社内台帳で管理し、このGitには参照IDだけを記録します。値が届いたら[運用手順](operations.md)の当番表と本番環境を更新し、`viewer`を含む権限境界を実アカウントで確認します。

## 3. DXF 100図面・UAT 20名

| 項目 | 現在値 | 完了条件 |
| --- | ---: | --- |
| DXF台帳 | 0 / 100 | 利用許諾済み100件。回帰20件、最終UAT 80件 |
| ローカル実体 | 0 / 100 | `MIRAI_CORPUS_DIR`配下でSHA-256とASCII DXF形式を照合 |
| UAT参加者 | 0 / 20 | CAD実務利用者20名以上。役割と実施日を社内台帳で管理 |
| 実案件許容差 | 未確定 | 図形、座標、レイヤー、文字、寸法、線種、レイアウトごとに承認 |

図面ファイルと個人情報はGitへ置きません。図面受領後は[100図面台帳](compat-corpus/README.md)の`add`、`validate`、`verify-files`を使い、許諾が`granted`または`internal`のものだけを測定対象にします。

## 4. 基盤V3.6との整合

全体構成 V3.6・リポジトリ構成 V3.6・OS/アプリ選定 V3.5 とWeb-CADの差のうち、本リポジトリだけでは確定できない事項。詳細は[基盤連携の要件と現状](architecture/platform-integration.md)。

| 事項 | 状態(決定日／2026-10-23再確認) | 内容・次の入力 |
| --- | --- | --- |
| 1. system_id | **決定・登録済み** | `web-cad`(オーナー決定)。Core `registries/systems.yaml`への登録は**PR #27が2026-09-28にマージ済み(登録完了)**。**Platform-Infraの`systems.yaml`にも登録済み**(2026-10-12追加、`uses_core: false`、`production: false`。2026-10-23実測)。Coreの`registries/integration-baseline.json`ではWeb-CADは「宣言なし」(`declared_version: null`) |
| 2. AI Provider直接呼出し | **決定** | 案A(期限付きの暫定例外)、見直し期限2026-12-25([ADR-0003](adr/ADR-0003-ai-provider-direct-call-interim.md)承認済み)。移行条件はMCAH Model GatewayのWeb-CAD向け契約公開とsystem_id登録 |
| 3. マージ前の人間レビュー | **決定(2026-09-30改定)** | **中央ポリシー v2 の自動マージへ統一(A型を廃止)**: PR は `gh pr merge --auto --squash` で自動マージを予約する。マージの条件は Required Checks の全成功と merge conflict がないことだけとし、人間の Y/N・選択・Approve を待たない。`--admin` による迂回は禁止する。Release・本番デプロイ・秘密情報の変更・不可逆な削除は、コードのマージとは別に Human Gate とする。（正本: 中央ポリシー `GITHUB_POLICY.md` v2） 以下は2026-09-25改定(A型)の記録:  Bot名義のPRにオーナーがGitHub上でApproveしてからマージ(承認1件+CODEOWNER、最後のpush後の承認、スレッド解決を必須)。Botは2人目の代わりにしない。**2人目の承認者は2026-10以降に決定**(オーナー判断)。基盤方針の通常2名・重要3名を満たしていないリスクを、下記の補完策を前提に受け入れる。**見直し期限 2026-10-31**。先送りを終える契機: 実案件図面の取扱い開始、オーナー以外の利用者への提供開始、見直し期限の到来のいずれか |
| 4. CODEOWNERSのTeam | **決定(2026-09-30改定)** | CODEOWNERはレビュー依頼先とし、承認は必須でない(2026-09-25〜09-30はA型のため必須化していた)。当面は個人`@Kensan196948G`(管理者権限あり)をCODEOWNERとし、2人目の決定時にWrite以上のTeamへ移す |
| 5. 技術標準の適用範囲 | **決定** | アプリ構成は例外として維持、実行環境はNode 24へ2027-01-31まで、PostgreSQL 18へ2027-11-30までに更新([ADR-0004](adr/ADR-0004-tech-stack-vs-os-selection.md)承認済み) |
| 6. Core成果物の版 | **決定(2026-10-23再確認)** | 取り込むのはCoreのGitHub Releaseのみ(タグのvendoringはしない)。`SHA256SUMS`照合と`mhc verify`に加え、署名・来歴証明の検証を必須とする。**Latestは`v0.8.0`(2026-10-19公開)だが、署名・attestationは無い**(`/attestations/sha256:<digest>`が404、`registries/signing-keys.yaml`は`keys: []`、`release.yml`のbuildジョブは`if: false`。2026-10-23実測)。現時点は取り込まない。契機(証跡のMCIP送信、MCP公開)の時点で、必要な版の署名付きReleaseが無ければCoreへ作成を依頼する。手順は[基盤連携の要件と現状](architecture/platform-integration.md)§3 |
| 7. 案件ID・確定版・MCP | **決定(2026-10-23再確認)** | 第3段階。契機まで実装しない。案件ID: 独自採番を継続する。MCIPには案件の**読み取り**API(`GET /api/v1/projects`、`GET /api/v1/projects/:code`)はあるが、**全社共通の案件IDを発番・配布するAPIは未実装**(MCIP `docs/architecture/V3.2整合性評価.md:14`、2026-10-23実測)。公開時に外部ID列をadditive migrationで追加。確定版: CDEにはREST APIとMCPツールがあるが、**Web-CAD向けの承認済み版登録API・クライアント登録は無い**(2026-10-23実測)。CDEの受入API公開時に登録する。MCP: Coreの`mcp_server_id`は`null`、`registries/mcp-allowlist.yaml`に`web-cad`は無い。読み取り系ツールから、Coreで契約化→Allowlist登録→Entra App ID URI確定の順 |
| 8. Organization名 | **決定** | `mirai-construction-dx`に統一。原典(全体構成 V3.6)のHTMLは変更せず、Portfolioの未決事項表(PORT-BL-001 BL-06)に決定を記録(Portfolio PR #20) |
| 9. CDEの承認済み版登録API | **外部入力待ち(2026-10-23追加)** | Web-CADの確定版をCDEへ登録するAPI・認証・受入設計がCDE側に無い。CDEが(1)登録API、(2)Web-CAD用のクライアント認証、(3)版・承認・証跡の受入形式を提供するまで実装しない。詳細は[基盤連携の要件と現状](architecture/platform-integration.md)§6.4・§6.7 |
| 10. Staging E2E(Access Service Token) | **オーナー実施待ち(2026-10-23追加)** | Staging公開URLをAccess Service Tokenで認証するE2E(`npm run test:e2e:staging`)は、テスト時だけService Tokenを発行・削除する運用のためオーナーが実施する。トークン値はGit・ログ・チャットへ出さない。手順は[Staging構築手順書](runbooks/staging-bringup.md)§12 |

2026-10-23に読み取りで再確認: Core `origin/main`(`7e799e5`)の`registries/systems.yaml`に`web-cad`が登録済み。Latest Releaseは`v0.8.0`(2026-10-19公開)で、`contracts.tar.gz`のSHA256は`SHA256SUMS`と一致したが、署名・attestationは無く`signing-keys.yaml`は空のまま。Platform-Infraの`systems.yaml`にも`web-cad`が登録済み(2026-10-12、`uses_core: false`)。MCIPは対外案件ID APIが未実装、CDEはWeb-CAD向けの確定版登録APIが無い。Portfolioのweb-cadはPages本番のみでStaging未登録(別タスクでPORT-OPS-007として登録)。Staging環境([ADR-0005](adr/ADR-0005-staging-environment.md))は第3段階まで新しいリポジトリ間結合を追加しない。

### 1名承認体制の補完策(2026-09-25)

| 弱点 | 補完策 | 状態 |
| --- | --- | --- |
| 人の確認が1名 | CI必須チェック、CodeRabbitの自動レビュー、レビュースレッド解決の必須化 | 実施済み |
| 重要変更の見落とし | 高リスク操作の実行はマージとは別にオーナーのY/N([GITHUB_POLICY.md](../GITHUB_POLICY.md) §4) | 実施済み |
| オーナーアカウントの乗っ取り | GitHubの2段階認証(できればハードウェアキー/パスキー) | オーナーが確認 |
| Botトークンの漏えい | fine-grained PATの対象Repository・権限を最小化、期限2027-09-25 | 実施済み |
| オーナー不在で作業が止まる | [オーナー不在時のロールバック](runbooks/owner-absence-rollback.md)(mainを変更せず本番を直前のcommitへ戻す) | 整備済み |
| 誤った変更の混入 | 自動ロールバック付きデプロイ、DBの日次バックアップと復元ドリル | 実施済み |

## 5. バックアップのオフサイト転送と失敗通知(独立レビュー H-3)

2026-09-25にオーナーが保存先と通知先を選択した。残りは合理的な初期値として記録し、変更する場合はこの表を更新する。

| 項目 | 決定・初期値 | 状態 |
| --- | --- | --- |
| 保存先 | Cloudflare R2の専用bucket `mirai-web-cad-backups`(R2は同accountで有効化済み) | オーナー選択 |
| 費用 | dumpは1件約23KB(2026-09-25実測)。本番・MVP各1件/日×90日で約4MBとなり、R2の無料枠(10GB)内の想定 | 初期値 |
| 暗号化 | 転送前にageで暗号化。ホストには公開鍵のみ置き、復号鍵はオーナーがホスト外(パスワードマネージャー等)で保管 | 初期値 |
| 資格情報 | 対象bucket限定のR2 API token(Object Read & Write)。`~/.config/mirai-web-cad/offsite.env`(0600)。値はGitへ記録しない | 作成はオーナーのY/N後 |
| 保持期間 | R2のライフサイクルルールで90日後に削除(手元の保持は従来どおり14日) | 初期値 |
| 復元責任者 | オーナー(復号鍵の保有者)。2人目の承認者の決定時に副担当を見直す | 初期値 |
| 失敗通知 | systemdの`OnFailure=`で、このリポジトリにBot名義のIssueを作成(未解決の同じIssueがあれば追記)。オーナーにはGitHubの通知が届く | オーナー選択 |
| 通知の前提 | Botのfine-grained PATにIssues(Read and write)権限が必要。PATの期限(2027-09-25)を過ぎると通知も止まるため、更新時に通知の試験送信を行う | 設置時に確認 |

## 再開条件

- Cloudflare: Web-CAD自身の資源(account/zone/Tunnel/DNS/Access)のread-only棚卸しは完了(2026-10-16、オーナーY委譲)。実IDは`terraform.tfvars`(Git管理外)へ記録済み。共通基盤側を含む一般のimport-only plan/applyは引き続き未実施で、`enable_management=false`を維持する
- Entra: tenant内の対象UPN、グループGUID対応、Secret運用責任者、当番/SLA台帳の参照IDが確定
- Phase 0: 許諾済みDXFの保管場所とUAT参加者台帳の参照IDが確定
- 基盤整合: 8件とも決定済み(2026-09-25)。2026-10-23の再実測で、1(Platform-Infra台帳)は登録済み、6は署名付きRelease待ち、7はMCIP/CDEのAPI待ちであることを確認した。5の期限(Node 2027-01-31、PostgreSQL 2027-11-30)と、6・7・9の契機の到来を追跡する
- Core: 署名鍵(O-16)とattestationが有効なReleaseが公開されたら、`SHA256SUMS`と署名を照合し、`core-lock/`で版固定して`mhc verify`を通す
- MCIP: 対外案件IDの発番・配布APIが提供されたら、`project_id`の外部ID列をadditive migrationで追加し、読み取り・照合を実装する
- CDE: Web-CADの承認済み版を受けるAPI・認証・受入形式が提供されたら、登録アダプタを実装する
- Staging: Access Service Tokenを使うE2Eをオーナーが実施し、結果を記録する
- オフサイト転送: R2 token・age鍵・ユニット設置の実施(オーナーのY/N後)と、初回転送・復号・通知の試験の成功

再開時も、秘密値や個人情報そのものはIssue、PR、Git、チャットへ貼り付けません。
