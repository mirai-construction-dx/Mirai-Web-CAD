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
| 3. マージ前の人間レビュー | 組織決定済み・見直し待ち | 組織の開発ガバナンス(Portfolio `PORT-GOV-001`、Core ADR-0016)でWeb-CADは**B型**(品質ゲートで自動マージ、承認0)。2人目(security-reviewers、2026-09-28提示予定)の参加後に、重要変更の承認要件を再判断 |
| 4. CODEOWNERSのTeam | 組織決定済み・見直し待ち | B型ではCODEOWNERS不要(PORT-GOV-001 §2.2)。3の見直しで承認型へ変える場合に、Write以上のTeamで整備 |
| 5. 技術標準の適用範囲 | 必要時に判断 | 実行環境の更新が必要になった時点で判断([ADR-0004](adr/ADR-0004-tech-stack-vs-os-selection.md)提案)。契機の例: Node 22のサポート期限、PostgreSQL 16のサポート期限 |
| 6. Core成果物の版 | 必要時に判断 | Coreの契約を取り込む時点で判断。原則は署名・ハッシュ付きRelease(現在v0.1.0のみ公開、タグはv0.6.0まで) |
| 7. 案件ID・確定版・MCP | 必要時に判断 | 第3段階。MCIPの案件ID API、CDE登録方式、Web-CAD MCPのツール仕様が公開された時点で判断 |
| 8. Organization名 | **決定** | `mirai-construction-dx`に統一。原典(全体構成 V3.6)のHTMLは変更せず、Portfolioの未決事項表(PORT-BL-001 BL-06)に決定を記録(Portfolio PR #20) |

## 再開条件

- Cloudflare: 上記3権限を対象account/zoneだけに付けたtokenが現在のシェルへ投入済み
- Entra: tenant内の対象UPN、グループGUID対応、Secret運用責任者、当番/SLA台帳の参照IDが確定
- Phase 0: 許諾済みDXFの保管場所とUAT参加者台帳の参照IDが確定
- 基盤整合: 3・4は2人目の参加時、5・6・7は必要になった時点で判断(決定ごとにADRのステータスと本表を更新)

再開時も、秘密値や個人情報そのものはIssue、PR、Git、チャットへ貼り付けません。
