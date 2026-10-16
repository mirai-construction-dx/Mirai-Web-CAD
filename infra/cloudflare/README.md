# Cloudflare Terraform

Mirai Web CADの既存Cloudflare Tunnel、本番/MVPの2つのCNAME、MVP Access ApplicationをTerraformで管理するための構成です。加えて[ADR-0005](../../docs/adr/ADR-0005-staging-environment.md)の**Staging環境**(3つ目のCNAMEとAccess Application)を、**未管理(`enable_management=false`)のまま**コード化しています。新規環境の作成用ではなく、**稼働中資源をimportしてから管理へ移す**ことを前提にしています。

## 管理範囲

- ローカル管理Tunnel `mirai-web-cad`の登録情報
- `mirai-web-cad.mirai-dx-platform.com`と`mirai-web-cad-mvp.mirai-dx-platform.com`のCNAME
- MVPホスト全体のAccess Application
- MVPを`kensan1969@gmail.com`だけに限定するallow policy
- **未管理**: StagingのCNAME(`mirai-web-cad-stg.mirai-dx-platform.com`)とAccess Application(下記「Staging環境の定義」)

初回importでは既存policyを意図せず更新しないよう、Application側は棚卸ししたpolicy UUIDとprecedenceだけを参照します。policy本文がメール完全一致のallow 1件であることは棚卸し記録と初回planで照合し、差分がある状態ではapplyしません。

Tunnel ingress自体はローカルの`~/.cloudflared/mirai-web-cad-config.yml`で稼働するため、正本テンプレートは`deploy/cloudflared/mirai-web-cad-config.example.yml`です。Tunnel secretやcredentials JSONはTerraformへ渡さず、stateにも保存しません。

## 必要な権限

専用API tokenへ対象アカウント・zoneだけを指定し、Cloudflare Tunnel Read/Write、DNS Read/Write、Access Apps and Policies Read/Writeを付与します。Global API Keyは使用しません。token値は`CLOUDFLARE_API_TOKEN`環境変数だけで渡します。

## 初回import

1. `terraform.tfvars.example`を`terraform.tfvars`へ複製する。
2. `enable_management=false`のまま、APIまたはZero Trust画面から既存Access Application ID、そのApplication内のallow policy ID、2つのDNS record IDを調べる。policyの名前、decision、precedence、include/exclude/requireもコードと一致することを記録する。
3. 4つのIDを`terraform.tfvars`へ入力する。IDを推測してはいけない。
4. `enable_management=true`へ変更し、次を実行する。`imports.tf`はIDが全て揃うまで無効で、ID不足のまま管理を有効化するとplanが強制停止する。

```bash
export CLOUDFLARE_API_TOKEN='<scoped token>'
terraform -chdir=infra/cloudflare init
terraform -chdir=infra/cloudflare fmt -check
terraform -chdir=infra/cloudflare validate
terraform -chdir=infra/cloudflare plan -out=first-import.tfplan
terraform -chdir=infra/cloudflare show first-import.tfplan
```

最初のplanは4資源のimportだけで、Access policyを含む既存値に更新・追加・削除差分がないことを要求します。特にAccess policyの変更、`everyone`、`email_domain`、`bypass`、Service Tokenの常設、Tunnel/DNSの置換が表示された場合はapplyしません。

## 変更手順

```bash
npm run infra:check
terraform -chdir=infra/cloudflare fmt -check
terraform -chdir=infra/cloudflare validate
terraform -chdir=infra/cloudflare plan -out=change.tfplan
terraform -chdir=infra/cloudflare show change.tfplan
terraform -chdir=infra/cloudflare apply change.tfplan
```

適用後は`docs/runbooks/cloudflare-access-change.md`の検査を実行します。`terraform.tfvars`、state、plan、API tokenはコミットしません。`imports.tf`は条件付きの安全装置としてコード管理します。stateは所有者のみ読める場所へバックアップし、チャット・Issue・CI artifactへ添付しません。

## Staging環境の定義(未管理)

[ADR-0005](../../docs/adr/ADR-0005-staging-environment.md)のStaging(`mirai-web-cad-stg.mirai-dx-platform.com`、origin `http://127.0.0.1:18814`)を、MVPと同じパターンでコード化しています。**稼働中の設定は変更せず、`enable_management=false`を維持**します。

- 追加したもの: Staging CNAME(`local.tunnel_dns_records`の`staging`)、Staging Access Application(`cloudflare_zero_trust_access_application.staging`)、`staging_allowed_email`・`staging_access_application_id`・`staging_access_policy_id`・`staging_dns_record_id`変数、監査用の`staging_access_aud`出力。
- 既存Tunnel `mirai-web-cad`を再利用し、新しいTunnelは作りません。Tunnel ingress(origin `http://127.0.0.1:18814`)はローカル`~/.cloudflared/mirai-web-cad-config.yml`側で、正本テンプレートは`deploy/cloudflared/mirai-web-cad-config.example.yml`です。Terraformへは入れず、追記はHuman Gateで行います。
- 許可対象はMVPと同じ`kensan1969@gmail.com`のみ(ホスト全体、bypassなし)。Application側は棚卸ししたpolicy UUIDと`precedence=1`だけを参照し、policy本文は初回importで書き換えません。

