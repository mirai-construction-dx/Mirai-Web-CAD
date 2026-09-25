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
| 3. マージ前の人間レビュー | **決定** | B型を継続(品質ゲート+CodeRabbit+会話解決必須+高リスク変更のオーナーY/N)。**Botは2人目の代わりにしない**(PORT-GOV-001/ADR-0016でBotは承認しない、AIが作成と承認を兼ねると自己承認になる)。2人目(2026-09-28提示予定)参加後の承認方式の見直しは、組織全体としてCore ADR-0016の条件に従う |
| 4. CODEOWNERSのTeam | **決定** | B型のためCODEOWNERSは置かない(現行の個人指定は既存のまま)。承認型へ変える場合に、Write以上のTeamで整備する |
| 5. 技術標準の適用範囲 | **決定** | アプリ構成は例外として維持、実行環境はNode 24へ2027-01-31まで、PostgreSQL 18へ2027-11-30までに更新([ADR-0004](adr/ADR-0004-tech-stack-vs-os-selection.md)承認済み) |
| 6. Core成果物の版 | **決定** | 取り込むのは署名・SHA256付きのGitHub Releaseのみ(タグのvendoringはしない)。現時点は取り込まない。契機(証跡のMCIP送信、MCP公開)の時点で必要な版がReleaseされていなければCoreへRelease作成を依頼する |
| 7. 案件ID・確定版・MCP | **決定** | 第3段階。契機まで実装しない。案件ID: 独自採番を継続し、MCIPの案件ID API公開時に外部ID列をadditive migrationで追加。確定版: CDEのAPI公開時に承認済み版を登録。MCP: 読み取り系ツールから、Coreで契約化→Allowlist登録の順 |
| 8. Organization名 | **決定** | `mirai-construction-dx`に統一。原典(全体構成 V3.6)のHTMLは変更せず、Portfolioの未決事項表(PORT-BL-001 BL-06)に決定を記録(Portfolio PR #20) |

## 再開条件

- Cloudflare: 上記3権限を対象account/zoneだけに付けたtokenが現在のシェルへ投入済み
- Entra: tenant内の対象UPN、グループGUID対応、Secret運用責任者、当番/SLA台帳の参照IDが確定
- Phase 0: 許諾済みDXFの保管場所とUAT参加者台帳の参照IDが確定
- 基盤整合: 8件とも決定済み(2026-09-25)。5の期限(Node 2027-01-31、PostgreSQL 2027-11-30)と、6・7の契機の到来を追跡する

再開時も、秘密値や個人情報そのものはIssue、PR、Git、チャットへ貼り付けません。
