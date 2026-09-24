# 追加実装ロードマップ

更新日: 2026-09-05。今回依頼の34領域を、実装順・依存・完了条件へ分解した開発台帳。
既存の[改善台帳](improvement-register.md)と[正式方針](Mirai-Web-CAD_80-90％代替・AI統合開発方針.md)を補完する。

## 固定方針

DXF交換・精密CAD Core・尺度保証PDFをAI拡張より先に完成させる。DWGバイナリ直接対応はADR-0002に従い恒久対象外。高度3D、BIM Authoring、Rendering、機械/電気CAD、AutoLISP/ARX完全互換、AutoCAD全機能コピーも対象外。
「実装」「自動試験」「実案件受入」を別に記録する。合成図面だけで互換認定や代替率80-90%を宣言しない。順序は着手目安で、依存IDが先行する。ACL設計は案件管理の前に実施する。

## 今回の実装

継続追加: [高度な選択・追加編集](advanced-selection-editing.md)。Fence/Lasso、Previous/Last、類似/条件選択、保存セット、限定LENGTHEN/REVERSE/PURGE/OVERKILLを追加。各機能の対象形式・近似・残件をリンク先で明示する。

- 複数選択、左→右Window、右→左Crossing、Shiftクリック追加/除外、Ctrl/Cmd+A、SELECT ALL。
- 選択セットのドラッグ移動・削除・CLI MOVE/COPY/ROTATE/SCALE。1回のトランザクションで確定し、Undo/Redoを既存履歴へ統合。
- LINE/PLINE/HATCH/DIMの点、SPLINE制御点、円中心/半径、ARC始終角、ELLIPSE中心/軸、TEXT/BLOCK/RECT基点のグリップ。変更プレビューを保存対象から分離しEsc/捕捉喪失で破棄。
- STRETCH (LINE/PLINE/HATCH/SPLINE頂点)、EXPLODE (RECT/PLINE/属性なしBLOCK)、MATCHPROP (layerId/style)。CLIとプロパティパネルの操作メニューへ接続。
- ブロックの移動・回転・尺度で子座標を二重変換しない修正。

これらは限定対応。Multi-grip、選択インデックス、曲線選択の厳密解、属性付きBlock分解、全属性MATCHPROP、全形式STRETCHは未完了。ELLIPSE/SPLINEの選択は既存sampling精度。複数選択時の個別プロパティ更新は無効化し、プロパティのコピーはMATCHPROPを使用する。

精密編集の追加: RECTの回転は閉polylineへ変換して全頂点を保持。矩形角は対角を固定して伸縮し、交差ドラッグでも正の幅/高さへ正規化。LINE/PLINE中点グリップは該当線分の両端を移動し、円弧半径グリップは始終角を保持する。負の幅/高さを持つ既存矩形の境界も正規化する。

継続開発で[連想寸法の第1段階](associative-dimensions.md)を追加。Aligned/水平/垂直/半径/直径、参照切れ検出、書式Override、オフセットグリップ、JSON参照の再割当、選択セットCOPYの参照付け替えに対応。完全な寸法エンジンとDXF/PDF受入は引き続き未完了。

## 操作例

空白からドラッグで窓選択、Shiftクリックで追加/除外。単一選択の青いグリップをドラッグすると点を編集する。ロック中レイヤーを含む移動は開始せず、変更要求はCore/APIでも検証する。

```text
SELECT ALL
MOVE 500,0
COPY 0,1000
ROTATE 90 0,0
SCALE 2 0,0
STRETCH 900,-100 1100,100 200,0
EXPLODE
MATCHPROP sourceId
ERASE
UNDO
REDO
```

座標は`x,y`(絶対)、`距離<角度`(絶対極)、`@dx,dy`(直前点からの相対)、`@距離<角度`(相対極)で指定できる。角度は度で+X軸から反時計回り。`@`は同じコマンド内の2点目以降だけで使え、先頭点や移動量(`MOVE`/`COPY`/`STRETCH`の`dx,dy`)では拒否する。例: `PLINE 0,0 @1000,0 @500<90 CLOSE`、`RECT 10,20 @300,-200`。

STRETCHは2点の矩形と移動量、MATCHPROPはコピー元IDを指定する。対象IDを省略すると現在の選択セットを使用。EXPLODEは属性付きBlockを黙って破棄せず拒否する。

## 受入ゲート

