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

| 事項 | 2026-09-25の実測 | 判断者・必要な入力 |
| --- | --- | --- |
| AI Provider直接呼出し | 方針は禁止。Web-CADは本番でOpenAI/Anthropicを直接呼出し中 | 暫定例外として認めるか、移行時期([ADR-0003](adr/ADR-0003-ai-provider-direct-call-interim.md))。MCAH Model GatewayのWeb-CAD向け契約 |
| system_id | Core `registries/systems.yaml`にweb-cadの登録なし。Platform-Infra(main)にはsystems台帳自体が未作成 | system_idとaudienceの決定、Core/Platform-Infra側での登録 |
| マージ前の人間レビュー | 方針は通常2名・重要3名。Rulesetの必須承認数は0、配布中の`GITHUB_POLICY.md`は自動マージを標準化 | 1名体制での承認方法(自己承認不可の制約)と、中央ポリシーの改訂要否 |
| CODEOWNERSのTeam | 組織のTeamは`core-maintainers`/`platform-reviewers`/`security-reviewers`/`ai-authors`。Web-CADへのアクセス権があるのは`ai-authors`のみ。`application-reviewers`・`data-spatial-reviewers`は未作成 | Teamの作成とWeb-CADへの権限付与(権限境界の変更) |
| 技術標準の適用範囲 | 標準はPostgreSQL 18・Node 24(buildのみ)・React+TS+Vite・FastAPI。Web-CADは16・22・vanilla JS・Node API | Domain Productへの適用有無([ADR-0004](adr/ADR-0004-tech-stack-vs-os-selection.md)) |
| Core成果物の版 | Release `v0.1.0`のみ公開、タグは`v0.6.0`まで。CEOSは`v0.6.0`をvendoring | Web-CADが契約を取り込む時点で採用する版と配布方式 |
| 案件ID・確定版・MCP | 案件IDは独自採番、確定版のCDE登録なし、MCPサーバーなし(第3段階) | MCIPの案件ID API、CDE登録方式、Web-CAD MCPのツール仕様 |
| Organization名 | 全体構成は候補「mirai-construction」、組織構成案と実体は`mirai-construction-dx` | 文書側の表記統一 |

## 再開条件

- Cloudflare: 上記3権限を対象account/zoneだけに付けたtokenが現在のシェルへ投入済み
- Entra: tenant内の対象UPN、グループGUID対応、Secret運用責任者、当番/SLA台帳の参照IDが確定
- Phase 0: 許諾済みDXFの保管場所とUAT参加者台帳の参照IDが確定
- 基盤整合: 上表の判断者による決定(決定ごとにADRのステータスと本表を更新)

再開時も、秘密値や個人情報そのものはIssue、PR、Git、チャットへ貼り付けません。
