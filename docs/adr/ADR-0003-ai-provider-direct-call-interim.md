# ADR-0003: AI Providerの直接呼出しを暫定例外とし、Model Gateway(MCAH)経由へ移行する

## ステータス

提案(Proposed、2026-09-25)。例外として認めるか、移行時期をいつにするかは未決定(判断者: 基盤の技術責任者/CTO)。決定まではコードを変更しない。

## コンテキスト

- リポジトリ構成 ベストプラクティス V3.6 の「禁止」表は「Domain ProductからAI Providerを直接呼ぶ」ことを禁止し、全体構成 V3.6 はAI呼出しをModel Gateway経由とし、Providerのキーを持つのはGatewayだけとしている。
- 現状のWeb-CADは`src/ai-provider.js`でOpenAI(`api.openai.com`)またはAnthropic(`api.anthropic.com`)を直接呼び、本番環境が`AI_PROVIDER`とProviderのAPIキーを保持している(改善台帳P0-36で本番有効化)。
- 呼出しはサーバー側プロキシに限定済みで、ブラウザはキーを持たない(P0-34)。AIは提案を生成するだけで、図面への反映には利用者の明示的な「適用」操作が必要(CAD CoreはAIから独立)。
- ただし、基盤方針が求める**人間承認は未充足**。API接続時の適用は承認API(`/api/agent-runs/:id/approve`)で記録されるが、編集権限(`canEdit`)を持つ利用者なら誰でも実行でき、承認者の分離や承認済みマーカーの検証はない。オフライン時は承認記録を残さずにブラウザ内で適用する。
- 2026-09-25時点で、Web-CADが接続できるModel Gateway(MCAH)のエンドポイント・契約・system_idは提示されていない(Core `registries/providers.yaml`、`routing/model-routing.yaml`は存在)。

## 選択肢

| 案 | 内容 | 影響 |
| --- | --- | --- |
| A. 暫定例外として継続し、Gateway公開後に移行 | 現行の直接呼出しを期限・条件付きで認める | AI提案機能を維持。方針違反が残るため、期限と移行条件の明記が必要 |
| B. 直ちにAI Provider呼出しを無効化 | `AI_PROVIDER`を外し、ルールベース提案のみとする | 方針に即時適合。自然言語からの提案がルールベース3パターンへ縮退 |
| C. Gateway接続を先に実装 | Gatewayの契約を待たずに独自接続を作る | 契約未確定のまま結合を作るため、リポジトリ構成 V3.6 の「独自ベタ結合禁止」に抵触するおそれ。推奨しない |

## 提案する決定

案Aを提案する。移行条件は次のとおり。

1. MCAH Model GatewayのWeb-CAD向けエンドポイント・認証方式・契約(Coreで版管理)が公開されること。
2. Web-CADのsystem_idがCoreの台帳に登録されること。
3. 移行後は本番環境からProviderのAPIキーを削除し、`src/ai-provider.js`の直接呼出しを廃止する(本番secretの削除は組織方針上Approval PR対象)。
4. 移行までの間も、キーはサーバー側のみ・AIは提案のみ・反映は利用者の明示操作、の現行制約を維持する。人間承認(承認者の分離と承認記録)は未充足の要件として別途扱う。
5. **見直し期限: 2026-12-25**(提案日から3か月)。この日までに条件1・2が満たされない場合は、例外の継続か案Bへの切替えを改めて判断し、本ADRを更新する。

## 結果

- 決定されるまで、方針との不整合は[基盤連携の要件と現状](../architecture/platform-integration.md)と[外部入力・確定待ち台帳](../external-input-status.md)§4に記録する。