選択編集PR #73の検証: `npm run verify:fast`成功 (単体228成功、ローカルではDB接続が必要な1件はskip)、Playwrightはdesktop/mobile合計60件成功。GitHub CIでPostgreSQL統合・Migration・Backup/Restoreも成功しmainへマージ。連想寸法追加後のE2Eは62件成功。実案件100図面・実機印刷による認定は未実施。

1. G1: 順序1-10のCAD基盤を機能別に検証。日本語フォント、線幅、用紙寸法、実測尺度を含むPDF受入を実施。
2. G2: 利用許諾付き実案件DXF100件で往復し、font/linetype/layer/block/dimensionの保持を認定。台帳と実体の不足は[外部入力台帳](external-input-status.md)で管理。
3. G3: 同一の土木2D作業シナリオと重みで代替率を再採点し、機能実装率と実務代替率を分ける。現行30-35%評価は今回の変更だけでは改定しない。
4. G4: 100k性能、30秒復旧、複数利用者ACL・承認・競合の業務受入。
5. G5: 土木・電子納品・GISを公式資料の年版と発注者基準で検証してから認定。

## 作業項目

各行の「後続」は追加/強化の受入が未完了という意味で、既存機能が全くないという意味ではない。共通完了条件は永続化、読込、UI、Core/API認可、正常/異常系、Undo、関連する交換形式の回帰確認。下記領域ごとの条件を各項目に追加適用する。

### SEL: 選択

優先度 P0 / 実装順 1 / 依存 なし

完了条件: 窓は全体包含、交差は実形状との接触で判定。非表示を除外しズーム倍率による操作差を検証。

| ID | 実装対象 | 状態 |
| --- | --- | --- |
| SEL-01 | 複数選択 | 一部実装・上記範囲参照 |
| SEL-02 | Window | 一部実装・上記範囲参照 |
| SEL-03 | Crossing | 一部実装・上記範囲参照 |
| SEL-04 | Select All | 一部実装・上記範囲参照 |
| SEL-05 | Shift追加・除外 | 一部実装・上記範囲参照 |
| SEL-06 | Fence/Lasso | 一部実装: 曲線はsampling |
| SEL-07 | Previous/Last | 実装: 直前セット/最後の可視図形 |
| SEL-08 | Select Similar/Quick Select | 一部実装: 種類・レイヤー等 |
| SEL-09 | レイヤー・種類・色・線種・線幅・属性による選択 | 一部実装: 種類/レイヤー色/レイヤー/線幅 |
| SEL-10 | 選択セット保存 | 実装: 図面保存・監査・Undo・JSON再割当 |

### GRIP: グリップ

優先度 P0 / 実装順 1 / 依存 SEL

完了条件: 確定前は図面を不変に保ち、取消・Undo・ロック・承認済み拒否を検証。

| ID | 実装対象 | 状態 |
| --- | --- | --- |
| GRIP-01 | 端点・頂点 | 一部実装・上記範囲参照 |
| GRIP-02 | 中心・半径 | 一部実装・上記範囲参照 |
| GRIP-03 | Arc始終角 | 一部実装・上記範囲参照 |
| GRIP-04 | Spline制御点 | 一部実装・上記範囲参照 |
| GRIP-05 | Ellipse軸 | 一部実装・上記範囲参照 |
| GRIP-06 | 寸法点・文字挿入点 | 後続 |
| GRIP-07 | 中点・寸法オフセット | 後続 |
| GRIP-08 | Multi-grip | 後続 |
| GRIP-09 | Grip Stretch/Rotate/Scale/Mirror | 後続 |
| GRIP-10 | 動的プレビューとOSnap統合 | 後続 |

### EDIT: 精密編集

優先度 P0 / 実装順 2 / 依存 SEL,GRIP

完了条件: 数値期待値、退化形状、複数対象の原子性、Undo、API拒否を検証。

| ID | 実装対象 | 状態 |
| --- | --- | --- |
| EDIT-01 | STRETCH | 一部実装・上記範囲参照 |
| EDIT-02 | EXPLODE | 一部実装・上記範囲参照 |
| EDIT-03 | MATCHPROP | 一部実装・上記範囲参照 |
| EDIT-04 | LENGTHEN/REVERSE | 一部実装: 対応形式は追加編集文書参照 |
| EDIT-05 | 曲線TRIM/EXTEND | 後続 |
| EDIT-06 | ARC/SPLINE/ELLIPSE OFFSET | 後続 |
| EDIT-07 | 円・円弧・Polyline FILLET/CHAMFER | 後続 |
| EDIT-08 | BREAK AT POINT/JOIN拡張 | 後続 |
| EDIT-09 | ALIGN/DIVIDE/MEASURE/FLATTEN | 後続 |
| EDIT-10 | PURGE/OVERKILL | 一部実装: 未使用レイヤー/完全重複LINE・CIRCLE |

