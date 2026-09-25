# 外部入力・確定待ち台帳

更新日: 2026-09-25

コードだけでは確定できない運用情報を、推測値で埋めないための台帳です。秘密値、個人の電話番号、実案件名、図面本体はGitへ保存しません。

## 1. Cloudflare Terraform移管

| 確認項目 | 2026-09-05の実測 | 次に必要な入力 |
| --- | --- | --- |
| API token自体 | `/user/tokens/verify`はHTTP 200 | なし |
| Access Application一覧 | 対象accountへのAPIはHTTP 200だが0件 | 正しいZero Trust accountの確認、または対象accountへ`Access Apps and Policies Read/Write`を付けたtoken |
| MVP/本番DNS | 対象zoneのDNS APIはHTTP 403(code 10000) | 対象zone限定の`DNS Read/Write` |
| Tunnel | 既知のTunnel IDはテンプレートへ記録済み | 対象account限定の`Cloudflare Tunnel Read/Write` |
| `terraform.tfvars` | 未作成。IDを推測していない | Application、policy、MVP DNS、本番DNSの実ID |
| import/plan/apply | 未実施 | 上記IDを棚卸し後、import-only planが無差分であること |

権限追加後は[Cloudflare Terraform手順](../infra/cloudflare/README.md)の順にread-only棚卸しをやり直します。Access policyにメール完全一致1件以外の差分、DNS/Tunnelの置換、`everyone`/`bypass`が出た場合はapplyしません。

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

| 事項 | 状態(2026-09-25) | 内容・次の入力 |
| --- | --- | --- |
| 1. system_id | **決定** | `web-cad`(オーナー決定)。Core `registries/systems.yaml`への登録はMirai-Harness-Core PR #27(A型: オーナーのApprove後にマージ)。Platform-Infraの台帳は未作成 |
| 2. AI Provider直接呼出し | **決定** | 案A(期限付きの暫定例外)、見直し期限2026-12-25([ADR-0003](adr/ADR-0003-ai-provider-direct-call-interim.md)承認済み)。移行条件はMCAH Model GatewayのWeb-CAD向け契約公開とsystem_id登録 |
| 3. マージ前の人間レビュー | **決定(2026-09-25改定)** | **A型へ切替え**: Bot名義のPRにオーナーがGitHub上でApproveしてからマージ(承認1件+CODEOWNER、最後のpush後の承認、スレッド解決を必須)。Botは2人目の代わりにしない。**2人目の承認者は2026-10以降に決定**(オーナー判断)。基盤方針の通常2名・重要3名を満たしていないリスクを、下記の補完策を前提に受け入れる。**見直し期限 2026-10-31**。先送りを終える契機: 実案件図面の取扱い開始、オーナー以外の利用者への提供開始、見直し期限の到来のいずれか |
| 4. CODEOWNERSのTeam | **決定(2026-09-25改定)** | A型のためCODEOWNERの承認を必須化。当面は個人`@Kensan196948G`(管理者権限あり)をCODEOWNERとし、2人目の決定時にWrite以上のTeamへ移す |
| 5. 技術標準の適用範囲 | **決定** | アプリ構成は例外として維持、実行環境はNode 24へ2027-01-31まで、PostgreSQL 18へ2027-11-30までに更新([ADR-0004](adr/ADR-0004-tech-stack-vs-os-selection.md)承認済み) |
| 6. Core成果物の版 | **決定** | 取り込むのはCoreのGitHub Releaseのみ(タグのvendoringはしない)。`SHA256SUMS`照合と`mhc verify`に加え、署名・来歴証明の検証を必須とする(現在のv0.1.0は署名・attestationなし)。現時点は取り込まない。契機(証跡のMCIP送信、MCP公開)の時点で、必要な版の署名付きReleaseが無ければCoreへ作成を依頼する。手順は[基盤連携の要件と現状](architecture/platform-integration.md)§3 |
| 7. 案件ID・確定版・MCP | **決定** | 第3段階。契機まで実装しない。案件ID: 独自採番を継続し、MCIPの案件ID API公開時に外部ID列をadditive migrationで追加。確定版: CDEのAPI公開時に承認済み版を登録。MCP: 読み取り系ツールから、Coreで契約化→Allowlist登録の順 |
| 8. Organization名 | **決定** | `mirai-construction-dx`に統一。原典(全体構成 V3.6)のHTMLは変更せず、Portfolioの未決事項表(PORT-BL-001 BL-06)に決定を記録(Portfolio PR #20) |

### 1名承認体制の補完策(2026-09-25)

| 弱点 | 補完策 | 状態 |
| --- | --- | --- |
| 人の確認が1名 | CI必須チェック、CodeRabbitの自動レビュー、レビュースレッド解決の必須化 | 実施済み |
| 重要変更の見落とし | 高リスク変更はApproveに加えオーナーのY/N | 実施済み |
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

- Cloudflare: 上記3権限を対象account/zoneだけに付けたtokenが現在のシェルへ投入済み
- Entra: tenant内の対象UPN、グループGUID対応、Secret運用責任者、当番/SLA台帳の参照IDが確定
- Phase 0: 許諾済みDXFの保管場所とUAT参加者台帳の参照IDが確定
- 基盤整合: 8件とも決定済み(2026-09-25)。5の期限(Node 2027-01-31、PostgreSQL 2027-11-30)と、6・7の契機の到来を追跡する
- オフサイト転送: R2 token・age鍵・ユニット設置の実施(オーナーのY/N後)と、初回転送・復号・通知の試験の成功

再開時も、秘密値や個人情報そのものはIssue、PR、Git、チャットへ貼り付けません。
