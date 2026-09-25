# オーナー不在時のロールバックRunbook

Web-CADは承認必須(A型)で、mainへの変更にはオーナーのGitHub Approveが必要です。オーナーが不在でも本番の障害を止められるよう、**本番ホストの作業ツリーを直前の正常なcommitへ戻す**手順をここに定めます。mainは変更しないため承認は不要です。mainのrevertはオーナーの復帰後にPRで行います。

対象: 本番`mirai-web-cad.service`(18812)、MVP`mirai-web-cad-mvp.service`(18813)。実行者: 本番ホストにログインできる運用担当またはAIエージェント。

## 1. 判断基準

次のいずれかで、直前のデプロイが原因と判断できる場合に実行します。原因が不明な場合は先に[サービス停止Runbook](service-outage.md)で切り分けます。

- デプロイ後にhealthがok以外、または主要操作(図面表示・保存)が失敗する
- エラー率の急増、画面が表示されない

DBの障害・データ破損は対象外です([DB障害Runbook](database-incident.md))。**本番DBの復元はオーナーの判断なしに行いません。**

## 2. 手順

```bash
cd /home/kensan/Projects/Mirai-Construction-DX/Mirai-Web-CAD
git status --porcelain            # 空であること(未コミット変更があれば中止して記録)
git rev-parse --short HEAD        # 現在の稼働commit(記録する)
git log --oneline -5              # 直前の正常commitを特定する(デプロイ前の稼働commit)

ls -lt .releases/                 # 直前の正常commitのリリース(.releases/<sha>/ または legacy-<sha>/)を確認する

prev=<直前の正常commitSHA>
rel=.releases/$prev               # 退避した初回分は .releases/legacy-$prev
git checkout --quiet "$prev"
ln -sfn "$rel/node_modules" .swap-node_modules && mv -Tf .swap-node_modules node_modules
ln -sfn "$rel/dist" .swap-dist && mv -Tf .swap-dist dist
sudo systemctl restart mirai-web-cad.service mirai-web-cad-mvp.service
```

`dist`と`node_modules`は`.releases/<sha>/`へのsymlinkです。**稼働中のツリーで`npm ci`や`npm run build`を実行しないでください**(依存が一時的に消え、未検証の画面が配信されます)。直前のリリースが`.releases/`に無い場合だけ、別ディレクトリでbuildしてから向き先を切り替えます。

デプロイ前の稼働commitは、`deploy-local.sh`の出力の「ロールバック先」、またはデプロイ前に記録した`/api/health`の`deploy.commit`で確認します。

## 3. 確認

```bash
for port in 18812 18813; do curl -s --max-time 5 http://127.0.0.1:$port/api/health; echo; done
```

`ok: true`、`deploy.commit`と`deploy.distCommit`が戻したcommit、`db.mode: connected`であることを確認します。`npm run deploy:drift`はmainより古いcommitが稼働しているため「一致」になりません(想定どおり)。

## 4. 記録と復帰後の対応

1. GitHub Issueに、発生時刻、症状、戻す前後のcommit、確認結果を記録する。
2. オーナーの復帰後、原因のPRをrevertするPR(Bot名義)を作成し、オーナーのApproveを得てmainへマージする。
3. 修正版をデプロイし、`npm run deploy:drift`が「一致」に戻ることを確認する。