### SNAP: 作図補助

優先度 P0 / 実装順 2 / 依存 SEL

完了条件: 既知幾何の候補座標と画面許容距離を検証。作図と編集で同じ演算を利用。

| ID | 実装対象 | 状態 |
| --- | --- | --- |
| SNAP-01 | 接線・見かけ交点 | 後続 |
| SNAP-02 | 延長・平行・Node | 後続 |
| SNAP-03 | From/一時追跡点 | 後続 |
| SNAP-04 | 極・Object Snapトラッキング | 後続 |
| SNAP-05 | Dynamic Input/カーソル表示 | 後続 |
| SNAP-06 | 距離・角度直接入力 | 後続 |
| SNAP-07 | 相対座標・極座標 | 一部実装: CLI連続点の`@dx,dy`/`@距離<角度`、全座標引数の`距離<角度`。LASTPOINT・Canvas入力は後続 |
| SNAP-08 | Snap Override/OSnap一時無効/Ortho一時切替 | 後続 |

### DIM: 寸法

優先度 P0 / 実装順 3 / 依存 EDIT

完了条件: 参照図形の編集後に値を自動再計算し、削除で孤立を検出。表示・DXF・PDFの一致を確認。

| ID | 実装対象 | 状態 |
| --- | --- | --- |
| DIM-01 | Linear/Aligned | 一部実装: 連想Aligned/水平/垂直 |
| DIM-02 | Angular/Arc Length | 後続 |
| DIM-03 | Radius/Diameter | 一部実装: 円/円弧への連想寸法 |
| DIM-04 | Ordinate/Coordinate | 後続 |
| DIM-05 | Baseline/Continued/Chain | 後続 |
| DIM-06 | Center Mark/Center Line/Jogged | 後続 |
| DIM-07 | Break/Space | 後続 |
| DIM-08 | Dimension Style/文字/矢印 | 一部実装: 書式Override、文字/矢印寸法 |
| DIM-09 | 単位・尺度・精度・Prefix/Suffix | 一部実装: measurementScale、精度、Prefix/Suffix |
| DIM-10 | 公差・上下許容差・補助線 | 後続 |
| DIM-11 | Override/Styleコピー/テンプレート | 後続 |
| DIM-12 | Associative/尺度別注釈 | 一部実装: 参照追従、参照切れ、JSON往復 |

### TEXT: 文字・注記

優先度 P0 / 実装順 3 / 依存 EDIT

完了条件: 日本語を含む編集・保存・DXF・PDFの文字列と配置を検証。

| ID | 実装対象 | 状態 |
| --- | --- | --- |
| TEXT-01 | TEXT/MTEXT編集 | 後続 |
| TEXT-02 | Text Style/フォント管理・置換・fallback | 後続 |
| TEXT-03 | 縦書き/上下付き | 後続 |
| TEXT-04 | Unicode/JIS/外字/記号 | 後続 |
| TEXT-05 | 位置揃え/回転/Mask/Frame | 後続 |
| TEXT-06 | Find/Replace/Spell Check候補 | 後続 |
| TEXT-07 | 図面名・日付・尺度・版・利用者Fields | 後続 |
| TEXT-08 | LEADER/MLEADER/矢印/バルーン | 後続 |
| TEXT-09 | 標高・勾配・測点・座標・部材番号注記 | 後続 |
| TEXT-10 | Revision Cloud | 後続 |

### HATCH: ハッチ

優先度 P0 / 実装順 4 / 依存 EDIT

完了条件: 穴を含む面積、境界更新、異常境界、DXF往復を検証。

| ID | 実装対象 | 状態 |
| --- | --- | --- |
| HATCH-01 | Pick Point/Select Object境界 | 後続 |
| HATCH-02 | Island/Normal/Outer/Ignore | 後続 |
| HATCH-03 | Associative/境界再生成 | 後続 |
| HATCH-04 | Pattern/ANSI/JIS/土木 | 後続 |
| HATCH-05 | Scale/Angle/Origin | 後続 |
| HATCH-06 | Solid/Gradient/Transparency | 後続 |
| HATCH-07 | Hatch Edit/Trim | 後続 |
| HATCH-08 | DXF境界・パターン保持 | 後続 |

### BLOCK: ブロック