### 管理が有効にならない仕組み

- `enable_management`は`false`のままにします。
- `terraform.tfvars`のStaging IDがプレースホルダ(`0000...`)の間は`local.staging_inventory_ready=false`となり、Staging資源は`count=0`でplan/applyに現れず、Staging CNAMEもルーティング表へ入りません。
- `enable_management=true`にしても、`local.inventory_ready`(本番/MVP)と`local.staging_inventory_ready`(Staging)の**両方**が真になるまでStaging資源は作られません。

### Stagingのimport-only plan(オーナーのY/N後)

DNS import blockはStaging CNAMEも取り込みます。Staging Access Applicationは`imports.tf`の対象外(CI guardrail `scripts/check-cloudflare-iac.mjs`がimport対象をMVP/本番に固定しているため)なので、オーナーが明示的に`terraform import`します。**applyは行わず**、import-only planが無差分であることだけを確認します。

```bash
export CLOUDFLARE_API_TOKEN='<scoped token>'
terraform -chdir=infra/cloudflare init
terraform -chdir=infra/cloudflare fmt -check
terraform -chdir=infra/cloudflare validate
# terraform.tfvarsのStaging IDを記入し、enable_management=trueへ変更してから:
terraform -chdir=infra/cloudflare import 'cloudflare_zero_trust_access_application.staging[0]' \
  'accounts/<account_id>/<staging_access_application_id>'
terraform -chdir=infra/cloudflare plan -out=staging-import.tfplan
terraform -chdir=infra/cloudflare show staging-import.tfplan
```

planにcreate/update/destroyが現れる、またはpolicy変更・`everyone`・`email_domain`・`bypass`が出た場合はapplyしません。ホスト反映(DNS route、Access新設、秘密情報、systemd配置、DB/ロール作成)を含むHuman Gateの手順は[Staging構築手順書](../../docs/runbooks/staging-bringup.md)を正とします。

## 現在の移行状態

コード、guardrail、CI検証は準備済みです。2026-09-05の再棚卸しではtoken verifyは成功しましたが、DNS APIは`403/code 10000`、Access Application APIはHTTP 200でも0件でした。2026-10-16にオーナーがCloudflare自動化をCTOへY委譲し、**Web-CAD自身の資源のread-only inventoryは完了**しました。account `4f1e888469df7e0b896bb4e211b12633`、zone `mirai-dx-platform.com` = `e375e651e49a40801a305b89e297bff0`、Tunnel `mirai-web-cad` = `f8c9fb57-fb21-4a24-b1be-f7dd5699badc`、本番/MVP/StagingのDNS record ID、MVP/StagingのAccess Application IDとAUD、allow policy IDを実測し、**`terraform.tfvars`(Git管理外、ローカル作成)へ記録**しました(一覧は[外部入力・確定待ち台帳](../../docs/external-input-status.md)§1)。

ただし**`enable_management=false`を維持**しており、import-only plan/applyは未実施です。管理を有効化する際は、記録済みIDを入力して`enable_management=true`とし、import-only planに差分(特にpolicy変更・`everyone`・`email_domain`・`bypass`・Tunnel/DNS置換)が無いことを確認してからapplyします。詳細は[外部入力・確定待ち台帳](../../docs/external-input-status.md)を参照してください。

Stagingの定義(2026-10-16追加)も同じく未管理です。`-stg`命名は組織の他ConsumerのStaging公開ホスト名(`arcsphere-stg`、`cssp-stg`、`construction-os-stg`)と揃え、同じ`<app>-stg`＋`self_hosted`＋session 24hのパターンで作成しました。Staging CNAMEとAccess Application/Policyは2026-10-16にプロビジョニング済みで、実ID(Staging CNAME `1ce6a00f970aa00c1b152d33bebec2a8`、Access Application `552bd803-cd79-4376-a388-278917378955`、allow policy `6a4e42ff-8133-4225-ad80-d2ca654a8d75`)を`terraform.tfvars`へ記入済みです。ただし`enable_management=false`を維持するためStaging資源はplan/applyに現れません。Staging Access Applicationは`imports.tf`の対象外のため、管理を有効化する際はオーナーが明示的に`terraform import`します。残るHuman Gate(秘密情報・DB・systemd配置・復元ドリル・最終検証)は[Staging構築手順書](../../docs/runbooks/staging-bringup.md)を正とします。