優先度 P0 / 実装順 5 / 依存 EDIT,TEXT

完了条件: 定義と参照を分離し、ネスト変換、属性同期、再定義、往復を検証。

| ID | 実装対象 | 状態 |
| --- | --- | --- |
| BLOCK-01 | Definition/Reference/Base Point | 後続 |
| BLOCK-02 | Insert/Scale/Rotation/Nested | 後続 |
| BLOCK-03 | Edit/Redefine/Replace | 後続 |
| BLOCK-04 | Explodeと属性変換 | 後続 |
| BLOCK-05 | ATTDEF/ATTRIBモデル | 後続 |
| BLOCK-06 | 属性編集/Sync | 後続 |
| BLOCK-07 | Library/Recent/Favorite/Company/Civil | 後続 |
| BLOCK-08 | Thumbnail/Search/Import/Export | 後続 |

### DXF: DXF交換

優先度 P0 / 実装順 6 / 依存 DIM,HATCH,BLOCK,TEXT

完了条件: 開く・編集・再出力・再読込を一つの受入単位にし、欠落を報告。実案件認定は別ゲート。

| ID | 実装対象 | 状態 |
| --- | --- | --- |
| DXF-01 | DIMENSION読書 | 後続 |
| DXF-02 | HATCH読書 | 後続 |
| DXF-03 | BLOCK/INSERT読書 | 後続 |
| DXF-04 | ATTDEF/ATTRIB読書 | 後続 |
| DXF-05 | MTEXT書出し | 後続 |
| DXF-06 | TrueColor/線種/尺度/線幅 | 後続 |
| DXF-07 | TextStyle/Layer属性 | 後続 |
| DXF-08 | Layout/PaperSpace/Viewport/図枠 | 後続 |
| DXF-09 | Units/INSUNITS | 後続 |
| DXF-10 | Opaque/Proxy/Custom Object非破壊保持 | 後続 |
| DXF-11 | DXF版・文字コード判定/Shift-JIS/UTF-8 | 後続 |
| DXF-12 | Import前検査/変換不能一覧・Canvas強調 | 後続 |
| DXF-13 | Export後Round-trip/差分レポート | 後続 |
| DXF-14 | 一括変換/CLI/API | 後続 |
| DXF-15 | 実案件100図面・許諾・許容差コーパス | 後続 |

### LAYER: レイヤー・表現

優先度 P0 / 実装順 7 / 依存 DXF

完了条件: 表示と編集可否と印刷可否を独立検証し、交換時に属性を失わない。

| ID | 実装対象 | 状態 |
| --- | --- | --- |
| LAYER-01 | Freeze/Thaw/Lock/Plot | 後続 |
| LAYER-02 | Isolate/Unisolate/Off/Previous | 後続 |
| LAYER-03 | Layer State/Filter/Group/Search | 後続 |
| LAYER-04 | Merge/Delete/Current/Object移動 | 後続 |
| LAYER-05 | BYLAYER/BYBLOCK/TrueColor | 後続 |
| LAYER-06 | Lineweight/Linetype | 後続 |
| LAYER-07 | Global/Object LTSCALE | 後続 |
| LAYER-08 | Transparency/Plot Style | 後続 |

### LAYOUT: Paper Space

優先度 P0 / 実装順 8 / 依存 LAYER

完了条件: モデル座標と紙座標を分離し、紙上寸法・Viewport尺度・ロックを検証。

| ID | 実装対象 | 状態 |
| --- | --- | --- |
| LAYOUT-01 | 複数Layout/Copy/Rename | 後続 |
| LAYOUT-02 | Paper Space Entity | 後続 |
| LAYOUT-03 | 複数Viewport | 後続 |
| LAYOUT-04 | Scale/Lock/Layer Freeze/Clipping | 後続 |
| LAYOUT-05 | A0-A4/縦横/カスタム用紙 | 後続 |
| LAYOUT-06 | Window/Extents/Center Plot | 後続 |
| LAYOUT-07 | 1:1/標準尺度/Custom Scale | 後続 |
| LAYOUT-08 | 線幅・モノクロ・カラーPlot Style | 後続 |
| LAYOUT-09 | Print Preview/Batch Plot/Sheet | 後続 |
| LAYOUT-10 | Title Block/Plot Stamp | 後続 |

### PDF: ベクタPDF

優先度 P0 / 実装順 9 / 依存 LAYOUT,TEXT,DIM

完了条件: 座標からベクタ生成。PDF構造の用紙寸法と既知長さを検証し、印刷した尺度・線幅・日本語を受入。

| ID | 実装対象 | 状態 |
| --- | --- | --- |
| PDF-01 | 座標ベクタ出力エンジン | 後続 |
| PDF-02 | 尺度・線幅・紙サイズ保証 | 後続 |
| PDF-03 | 日本語TrueType/OpenType埋込 | 後続 |
| PDF-04 | モノクロ/カラー | 後続 |
| PDF-05 | 図枠/表題欄/方向 | 後続 |
| PDF-06 | Metadata/PDF-A適用評価 | 後続 |
| PDF-07 | PDF差分・font・尺度回帰 | 後続 |

### FRAME: 土木図枠

優先度 P0 / 実装順 10 / 依存 PDF,BLOCK

完了条件: 提供された正本テンプレートと図枠位置・Fields・出力尺度を照合。

| ID | 実装対象 | 状態 |
| --- | --- | --- |
| FRAME-01 | A1/A2/A3 | 後続 |
| FRAME-02 | 社内/発注者/自治体/国交省 | 後続 |
| FRAME-03 | 図番/工事名/図名/尺度/日付 | 後続 |
| FRAME-04 | 作図者/照査者/承認者 | 後続 |
| FRAME-05 | Revision Table | 後続 |
| FRAME-06 | Layer/Text/Dimension/Plot Styleセット | 後続 |

### PROJECT: 案件・図面管理

優先度 P1 / 実装順 11 / 依存 ACL

完了条件: 横断IDOR拒否と1万件検索、空・失敗・ページングを検証。

| ID | 実装対象 | 状態 |
| --- | --- | --- |
| PROJECT-01 | Project/工事/工区/Folder | 後続 |
| PROJECT-02 | 図面番号/種類/分野/状態 | 後続 |
| PROJECT-03 | 発注者/現場/担当/作図/照査/承認 | 後続 |
| PROJECT-04 | 日付/コメント/Tag | 後続 |
| PROJECT-05 | Favorite/Recent | 後続 |
| PROJECT-06 | 全文検索/Filter/Sort/Pagination | 後続 |
| PROJECT-07 | Archive | 後続 |

### COMPARE: 図面比較

優先度 P1 / 実装順 12 / 依存 PROJECT

完了条件: 既存drawing-compare.jsへUIを接続し、追加・削除・変更の根拠を検証。

| ID | 実装対象 | 状態 |
| --- | --- | --- |
| COMPARE-01 | Before/After/Overlay/Side-by-side | 後続 |
| COMPARE-02 | Added/Deleted/Modified色分け | 後続 |
| COMPARE-03 | Geometry/Text/Dimension/Layer/Attribute差分 | 後続 |
| COMPARE-04 | Change List/理由/Reviewer Comment | 後続 |
| COMPARE-05 | Revision Cloud自動生成 | 後続 |
| COMPARE-06 | Diff PDF/Report/Rollback | 後続 |

### REVIEW: 承認・検図

優先度 P1 / 実装順 12 / 依存 COMPARE,ACL

完了条件: 状態遷移・権限・版署名・監査を同一トランザクションで検証。

| ID | 実装対象 | 状態 |
| --- | --- | --- |
| REVIEW-01 | Returned/Revised/Issued/Superseded/Archived | 後続 |
| REVIEW-02 | 指摘・必須コメント・Close | 後続 |
| REVIEW-03 | 複数Reviewer/Approver | 後続 |
| REVIEW-04 | Timestamp/Hash/Revision Signature | 後続 |
| REVIEW-05 | 承認後ロック/新版 | 後続 |
| REVIEW-06 | Approval Report/CDE状態対応 | 後続 |

### RECOVERY: 保存・復旧

優先度 P1 / 実装順 13 / 依存 PROJECT

完了条件: 30秒以内の復元と競合ケース、ブラウザ終了・ネットワーク断を検証。

| ID | 実装対象 | 状態 |
| --- | --- | --- |
| RECOVERY-01 | IndexedDB/暗号化/鍵管理 | 後続 |
| RECOVERY-02 | 差分Autosave/30秒間隔/履歴 | 後続 |
| RECOVERY-03 | Session/Browser/OS Crash Recovery | 後続 |
| RECOVERY-04 | 未保存警告/Restore UI | 後続 |
| RECOVERY-05 | Server Sync/Offline Queue | 後続 |
| RECOVERY-06 | Conflict Detection/Resolution | 後続 |
| RECOVERY-07 | Backup Recovery | 後続 |

### PERF: 大規模性能

優先度 P1 / 実装順 14 / 依存 SEL,DXF

完了条件: 100k図形30fps・p95入力100msを実測し、機器・図面・サンプル数を記録。

| ID | 実装対象 | 状態 |
| --- | --- | --- |
| PERF-01 | Render/Hit-test/OSnap/Window Index | 後続 |
| PERF-02 | R-tree等の既存ライブラリ評価 | 後続 |
| PERF-03 | 差分描画/Dirty Rectangle/rAF | 後続 |
| PERF-04 | Geometry/Import/DXF Worker | 後続 |
| PERF-05 | OffscreenCanvas評価 | 後続 |
| PERF-06 | LOD/Progressive Loading | 後続 |
| PERF-07 | Memory Budget/Entity Pool | 後続 |
| PERF-08 | Huge/View-only Mode/Profiler | 後続 |

### SURVEY: 測量座標

優先度 P2 / 実装順 15 / 依存 PROJECT

完了条件: 一次資料の版とCRSを固定し、既知点・逆変換誤差を検証。

| ID | 実装対象 | 状態 |
| --- | --- | --- |
| SURVEY-01 | XY/XYZ/座標点/測点/杭/境界点 | 後続 |
| SURVEY-02 | 座標一覧/CSV読書 | 後続 |
| SURVEY-03 | JGD2011/JGD2024 | 後続 |
| SURVEY-04 | 平面直角I-XIX/緯度経度/UTM | 後続 |
| SURVEY-05 | CRS認識・変換 | 後続 |
| SURVEY-06 | 座標注記/方位角/高低差/勾配 | 後続 |

### DELIVERY: 電子納品

優先度 P2 / 実装順 16 / 依存 SURVEY,LAYER,FRAME

完了条件: 発注者と年版を明示して公式要領に照合。基準更新を版管理。

| ID | 実装対象 | 状態 |
| --- | --- | --- |
| DELIVERY-01 | 国交省CAD製図基準レイヤー/命名/属性検査 | 後続 |
| DELIVERY-02 | 工種別・発注者別ルール | 後続 |
| DELIVERY-03 | SXF P21/SFC交換 | 後続 |
| DELIVERY-04 | DRAWING/PHOTOフォルダ | 後続 |
| DELIVERY-05 | XML管理ファイル生成・検証 | 後続 |
| DELIVERY-06 | 工事/路線/発注者Metadata | 後続 |
| DELIVERY-07 | 事前検査/エラー分類 | 後続 |
| DELIVERY-08 | ZIP/Hash/Signature/Timestamp | 後続 |

### CIVIL: 土木部品

優先度 P1 / 実装順 17 / 依存 BLOCK,FRAME

完了条件: 部品の寸法・基点・尺度・利用許諾と出力を検証。

| ID | 実装対象 | 状態 |
| --- | --- | --- |
| CIVIL-01 | 道路/側溝/縁石/ガードレール/標識 | 後続 |
| CIVIL-02 | 土工/法面/盛土/切土 | 後続 |
| CIVIL-03 | 仮設/仮囲い/足場/敷鉄板 | 後続 |
| CIVIL-04 | 重機/クレーン/バックホウ/ダンプ | 後続 |
| CIVIL-05 | 交通規制/コーン/バリケード/誘導員 | 後続 |
| CIVIL-06 | 河川/護岸/水路/樋門 | 後続 |
| CIVIL-07 | 下水/管/人孔/桝 | 後続 |
| CIVIL-08 | 橋梁/支承/伸縮装置/橋脚 | 後続 |
| CIVIL-09 | コンクリート/打継/目地/鉄筋記号 | 後続 |
| CIVIL-10 | 測量KBM/測点/杭/安全標識 | 後続 |

### ROAD: 2D道路線形

優先度 P2 / 実装順 17 / 依存 SURVEY,CIVIL

完了条件: 既知線形の測点とオフセットを照合。高度3D設計は対象外。

| ID | 実装対象 | 状態 |
| --- | --- | --- |
| ROAD-01 | IP/中心線/Stationing/Chainage | 後続 |
| ROAD-02 | 曲線/簡易クロソイド | 後続 |
| ROAD-03 | Offset Alignment/幅員 | 後続 |
| ROAD-04 | 中心線・測点注記/平面 | 後続 |
| ROAD-05 | 簡易縦断/横断/テンプレート | 後続 |
| ROAD-06 | 土量補助 | 後続 |

### TABLE: 数量・表・Excel

優先度 P2 / 実装順 18 / 依存 BLOCK,PROJECT

完了条件: 数量から根拠Entityへ辿れ、再計算・単位・数式入力を検証。

| ID | 実装対象 | 状態 |
| --- | --- | --- |
| TABLE-01 | TABLE/Row/Column/Cell/Merge | 後続 |
| TABLE-02 | Formula/Sum/Count | 後続 |
| TABLE-03 | 面積/長さ/Block集計 | 後続 |
| TABLE-04 | 材料/数量/座標/鉄筋表 | 後続 |
| TABLE-05 | CSV/Excel Export/Import | 後続 |
| TABLE-06 | Excel双方向更新と競合 | 後続 |
| TABLE-07 | 属性表/Selection・Layer・Blockから数量 | 後続 |
| TABLE-08 | 根拠Entityリンク | 後続 |

### XREF: 外部参照

優先度 P2 / 実装順 18 / 依存 DXF,PROJECT

完了条件: 相対パス・欠落・循環・再読込時の版整合を検証。

| ID | 実装対象 | 状態 |
| --- | --- | --- |
| XREF-01 | Attach DXF/Overlay | 後続 |
| XREF-02 | Relative Path/Path repair | 後続 |
| XREF-03 | Reload/Unload/Detach/Bind | 後続 |
| XREF-04 | Missing Reference/Reference Manager | 後続 |
| XREF-05 | XREF Layer/Clipping | 後続 |

### SHEET: Sheet Set

優先度 P2 / 実装順 18 / 依存 LAYOUT,PROJECT

完了条件: シート順・Fields・版を固定して一括出力を検証。

| ID | 実装対象 | 状態 |
| --- | --- | --- |
| SHEET-01 | Drawing Set/Sheet番号・名称 | 後続 |
| SHEET-02 | Layout関連付け/並び順 | 後続 |
| SHEET-03 | Batch Plot/Publish | 後続 |
| SHEET-04 | Sheet Index/横断Revision | 後続 |
| SHEET-05 | Drawing Fields/Template | 後続 |

### GIS: GIS参照

優先度 P2 / 実装順 18 / 依存 SURVEY

完了条件: 出典・利用条件・CRS・位置誤差を記録し、地図とCADの座標を検証。

| ID | 実装対象 | 状態 |
| --- | --- | --- |
| GIS-01 | 地理院地図/航空写真 | 後続 |
| GIS-02 | XYZ/WMS/WMTS | 後続 |
| GIS-03 | GeoJSON/KML/Shapefile/GeoPackage | 後続 |
| GIS-04 | CRS認識・変換 | 後続 |
| GIS-05 | Raster/Opacity/GIS Layer | 後続 |
| GIS-06 | 地籍/公図/筆界/オルソ/Drone | 後続 |

### CDE: 協力会社レビュー

優先度 P3 / 実装順 19 / 依存 REVIEW,ACL

完了条件: 期限・権限・版・配布先・監査を検証。DL禁止の実効範囲を明記。

| ID | 実装対象 | 状態 |
| --- | --- | --- |
| CDE-01 | Check-in/out/Lock | 後続 |
| CDE-02 | URL Share/View-only/Expiration | 後続 |
| CDE-03 | Watermark/Download設定・ログ | 後続 |
| CDE-04 | External/Contractor/Reviewer | 後続 |
| CDE-05 | Receipt/Share Log | 後続 |
| CDE-06 | Thread/Mention/Issue | 後続 |
| CDE-07 | Markup/Red Pen/Stamp | 後続 |
| CDE-08 | SharePoint/OneDrive | 後続 |

### MOBILE: PWA閲覧・朱書き

優先度 P3 / 実装順 19 / 依存 RECOVERY,CDE

完了条件: 8時間offlineと復帰時競合を実端末で検証。

| ID | 実装対象 | 状態 |
| --- | --- | --- |
| MOBILE-01 | PWA/Offline Viewer | 後続 |
| MOBILE-02 | Offline Markup/Cache | 後続 |
| MOBILE-03 | Touch Pan/Pinch/Pencil | 後続 |
| MOBILE-04 | Redline/Photo/Comment | 後続 |
| MOBILE-05 | QR図面表示 | 後続 |
| MOBILE-06 | Offline Queue/復帰同期 | 後続 |

### AI: AI Agent

優先度 P3 / 実装順 20 / 依存 DIM,DXF,PDF,QA,ACL

完了条件: 提案→プレビュー→人承認→適用を維持し、権限と確定時再検証を実施。

| ID | 実装対象 | 状態 |
| --- | --- | --- |
| AI-01 | 自然言語作図・編集・選択 | 後続 |
| AI-02 | Layout尺度配置 | 後続 |
| AI-03 | 未接続・重複・寸法漏れ・レイヤ違反候補 | 後続 |
| AI-04 | 変更説明/版比較要約 | 後続 |
| AI-05 | ACL付き図面検索/過去図面・社内標準RAG | 後続 |
| AI-06 | Layer分類/Block/数量候補 | 後続 |
| AI-07 | 自動検図/赤入れ修正提案 | 後続 |
| AI-08 | 図面説明生成 | 後続 |

### SKILL: 専門CAD Skills

優先度 P3 / 実装順 20 / 依存 AI

完了条件: 各Skillの入出力schema・失敗例・承認境界・回帰評価を固定。

| ID | 実装対象 | 状態 |
| --- | --- | --- |
| SKILL-01 | drawing/edit | 後続 |
| SKILL-02 | dimension/layer/layout | 後続 |
| SKILL-03 | dxf-compat/civil-layer-standard | 後続 |
| SKILL-04 | survey/road/temporary-work | 後続 |
| SKILL-05 | quantity/review/diff | 後続 |
| SKILL-06 | electronic-delivery | 後続 |

### QA: CAD品質検査

優先度 P1 / 実装順 10 / 依存 DIM,HATCH,BLOCK,LAYER

完了条件: エラー箇所へ移動でき、誤検知・見逃し・修正後再検査を評価。

| ID | 実装対象 | 状態 |
| --- | --- | --- |
| QA-01 | Duplicate/Zero Length/Micro Segment/Overlap | 後続 |
| QA-02 | Gap/Open Polyline/Self Intersection/Boundary | 後続 |
| QA-03 | Invalid Radius/Layer | 後続 |
| QA-04 | Layer/Linetype/Lineweight/Font/Text Heightルール | 後続 |
| QA-05 | Dimension Style/Scale/Frame/Drawing Number | 後続 |
| QA-06 | CRS/Missing XREF/Block/Font | 後続 |
| QA-07 | Outside Plot Area/Broken Dimension/Orphan Annotation | 後続 |

### BIM: BIM/CIM参照

優先度 P3 / 実装順 21 / 依存 SURVEY,XREF

完了条件: 参照モデルの版・座標・属性を保持。Authoringは対象外。

| ID | 実装対象 | 状態 |
| --- | --- | --- |
| BIM-01 | IFC Viewer/Property/Select | 後続 |
| BIM-02 | IFC→2D切出し | 後続 |
| BIM-03 | LandXML/CityGML参照 | 後続 |
| BIM-04 | Plan/Section | 後続 |
| BIM-05 | 2D-3Dリンク/差分 | 後続 |

### API: API・外部連携

優先度 P2 / 実装順 18 / 依存 ACL,PROJECT,DXF,PDF

完了条件: OpenAPI契約・認可・冪等性・レート制限・監査を検証。

| ID | 実装対象 | 状態 |
| --- | --- | --- |
| API-01 | Drawing/Entity/Layer/Transaction | 後続 |
| API-02 | Compare/Validation/PDF/DXF/Quantity | 後続 |
| API-03 | Webhook/Event | 後続 |
| API-04 | Rate Limit/Version/Idempotency/Audit | 後続 |
| API-05 | Excel API/CLI/MCP | 後続 |

### ACL: 管理・運用

優先度 P1 / 実装順 11 / 依存 なし

完了条件: IDOR・最小権限・監査・復元と設定変更時の影響を検証。

| ID | 実装対象 | 状態 |
| --- | --- | --- |
| ACL-01 | User/Group/Role/Organization | 後続 |
| ACL-02 | Project/Drawing ACL/Permission Matrix | 後続 |
| ACL-03 | Audit Viewer/Export/Access Log | 後続 |
| ACL-04 | Storage/Drawing統計 | 後続 |
| ACL-05 | Error/Performance/Data Quality Dashboard | 後続 |
| ACL-06 | Backup/Restore Status | 後続 |
| ACL-07 | AI Usage/Cost/Provider | 後続 |
| ACL-08 | Feature Flags/Maintenance/System Health | 後続 |

合計 263作業項目。次の着手対象はGRIP残件/EDIT精度、DIM角度・公差・Style管理とHATCH/BLOCKモデル。全領域の実装完了を意味しない。
