import { blockWorldEntities } from "./cad-affine.js";
import {
  ROLE_POLICIES,
  applyTransaction,
  arc,
  buildAiProposal,
  createDrawing,
  circle,
  ellipse,
  entityBounds,
  hitTest,
  line,
  measurements,
  polyline,
  proposalToTransaction,
  rect,
  sampleSpline,
  seedDrawing,
  spline,
  text,
  validateDrawing
} from "./cad-core.js";
import { parseCadCommand } from "./cad-command.js";
import { parseCadImport } from "./importers.js";
import { clearDrawing, exportDxfFile, exportDrawingFile, loadDrawing, saveDrawing } from "./storage.js";
import { exportDxf } from "./dxf-export.js";
import { arrayEntity, blockEntity, breakEntity, chamferLines, createBoundaryEntity, dimensionEntity, editPolyline, extendEntityToBoundary, filletLines, hatchEntity, joinLines, measurePoints, mirrorEntity, offsetEntity, transformEntity, trimEntityToBoundaries } from "./cad-advanced.js";
import { applyOrtho, DEFAULT_OSNAP_MODES, findOsnapPoint } from "./cad-draft-helpers.js";
import { buildSpatialIndex, queryBounds } from "./spatial-index.js";
import { boundsIntersectView, boundsVisibleInView, cameraToSavedView, canvasViewSize, keepCenterOnResize, parseSavedViews, rememberSavedView, savedViewToCamera, clampCameraScale, DEFAULT_CANVAS_SIZE, displayGridStep, fitCameraToBounds, formatZoomPercent, syncCanvasBackingSize } from "./cad-view.js";
import { entityGrips, moveGrip, selectableEntities, selectInBox } from "./cad-selection.js";
import { dimensionGeometry } from "./cad-dimension.js";
import { selectByPath } from "./cad-selection-tools.js";

const VIEW_MODES = new Set(["normal", "empty", "loading", "error"]);
const requestedViewMode = new URLSearchParams(location.search).get("state") ?? "normal";
const USER_SETTINGS_KEY = "mirai-web-cad-settings";
// 図面ごとの表示位置(ブラウザ単位の利便機能。図面データやサーバーには保存しない)。
const SAVED_VIEWS_KEY = "mirai-web-cad-views";
const LEGACY_AI_SETTINGS_KEY = "mirai-web-cad-ai-settings";
const GRID_INTERVALS = new Set([100, 250, 500, 1000]);
const DOCK_WIDTH_MIN = 260;
const DOCK_WIDTH_MAX = 380;
const THEMES = new Set(["system", "light", "dark"]);
const DEFAULT_USER_SETTINGS = Object.freeze({
  showGrid: true,
  snapEnabled: false,
  orthoEnabled: false,
  osnapEnabled: false,
  osnapModes: { ...DEFAULT_OSNAP_MODES },
  gridInterval: 500,
  commandLogLines: 2,
  dimensionOffset: 350,
  dimensionPrecision: 0,
  dimensionSuffix: "",
  dockWidth: 300,
  theme: "system"
});

/** OSnapモードの日本語表示名(設定ダイアログの正本)。 */
const OSNAP_MODE_LABELS = Object.freeze({
  endpoint: "端点",
  midpoint: "中点",
  center: "中心",
  quadrant: "四分点",
  intersection: "交点",
  perpendicular: "垂線",
  nearest: "近接点"
});

const RIBBON_TABS = [
  ["home", "ホーム"],
  ["insert", "挿入"],
  ["annot", "注釈"],
  ["view", "表示"],
  ["layers", "レイヤー"],
  ["review", "レビュー/承認"],
  ["ai", "AI提案"],
  ["output", "出力"]
];

const DOCK_TABS = [
  ["props", "プロパティ"],
  ["layers", "レイヤー"],
  ["ai", "AI提案"],
  ["aihistory", "AI履歴"],
  ["check", "検査/承認"]
];

const STATUS_TOGGLES = [
  ["showGrid", "グリッド"],
  ["snapEnabled", "スナップ"],
  ["orthoEnabled", "直交"],
  ["osnapEnabled", "OSnap"]
];

const OPERATION_LABELS = {
  lengthen: "全長変更",
  reverse: "方向反転",
  overkill: "完全重複削除",
  dimassoc: "連想寸法",
  dimhorizontal: "水平寸法",
  dimvertical: "垂直寸法",
  dimradius: "半径寸法",
  dimdiameter: "直径寸法",
  dimstyle: "寸法書式",
  stretch: "ストレッチ",
  explode: "分解",
  matchprop: "プロパティコピー",
  move: "移動",
  copy: "複写",
  rotate: "回転",
  scale: "尺度変更",
  offset: "オフセット",
  trim: "トリム",
  extend: "延長",
  mirror: "鏡像",
  array: "配列",
  break: "分割",
  join: "結合",
  chamfer: "面取り",
  fillet: "フィレット",
  boundary: "境界作成",
  pedit: "ポリライン編集",
  block: "ブロック化"
};

const ICONS = {
  select: "M7 3l11 10h-6l3 6-3 1.5-3-6-2 3.5V3z",
  line: "M4 20L20 4",
  pline: "M3 19l6-10 5 6 7-11",
  circle: "M12 4a8 8 0 1 1 0 16 8 8 0 0 1 0-16z",
  arc: "M5 17a9 9 0 0 1 14-10M5 17h4M5 17v-4M19 7h-4M19 7v4",
  ellipse: "M3 12a9 5.5 0 1 0 18 0 9 5.5 0 1 0-18 0z",
  spline: "M3 17c4-13 7 13 11 0s6-5 7-1M3 17h.01M21 16h.01",
  rect: "M4 6h16v12H4z",
  hatch: "M4 5h16v14H4zM9 5L4 10M15 5L4 16M20 7L7 19M20 13l-6 6",
  block: "M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zM12 12l8-4.5M12 12L4 7.5M12 12v9",
  move: "M12 3v18M3 12h18M12 3l-2 2.5M12 3l2 2.5M12 21l-2-2.5M12 21l2-2.5M3 12l2.5-2M3 12l2.5 2M21 12l-2.5-2M21 12l-2.5 2",
  copy: "M4 4h11v11H4zM9 9h11v11H9",
  rotate: "M20 12a8 8 0 1 1-2.9-6.2M20 3v4h-4",
  scale: "M4 20L20 4M4 20v-6M4 20h6M20 4h-6M20 4v6",
  offset: "M4 16V6a2 2 0 0 1 2-2h10M8 20v-8a2 2 0 0 1 2-2h10",
  trim: "M5 4l14 16M19 4L5 20M15 4h4v4",
  extend: "M4 4v16M9 12h11M16 8l4 4-4 4",
  mirror: "M5 20L19 4M5 20h4M5 20v-4M19 4h-4M19 4v4",
  array: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
  break: "M7 4v16M17 4v16M7 12h10",
  join: "M5 12h10M12 8l4 4-4 4M19 5v14",
  chamfer: "M4 19h6L20 9V4M10 19l10-10",
  fillet: "M4 20h5c6 0 11-5 11-11V4M9 20a11 11 0 0 0 11-11",
  boundary: "M5 5h14v14H5zM5 5l14 14",
  pedit: "M5 18l5-11 9 8M5 18h14M10 7v11",
  erase: "M4 16L13 7l5 5-7 7H7l-3-3zM11 9l5 5",
  undo: "M7 5L3 9l4 4M3 9h11a5 5 0 0 1 0 10h-4",
  redo: "M17 5l4 4-4 4M21 9H10a5 5 0 0 0 0 10h4",
  measure: "M3 17L17 3l4 4L7 21zM7 13l2 2M10 10l2 2M13 7l2 2",
  area: "M4 5h16v14H4zM4 19L20 5",
  idpt: "M12 3v18M3 12h18M8.5 12a3.5 3.5 0 1 0 7 0 3.5 3.5 0 1 0-7 0",
  dim: "M5 8v12M19 8v12M5 14h14M8 12l-3 2 3 2M16 12l3 2-3 2",
  text: "M5 5h14M12 5v14M9 19h6",
  grid: "M4 4h16v16H4zM4 10h16M4 16h16M10 4v16M16 4v16",
  snap: "M6 4v7a6 6 0 0 0 12 0V4M6 4h4v7M18 4h-4v7",
  ortho: "M5 19V5M5 19h14M8 19v-3M5 16h3",
  zoomext: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5M9 9h6v6H9z",
  zoomin: "M10 4a6 6 0 1 0 0 12 6 6 0 0 0 0-12zM14.5 14.5L20 20M10 7v6M7 10h6",
  zoomout: "M10 4a6 6 0 1 0 0 12 6 6 0 0 0 0-12zM14.5 14.5L20 20M7 10h6",
  pan: "M12 3l2.5 3h-5L12 3zM12 21l2.5-3h-5l2.5 3M3 12l3-2.5v5L3 12zM21 12l-3-2.5v5l3-2.5M12 6v12M6 12h12",
  layers: "M12 3l9 5-9 5-9-5 9-5zM3 14l9 5 9-5",
  check: "M4 12.5l5 5L20 6",
  approve: "M9 11V6.5a3 3 0 0 1 6 0V11M5.5 11h13l-1.2 6H6.7l-1.2-6zM4 21h16",
  ai: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3zM18.5 15l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9.9-2.6z",
  layout: "M4 4h16v16H4zM13 13h7v7h-7z",
  print: "M7 8V4h10v4M7 8H4v8h3M17 8h3v8h-3M7 13h10v7H7z",
  exp: "M12 15V4M8 7l4-4 4 4M4 20h16v-6",
  newfile: "M6 3h8l5 5v13H6zM14 3v5h5M12 11v6M9 14h6",
  open: "M3 6h6l2 2h10v11H3V6zM3 10h18",
  save: "M4 4h13l3 3v13H4zM8 4v5h7V4M7 12h10v8",
  settings: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1",
  import: "M12 3v11M8 10l4 4 4-4M4 20h16",
  reset: "M4 12a8 8 0 1 1 2.3 5.7M4 12v5h5"
};

const RIBBON = {
  home: [
    { label: "選択", buttons: [{ icon: "select", title: "選択", tool: "select", big: true }, { icon: "polyline", title: "フェンス選択", tool: "fence" }, { icon: "select", title: "投げ縄選択", tool: "lasso" }] },
    {
      label: "作図",
      buttons: [
        { icon: "line", title: "線", tool: "line" },
        { icon: "rect", title: "矩形", tool: "rect" },
        { icon: "circle", title: "円", tool: "circle" },
        { icon: "arc", title: "円弧", tool: "arc" },
        { icon: "ellipse", title: "楕円", tool: "ellipse" },
        { icon: "spline", title: "スプライン", tool: "spline" },
        { icon: "pline", title: "ポリライン", tool: "polyline" },
        { icon: "hatch", title: "ハッチング", tool: "hatch" }
      ]
    },
    {
      label: "修正",
      buttons: [
        { icon: "move", title: "移動", act: "beginOperation", arg: "move" },
        { icon: "copy", title: "複写", act: "beginOperation", arg: "copy" },
        { icon: "rotate", title: "回転", act: "beginOperation", arg: "rotate" },
        { icon: "scale", title: "尺度変更", act: "beginOperation", arg: "scale" },
        { icon: "offset", title: "オフセット", act: "beginOperation", arg: "offset" },
        { icon: "trim", title: "トリム", act: "beginOperation", arg: "trim" },
        { icon: "extend", title: "延長", act: "beginOperation", arg: "extend" },
        { icon: "mirror", title: "鏡像", act: "beginOperation", arg: "mirror" },
        { icon: "array", title: "配列", act: "beginOperation", arg: "array" },
        { icon: "break", title: "分割", act: "beginOperation", arg: "break" },
        { icon: "join", title: "結合", act: "beginOperation", arg: "join" },
        { icon: "chamfer", title: "面取り", act: "beginOperation", arg: "chamfer" },
        { icon: "fillet", title: "フィレット", act: "beginOperation", arg: "fillet" },
        { icon: "boundary", title: "境界作成", act: "beginOperation", arg: "boundary" },
        { icon: "pedit", title: "ポリライン編集", act: "beginOperation", arg: "pedit" },
        { icon: "erase", title: "削除", act: "deleteSelected" },
        { icon: "undo", title: "元に戻す", act: "undoLastTransaction" }
      ]
    },
    {
      label: "計測",
      buttons: [
        { icon: "measure", title: "計測", tool: "measure", big: true },
        { icon: "area", title: "面積", tool: "area" },
        { icon: "idpt", title: "ID点", tool: "id" }
      ]
    }
  ],
  insert: [
    { label: "読み込み", buttons: [{ icon: "import", title: "DXF / Mirai JSON読込", act: "triggerImport", big: true }] },
    { label: "ブロック", buttons: [{ icon: "block", title: "選択図形をブロック化", act: "beginOperation", arg: "block" }] }
  ],
  annot: [
    { label: "寸法", buttons: [{ icon: "dim", title: "寸法", tool: "dimension", big: true }] },
    { label: "文字", buttons: [{ icon: "text", title: "文字", tool: "text", big: true }] },
    { label: "ハッチング", buttons: [{ icon: "hatch", title: "ハッチング", tool: "hatch", big: true }] }
  ],
  view: [
    {
      label: "表示補助",
      buttons: [
        { icon: "grid", title: "グリッド", act: "toggleSetting", arg: "showGrid" },
        { icon: "snap", title: "スナップ", act: "toggleSetting", arg: "snapEnabled" },
        { icon: "ortho", title: "直交モード", act: "toggleSetting", arg: "orthoEnabled" },
        { icon: "snap", title: "OSnap", act: "toggleSetting", arg: "osnapEnabled" }
      ]
    },
    {
      label: "ズーム",
      buttons: [
        { icon: "zoomext", title: "全体表示", act: "fitToDrawing", big: true },
        { icon: "zoomin", title: "拡大", act: "zoomIn" },
        { icon: "zoomout", title: "縮小", act: "zoomOut" }
      ]
    },
    { label: "画面移動", buttons: [{ icon: "pan", title: "パン", tool: "pan", big: true }] }
  ],
  layers: [{ label: "レイヤー", buttons: [{ icon: "layers", title: "レイヤーパネル", act: "openDock", arg: "layers", big: true }] }],
  review: [
    { label: "検査", buttons: [{ icon: "check", title: "図面検査", act: "openDock", arg: "check", big: true }] },
    {
      label: "承認フロー",
      buttons: [
        { icon: "approve", title: "承認", act: "changeReviewState", arg: "approve", big: true },
        { icon: "exp", title: "レビュー提出", act: "changeReviewState", arg: "submit" },
        { icon: "newfile", title: "新版作成", act: "changeReviewState", arg: "new_version" }
      ]
    }
  ],
  ai: [{ label: "AI提案", buttons: [{ icon: "ai", title: "AIに依頼", act: "openDock", arg: "ai", big: true }] }],
  output: [
    { label: "レイアウト", buttons: [{ icon: "layout", title: "レイアウト", act: "goLayoutSpace", big: true }] },
    {
      label: "出力",
      buttons: [
        { icon: "print", title: "印刷 / PDF保存", act: "goLayoutSpace" },
        { icon: "exp", title: "JSON書出し", act: "exportDrawing" },
        { icon: "exp", title: "DXF書出し", act: "exportDrawingDxf" }
      ]
    }
  ]
};

const RIBBON_ACTIONS = {
  beginOperation: (arg) => beginOperation(arg),
  deleteSelected: () => deleteSelected(),
  undoLastTransaction: () => undoLastTransaction(),
  toggleSetting: (arg) => toggleSetting(arg),
  triggerImport: () => triggerImport(),
  fitToDrawing: () => fitToDrawing(),
  zoomIn: () => zoomIn(),
  zoomOut: () => zoomOut(),
  openDock: (arg) => openDock(arg),
  changeReviewState: (arg) => changeReviewState(arg),
  goLayoutSpace: () => goLayoutSpace(),
  exportDrawing: () => exportDrawing(),
  exportDrawingDxf: () => exportDrawingDxf()
};

const state = {
  drawing: loadDrawing() ?? seedDrawing(),
  tool: "select",
  currentLayerId: "layer-structure",
  _selectedIds: [],
  previousSelection: [],
  get selectedIds() { return this._selectedIds; },
  set selectedIds(ids) {
    const next = [...new Set(ids)];
    if (next.length !== this._selectedIds.length || next.some((id, index) => id !== this._selectedIds[index])) this.previousSelection = [...this._selectedIds];
    this._selectedIds = next;
  },
  get selectedId() { return this.selectedIds.at(-1) ?? null; },
  set selectedId(id) { this.selectedIds = id ? [id] : []; },
  selectionBox: null,
  pathDrawing: false,
  draftPoints: [],
  previewProposal: null,
  previewRunId: null,
  aiBusy: false,
  aiError: null,
  aiEngine: null,
  camera: { x: 50, y: 40, scale: 0.075 },
  fitPending: false,
  // 起動直後やAPIからの図面差替え後の描画で、表示に収まらない図面だけをZOOM EXTENTSする。
  outOfViewFitPending: true,
  // 同じ図面をAPIから再同期した後、新しい図形が現在の表示から外れていないかを確かめる(記憶位置は使わない)。
  boundsRecheckPending: false,
  // 利用者の操作(ズーム・パン・全体表示)で表示が変わり、図面ごとの表示位置として保存すべき状態。
  viewChanged: false,
  // Canvas寸法が変わったときの追従方法を決める直近のカメラの由来。
  // "fit": 全体表示直後(その範囲で再fit) / "restored": 記憶位置の復元直後(中心を保つ) /
  // "default"・"user": 起動時既定・利用者操作後(従来どおりカメラを動かさない)。
  cameraMode: "default",
  /** @type {{ minX: number, minY: number, maxX: number, maxY: number }[]} */
  fitBounds: [],
  // 直近のfitが利用者の明示操作(全体表示・ZOOM E・Import等)か、起動時の自動fitか。
  fitExplicit: false,
  commandLog: ["起動: Mirai Web CAD"],
  commandHistory: [],
  commandHistoryIndex: 0,
  undoStack: [],
  redoStack: [],
  focusTarget: null,
  drag: null,
  panStart: null,
  measurement: null,
  viewMode: VIEW_MODES.has(requestedViewMode) ? requestedViewMode : "normal",
  apiStatus: { state: "idle", message: "未確認", connected: false, roleLocked: false },
  settings: loadUserSettings(),
  ribbonTab: "home",
  space: "model",
  dock: "props",
  pendingOperation: null,
  layoutDraft: null,
  aiStatus: { known: false, enabled: false, provider: null, model: null },
  saveStatus: "idle"
};

function activeLayoutDrawing(drawing) {
  return state.layoutDraft ? { ...drawing, layout: { ...drawing.layout, ...state.layoutDraft } } : drawing;
}

const app = document.querySelector("#app");

function render() {
  const drawing = activeDrawing();
  const entityIds = new Set(drawing.entities.map((entity) => entity.id));
  state.selectedIds = state.selectedIds.filter((id) => entityIds.has(id));
  const selected = drawing.entities.find((entity) => entity.id === state.selectedId);
  const policy = ROLE_POLICIES[drawing.currentRole] ?? ROLE_POLICIES.viewer;
  const commandLogClass = `command-log-${state.settings.commandLogLines}`;
  app.className = `app-shell ${commandLogClass}`;
  app.innerHTML = `
    <header class="topbar">
      <div class="topbar-brand">
        <svg class="brand-mark" width="32" height="32" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
          <rect width="32" height="32" rx="6" fill="#10253c"></rect>
          <rect x="6" y="6" width="20" height="20" rx="2" fill="none" stroke="#00a3b8" stroke-width="2"></rect>
          <path d="M6 14 H26 M14 6 V26" stroke="#00a3b8" stroke-width="1.5"></path>
          <circle cx="20" cy="20" r="2" fill="#00a3b8"></circle>
        </svg>
        <div>
          <p class="eyebrow">CIVIL ENGINEERING 2D CAD</p>
          <h1>Mirai Web CAD</h1>
        </div>
        <div class="quick-access" role="group" aria-label="クイックアクセス">
          <button id="newDrawingBtn" class="quick-btn" type="button" title="新規図面${policy.canEdit ? "" : `（${policy.label}は利用できません）`}" aria-label="新規図面${policy.canEdit ? "" : `（${policy.label}は利用できません）`}" ${policy.canEdit ? "" : "disabled"}>${icon("newfile", 20)}</button>
          <button id="importBtn" class="quick-btn" type="button" title="開く（DXF / Mirai JSON）${policy.canEdit ? "" : `（${policy.label}は利用できません）`}" aria-label="開く${policy.canEdit ? "" : `（${policy.label}は利用できません）`}" ${policy.canEdit ? "" : "disabled"}>${icon("open", 20)}</button>
          <input id="importFile" type="file" accept=".json,.dxf,application/json" hidden />
          <button id="quickSaveBtn" class="quick-btn" type="button" title="上書き保存${policy.canEdit ? "" : `（${policy.label}は利用できません）`}" aria-label="上書き保存${policy.canEdit ? "" : `（${policy.label}は利用できません）`}" ${policy.canEdit ? "" : "disabled"}>${icon("save", 20)}</button>
          <button id="undoBtn" class="quick-btn" type="button" title="元に戻す" aria-label="元に戻す" ${state.undoStack.length ? "" : "disabled"}>${icon("undo", 20)}</button>
          <button id="redoBtn" class="quick-btn" type="button" title="やり直す" aria-label="やり直す" ${state.redoStack.length ? "" : "disabled"}>${icon("redo", 20)}</button>
          <button id="quickPrintBtn" class="quick-btn" type="button" title="印刷 / レイアウト" aria-label="印刷">${icon("print", 20)}</button>
          <button id="resetBtn" class="quick-btn danger" type="button" title="デモ初期化" aria-label="デモ初期化">${icon("reset", 20)}</button>
        </div>
      </div>
      <div class="topbar-actions">
        <div class="drawing-meta" role="group" aria-label="図面状態">
          <strong>${escapeHtml(drawing.name)}</strong>
          <span>Version ${escapeHtml(drawing.version)}</span>
          <span>${escapeHtml(stateLabel(drawing.state))}</span>
          <span class="save-status ${saveStatusInfo().key}" title="${escapeHtml(saveStatusInfo().description)}" aria-label="保存状態: ${escapeHtml(
            saveStatusInfo().label
          )}（${escapeHtml(saveStatusInfo().description)}）">${escapeHtml(saveStatusInfo().label)}</span>
          <label>
            権限
            <span class="role-badge">${escapeHtml(policy.label)}</span>
            <select
              id="roleSelect"
              aria-label="権限を切替${state.apiStatus.roleLocked ? `（認証済みの権限「${policy.label}」に固定されています。変更するにはCloudflare Accessでログインし直してください）` : ""}"
              title="${state.apiStatus.roleLocked ? `認証済みの権限「${policy.label}」に固定されています。変更するにはログインが必要です。` : "権限を切替"}"
              ${state.apiStatus.roleLocked ? "disabled" : ""}
            >
              ${Object.entries(ROLE_POLICIES)
                .map(
                  ([role, policy]) =>
                    `<option value="${role}" ${state.drawing.currentRole === role ? "selected" : ""}>${policy.label}</option>`
                )
                .join("")}
            </select>
          </label>
        </div>
        <button id="settingsBtn" class="topbar-command" type="button" title="システム設定" aria-label="システム設定">
          <span aria-hidden="true">⚙</span><span>設定</span>
        </button>
      </div>
    </header>

    <nav class="ribbon-tabs" aria-label="リボンタブ">
      ${RIBBON_TABS.map(
        ([key, label]) =>
          `<button type="button" data-ribbon-tab="${key}" class="ribbon-tab ${state.ribbonTab === key ? "active" : ""}" aria-pressed="${state.ribbonTab === key}">${escapeHtml(label)}</button>`
      ).join("")}
    </nav>
    <div class="ribbon" role="toolbar" aria-label="リボン">
      ${(RIBBON[state.ribbonTab] ?? [])
        .map(
          (group) => `
        <div class="ribbon-group">
          <div class="ribbon-group-buttons">${group.buttons.map((entry) => ribbonButtonHtml(entry, policy)).join("")}</div>
          <div class="ribbon-group-label">${escapeHtml(group.label)}</div>
        </div>
      `
        )
        .join("")}
    </div>

    <main class="workspace">
      <section class="canvas-panel" aria-label="CADキャンバス">
        <div class="space-tabs" role="group" aria-label="モデル/レイアウト空間を切替">
          <button type="button" data-space="model" class="space-tab ${state.space === "model" ? "active" : ""}" aria-pressed="${state.space === "model"}">モデル</button>
          <button type="button" data-space="layout" class="space-tab ${state.space === "layout" ? "active" : ""}" aria-pressed="${state.space === "layout"}">レイアウト1</button>
          <div class="spacer"></div>
          <span class="zoom-readout">${zoomReadoutText()}</span>
          <button id="fitBtn" type="button" title="図面範囲表示" aria-label="図面範囲表示">全体表示</button>
        </div>
        ${state.space === "layout" ? layoutSpaceHtml(activeLayoutDrawing(drawing)) : modelSpaceHtml(drawing)}
      </section>
      <div
        id="dockResizeHandle"
        class="dock-resize-handle"
        role="separator"
        aria-label="右パネル幅を調整"
        aria-orientation="vertical"
        aria-valuemin="${DOCK_WIDTH_MIN}"
        aria-valuemax="${DOCK_WIDTH_MAX}"
        aria-valuenow="${state.settings.dockWidth}"
        tabindex="0"
        title="ドラッグまたは左右キーで幅を調整。ダブルクリックで初期化"
      ><span aria-hidden="true">⋮</span></div>
      <aside class="dock" aria-label="図面情報パネル">
        <div class="dock-tabs" role="group" aria-label="パネルを切替">
          ${DOCK_TABS.map(
            ([key, label]) =>
              `<button type="button" data-dock="${key}" class="dock-tab ${state.dock === key ? "active" : ""}" aria-pressed="${state.dock === key}">${escapeHtml(label)}</button>`
          ).join("")}
        </div>
        <div class="dock-body">${dockBodyHtml(drawing, selected)}</div>
      </aside>
    </main>

    <footer class="command-line ${commandLogClass}" aria-label="コマンドライン">
      <div class="command-history" role="log" aria-label="コマンドログ" aria-live="polite" tabindex="0">
        ${state.commandLog
          .slice(-state.settings.commandLogLines)
          .map((lineValue) => `<div>${escapeHtml(lineValue)}</div>`)
          .join("")}
      </div>
      <form id="commandForm" class="command-form">
        <span aria-hidden="true">&gt;</span>
        <input id="commandInput" type="text" autocomplete="off" spellcheck="false" placeholder="Command" aria-label="コマンド入力" />
        <button type="submit" title="コマンド実行" aria-label="コマンド実行">↵</button>
      </form>
    </footer>

    ${newDrawingDialogHtml()}
    ${settingsDialogHtml(drawing)}
  `;

  /** @type {HTMLElement} */ (document.querySelector(".workspace")).style.setProperty("--dock-width", `${state.settings.dockWidth}px`);
  if (state.space === "layout") applyLayoutGeometry(activeLayoutDrawing(drawing));
  bindEvents();
  observeCanvasResize();
  try {
    drawCanvas();
  } catch (error) {
    // 1件の壊れた図形でCanvas描画が例外を投げると、render全体が失敗して以後
    // すべての操作が例外になる(サイトデータを消すまで復旧不能)。描画だけを隔離し、
    // 失敗は画面に出してUIを稼働させ続ける。
    console.error("drawCanvas failed", error);
    state.canvasError = error instanceof Error ? error.message : String(error);
  }
  announceLatestCommand();
}

// 最新のコマンドログをスクリーンリーダー向け領域へ流す。ログはこのアプリ唯一の
// エラー通知経路(権限拒否・Import失敗・保存失敗など)だが、コマンドログ自体は
// renderのたびに作り直されるため、中の要素に aria-live を付けても読み上げられない。
// #sr-announcer は #app の外にあり作り直されないので、ここへ同じ文言を流す。
let lastAnnouncedCommand = null;
function announceLatestCommand() {
  const latest = state.commandLog.at(-1) ?? "";
  if (latest === lastAnnouncedCommand) return;
  lastAnnouncedCommand = latest;
  const announcer = document.getElementById("sr-announcer");
  if (announcer) announcer.textContent = latest;
}

function icon(name, size = 14) {
  const d = ICONS[name] ?? "";
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path></svg>`;
}

const RIBBON_EDIT_TOOLS = new Set(["line", "rect", "circle", "arc", "ellipse", "spline", "polyline", "hatch", "dimension", "text"]);
const RIBBON_EDIT_ACTIONS = new Set(["beginOperation", "deleteSelected", "undoLastTransaction", "triggerImport"]);

function ribbonButtonDisabled(entry, policy) {
  if (entry.tool) return RIBBON_EDIT_TOOLS.has(entry.tool) && !policy.canEdit;
  if (entry.act === "changeReviewState") return entry.arg === "submit" ? !policy.canEdit : !policy.canApprove;
  if (entry.act && RIBBON_EDIT_ACTIONS.has(entry.act)) return !policy.canEdit;
  return false;
}

function ribbonButtonHtml(entry, policy) {
  const active = entry.tool ? state.tool === entry.tool : false;
  const attrs = entry.tool
    ? `data-tool="${escapeHtml(entry.tool)}"`
    : `data-act="${escapeHtml(entry.act)}"${entry.arg !== undefined ? ` data-arg="${escapeHtml(String(entry.arg))}"` : ""}`;
  const disabled = ribbonButtonDisabled(entry, policy);
  const reason = disabled ? `（${policy.label}は利用できません）` : "";
  const labelText = `${entry.title}${reason}`;
  return `<button type="button" ${attrs} class="ribbon-btn${entry.big ? " big" : ""}${active ? " active" : ""}" title="${escapeHtml(labelText)}" aria-label="${escapeHtml(labelText)}" ${disabled ? "disabled" : ""}>${icon(entry.icon, entry.big ? 20 : 14)}<span>${escapeHtml(entry.title)}</span></button>`;
}

function modelSpaceHtml(drawing) {
  return `
    <div class="canvas-toolbar">
      <label>
        レイヤー
        <select id="layerSelect" aria-label="現在レイヤー">
          ${drawing.layers
            .map(
              (layer) =>
                `<option value="${escapeHtml(layer.id)}" ${state.currentLayerId === layer.id ? "selected" : ""}>${escapeHtml(
                  layer.name
                )}</option>`
            )
            .join("")}
        </select>
      </label>
      <span>${escapeHtml(state.tool.toUpperCase())}</span>
      <span>${state.selectedId ? `選択: ${state.selectedIds.length}件 / ${escapeHtml(state.selectedId)}` : "未選択"}</span>
      <span>表示状態: ${escapeHtml(viewModeLabel(state.viewMode))}</span>
      <span>SNAP: ${state.settings.snapEnabled ? `${state.settings.gridInterval} ${drawing.unit}` : "OFF"}</span>
    </div>
    <canvas id="cadCanvas" width="1180" height="760" tabindex="0" aria-label="作図キャンバス"></canvas>
    ${statusBarHtml(drawing)}
  `;
}

function layoutSpaceHtml(drawing) {
  return `
    <form id="layoutForm" class="layout-toolbar">
      <label>用紙<select name="paper">${["A4", "A3", "A2", "A1"]
        .map((paper) => `<option ${drawing.layout?.paper === paper ? "selected" : ""}>${paper}</option>`)
        .join("")}</select></label>
      <label>方向<select name="orientation"><option value="landscape" ${
        drawing.layout?.orientation !== "portrait" ? "selected" : ""
      }>横</option><option value="portrait" ${drawing.layout?.orientation === "portrait" ? "selected" : ""}>縦</option></select></label>
      <label>縮尺 1:<input name="scale" type="number" min="1" value="${escapeHtml(drawing.layout?.scale ?? 100)}" /></label>
      <label>余白 mm<input name="margin" type="number" min="0" value="${escapeHtml(drawing.layout?.margin ?? 10)}" /></label>
      <label>表題<input name="title" maxlength="100" value="${escapeHtml(drawing.layout?.title ?? drawing.name)}" /></label>
      <div class="spacer"></div>
      <button type="submit">設定保存</button>
      <button id="printBtn" type="button">PDF / 印刷</button>
    </form>
    <div class="layout-stage">${layoutPreviewHtml(drawing)}</div>
    ${statusBarHtml(drawing)}
  `;
}

const PAPER_SIZES_MM = { A4: [210, 297], A3: [297, 420], A2: [420, 594], A1: [594, 841] };

function layoutGeometry(drawing) {
  const landscape = drawing.layout?.orientation !== "portrait";
  const [short, long] = PAPER_SIZES_MM[drawing.layout?.paper] ?? PAPER_SIZES_MM.A3;
  const pageW = landscape ? long : short;
  const pageH = landscape ? short : long;
  const margin = Math.max(4, Math.min(24, Number(drawing.layout?.margin ?? 10)));
  const titleblockWidth = Math.min(pageW - margin * 2, 240);
  return { landscape, pageW, pageH, margin, titleblockWidth };
}

function layoutPreviewHtml(drawing) {
  const { landscape } = layoutGeometry(drawing);
  const scale = drawing.layout?.scale ?? 100;
  return `
    <div class="layout-page" data-layout-page="1">
      <div class="layout-margin" data-layout-margin="1"></div>
      <div class="layout-viewport" data-layout-viewport="1">
        <span>ビューポート　モデル空間 1:${escapeHtml(String(scale))}<br><span class="paper-note">${escapeHtml(
          drawing.layout?.paper ?? "A3"
        )} ${landscape ? "横" : "縦"}</span></span>
      </div>
      <div class="layout-titleblock" data-layout-titleblock="1">
        <div class="row single"><div class="cell label">${escapeHtml(drawing.layout?.title || drawing.name)}</div></div>
        <div class="row split"><div class="cell label">版</div><div class="cell">v${escapeHtml(
          drawing.version
        )} / ${escapeHtml(stateLabel(drawing.state))}</div></div>
        <div class="row split"><div class="cell label">縮尺</div><div class="cell">1:${escapeHtml(String(scale))}</div></div>
        <div class="row split"><div class="cell label">作成</div><div class="cell">${escapeHtml(
          ROLE_POLICIES[drawing.currentRole]?.label ?? drawing.currentRole
        )}</div></div>
      </div>
    </div>
  `;
}

function applyLayoutGeometry(drawing) {
  const page = /** @type {HTMLElement | null} */ (document.querySelector("[data-layout-page]"));
  if (!page) return;
  const { pageW, pageH, margin, titleblockWidth } = layoutGeometry(drawing);
  page.style.width = `${pageW}px`;
  page.style.height = `${pageH}px`;

  const marginEl = /** @type {HTMLElement | null} */ (document.querySelector("[data-layout-margin]"));
  if (marginEl) marginEl.style.inset = `${margin}px`;

  const viewport = /** @type {HTMLElement | null} */ (document.querySelector("[data-layout-viewport]"));
  if (viewport) {
    viewport.style.left = `${margin + 12}px`;
    viewport.style.top = `${margin + 12}px`;
    viewport.style.right = `${margin + 12}px`;
    viewport.style.bottom = `${margin + 96}px`;
  }

  const titleblock = /** @type {HTMLElement | null} */ (document.querySelector("[data-layout-titleblock]"));
  if (titleblock) {
    titleblock.style.right = `${margin}px`;
    titleblock.style.bottom = `${margin}px`;
    titleblock.style.width = `${titleblockWidth}px`;
  }
}

function statusBarHtml(drawing) {
  return `
    <div class="status-bar" role="group" aria-label="ステータスバー">
      <span id="coordReadout" class="coord">0.0, 0.0</span>
      <div class="divider"></div>
      <div class="status-toggles" role="group" aria-label="作図補助トグル">
        ${STATUS_TOGGLES.map(
          ([key, label]) =>
            `<button type="button" data-toggle="${key}" class="status-toggle" aria-pressed="${state.settings[key] ? "true" : "false"}">${escapeHtml(
              label
            )}</button>`
        ).join("")}
      </div>
      <div class="spacer"></div>
      <span id="scaleReadout">縮尺 ${state.space === "layout" ? `1:${escapeHtml(String(drawing.layout?.scale ?? 100))}` : zoomReadoutText()}</span>
      <div class="divider"></div>
      <span>単位 ${escapeHtml(drawing.unit)}</span>
      <div class="divider"></div>
      <span>図形 ${drawing.entities.length}</span>
    </div>
  `;
}

function dockBodyHtml(drawing, selected) {
  if (state.dock === "layers") return layersDockHtml(drawing);
  if (state.dock === "ai") return aiDockHtml();
  if (state.dock === "aihistory") return aiHistoryDockHtml(drawing);
  if (state.dock === "check") return checkDockHtml();
  return propsDockHtml(drawing, selected);
}

function propsDockHtml(drawing, selected) {
  const currentOperation = state.pendingOperation ?? "move";
  const policy = ROLE_POLICIES[drawing.currentRole] ?? ROLE_POLICIES.viewer;
  return `
    <section>
      <h2>CAD Operations</h2>
      <form id="operationForm" class="compact-form">
        <label>操作
          <select name="operation" aria-label="図形操作">
            ${Object.entries(OPERATION_LABELS)
              .map(([value, label]) => `<option value="${value}" ${currentOperation === value ? "selected" : ""}>${label}</option>`)
              .join("")}
          </select>
        </label>
        <label>値<input name="value" aria-label="操作値" placeholder="移動 500,0 / 面取り 相手ID 100 / PEDIT MOVE 2 100,200" /></label>
        <button type="submit" ${selected ? "" : "disabled"}>選択図形へ適用</button>
      </form>
      <p class="measure-result">${
        state.measurement
          ? `距離 ${formatNumber(state.measurement.distance)} / ΔX ${formatNumber(state.measurement.dx)} / ΔY ${formatNumber(
              state.measurement.dy
            )} / ${formatNumber(state.measurement.angle)}°`
          : "計測結果なし"
      }</p>
    </section>
    <section>
      <h2>Properties</h2>
      ${
        selected
          ? `
        <form id="propertyForm" class="compact-form">
          <dl><dt>ID</dt><dd>${escapeHtml(selected.id)}</dd><dt>種類</dt><dd>${escapeHtml(selected.type)}</dd></dl>
          ${selected.type === "dimension" ? `<dl><dt>寸法値</dt><dd>${escapeHtml(dimensionGeometry(selected).label)}</dd><dt>参照</dt><dd>${selected.associationStatus === "broken" ? "参照切れ" : selected.references ? "連想" : "独立"}</dd></dl>` : ""}
          <label>レイヤー<select name="layerId">${drawing.layers
            .map(
              (layer) =>
                `<option value="${escapeHtml(layer.id)}" ${selected.layerId === layer.id ? "selected" : ""}>${escapeHtml(layer.name)}</option>`
            )
            .join("")}</select></label>
          <label>線幅<input name="strokeWidth" type="number" min="0.5" max="20" step="0.5" value="${escapeHtml(
            selected.style?.strokeWidth ?? 2
          )}" /></label>
          ${
            selected.type === "block"
              ? selected.definitionId ? (selected.attributeReferences ?? []).map((attribute, index) => `<label>${escapeHtml(attribute.tag)}<input name="blockAttribute_${index}" value="${escapeHtml(attribute.value)}" /></label>`).join("") : `<label>ブロック属性<input name="blockAttributes" value="${escapeHtml(
                  Object.entries(selected.attributes ?? {})
                    .map(([key, value]) => `${key}=${value}`)
                    .join(";")
                )}" placeholder="番号=1;種別=桝" /></label>`
              : ""
          }
          <button type="submit" ${state.selectedIds.length > 1 ? 'disabled title="プロパティ編集は1件選択時に利用できます"' : ""}>プロパティ更新</button>
        </form>`
          : `<p class="empty-note">図形を選択してください。</p>`
      }
    </section>
    <section>
      <h2>Quantity</h2>
      ${quantityHtml()}
    </section>
    <section>
      <h2>Comments</h2>
      ${commentsSectionHtml(drawing, selected, policy)}
    </section>
  `;
}

function commentsSectionHtml(drawing, selected, policy) {
  const comments = (drawing.comments ?? []).slice().reverse();
  const canComment = policy.canComment && drawing.state !== "approved";
  const disabledReason = canComment
    ? ""
    : drawing.state === "approved"
      ? "（承認済み図面にはコメントを追加できません）"
      : `（${policy.label}は利用できません）`;
  return `
    ${
      comments.length
        ? `<ul class="issue-list comment-list">
            ${comments
              .map(
                (comment) => `
              <li>
                <b>${escapeHtml(comment.author)}</b> <span class="minor">${escapeHtml(formatDateTime(comment.at))}</span>
                ${comment.entityId ? `<br /><span class="minor">対象: ${escapeHtml(comment.entityId)}</span>` : ""}
                <br />${escapeHtml(comment.body)}
              </li>
            `
              )
              .join("")}
          </ul>`
        : `<p class="empty-note">コメントはまだありません。</p>`
    }
    <form id="commentForm" class="compact-form">
      <label>本文<textarea name="body" rows="2" maxlength="1000" placeholder="コメントを入力" ${canComment ? "" : "disabled"}></textarea></label>
      ${
        selected
          ? `<label><input type="checkbox" name="attachToSelected" checked ${canComment ? "" : "disabled"} /> 選択図形（${escapeHtml(selected.id)}）に紐付け</label>`
          : ""
      }
      <button type="submit" title="コメントを追加${disabledReason}" aria-label="コメントを追加${disabledReason}" ${canComment ? "" : "disabled"}>コメントを追加</button>
    </form>
  `;
}

function layersDockHtml(drawing) {
  return `
    <section>
      <h2>Layers</h2>
      <form id="layerForm" class="layer-create-form">
        <input name="name" maxlength="80" placeholder="新規レイヤー名" aria-label="新規レイヤー名" required />
        <input name="color" type="color" value="#246b9f" aria-label="新規レイヤー色" />
        <button type="submit" title="レイヤー追加" aria-label="レイヤー追加">＋</button>
      </form>
      <div class="layer-list">
        ${drawing.layers
          .map(
            (layer) => `
              <label class="layer-row">
                <input type="checkbox" data-layer-visible="${escapeHtml(layer.id)}" ${layer.visible ? "checked" : ""} />
                <input class="swatch" data-layer-color="${escapeHtml(layer.id)}" type="color" value="${safeColor(layer.color)}" aria-label="${escapeHtml(
                  layer.name
                )}の色" />
                <span>${escapeHtml(layer.name)}</span>
                <button data-layer-lock="${escapeHtml(layer.id)}" class="mini ${
                  layer.locked ? "locked" : ""
                }" title="ロック切替">${layer.locked ? "Lock" : "Open"}</button>
              </label>
            `
          )
          .join("")}
      </div>
    </section>
  `;
}

function aiDockHtml() {
  return `
    <section>
      <h2>AI Agent</h2>
      ${
        state.aiStatus.known && !state.aiStatus.enabled
          ? `<p class="empty-note">外部LLMは未設定です。「重機/クレーン」「標準/整理」「注記/寸法」等のルールベース提案のみ動作します。</p>`
          : ""
      }
      <textarea id="aiPrompt" rows="3" placeholder="例: クレーンの重機範囲を追加" ${state.aiBusy ? "disabled" : ""}></textarea>
      <div class="button-row">
        <button id="planAiBtn" ${state.aiBusy ? "disabled" : ""}>${state.aiBusy ? "生成中..." : "Preview"}</button>
        <button id="applyAiBtn" ${state.previewProposal?.status === "planned" && !state.aiBusy ? "" : "disabled"}>承認して適用</button>
      </div>
      ${state.aiError ? `<p class="ai-preview-error">${escapeHtml(state.aiError)}</p>` : ""}
      ${
        state.aiEngine === "llm" && state.previewProposal
          ? `<p class="empty-note">エンジン: LLM(${escapeHtml(state.previewProposal.provider ?? "-")} / ${escapeHtml(state.previewProposal.model ?? "-")})</p>`
          : ""
      }
      <div id="aiPreview" class="preview-box">${proposalHtml()}</div>
    </section>
  `;
}

function aiHistoryDockHtml(drawing) {
  const events = (drawing.commandEvents ?? []).filter((event) => event.source === "agent").slice().reverse();
  if (events.length === 0) {
    return `
      <section>
        <h2>AI Operation History</h2>
        <p class="empty-note">AIによる変更履歴はまだありません。</p>
      </section>
    `;
  }
  return `
    <section>
      <h2>AI Operation History</h2>
      <p class="empty-note">${events.length}件（新しい順）</p>
      <ul class="issue-list ai-history-list">
        ${events
          .map((event) => {
            const impact = summarizeCommands(event.commands ?? []);
            return `
              <li>
                <b>${escapeHtml(formatDateTime(event.at))}</b><br />
                <span>${escapeHtml(event.label ?? "AI提案")}</span><br />
                <span class="minor">追加 ${impact.add} / 更新 ${impact.update} / 削除 ${impact.delete}</span>
                ${event.beforeHash === event.afterHash ? '<br /><span class="minor">図形の変更なし</span>' : ""}
                ${(event.warnings ?? []).map((warning) => `<br /><span class="warn">${escapeHtml(warning)}</span>`).join("")}
              </li>
            `;
          })
          .join("")}
      </ul>
    </section>
  `;
}

function summarizeCommands(commands) {
  const add = commands.filter((command) => command.op === "add" || command.op === "add_layer").length;
  const update = commands.filter((command) => ["update", "update_layer", "update_layout", "update_drawing_meta"].includes(command.op)).length;
  const del = commands.filter((command) => command.op === "delete" || command.op === "delete_layer").length;
  return { add, update, delete: del };
}

function formatDateTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value ?? "-") : date.toLocaleString("ja-JP");
}

function checkDockHtml() {
  return `
    <section>
      <h2>State Review</h2>
      <div class="segmented" role="group" aria-label="表示状態を切替">
        ${stateButton("normal", "正常")}
        ${stateButton("empty", "空")}
        ${stateButton("loading", "Loading")}
        ${stateButton("error", "Error")}
      </div>
      <div class="api-status ${state.apiStatus.state}">
        <span>API</span>
        <b>${escapeHtml(state.apiStatus.message)}</b>
      </div>
      <button id="apiHealthBtn" class="wide">API Health</button>
    </section>
    <section>
      <h2>Inspection</h2>
      ${inspectionHtml()}
      <div class="button-row">
        <button id="reviewBtn" ${reviewActionDisabled("submit") ? "disabled" : ""}>レビュー提出</button>
        <button id="approveBtn" ${reviewActionDisabled("approve") ? "disabled" : ""}>承認</button>
        <button id="newVersionBtn" ${reviewActionDisabled("new_version") ? "disabled" : ""}>新版</button>
      </div>
    </section>
  `;
}

function reviewActionDisabled(action) {
  const policy = ROLE_POLICIES[state.drawing.currentRole] ?? ROLE_POLICIES.viewer;
  const allowed = action === "submit" ? policy.canEdit : policy.canApprove;
  if (!allowed) return true;
  return state.apiStatus.state !== "ok";
}

function newDrawingDialogHtml() {
  return `
    <dialog id="newDrawingDialog" aria-labelledby="newDrawingTitle">
      <form id="newDrawingForm" method="dialog">
        <header>
          <h2 id="newDrawingTitle">新規図面</h2>
          <button id="closeNewDrawingBtn" type="button" class="dialog-close" aria-label="閉じる" title="閉じる">×</button>
        </header>
        <label>図面名<input id="newDrawingName" name="name" maxlength="100" required value="新規図面" /></label>
        <label>単位<select name="unit"><option value="mm">mm</option><option value="m">m</option></select></label>
        <label>テンプレート<select name="template"><option value="blank">空図面</option><option value="demo">デモ施工図</option></select></label>
        <div class="dialog-actions">
          <button id="cancelNewDrawingBtn" type="button">キャンセル</button>
          <button type="submit" class="primary">作成</button>
        </div>
      </form>
    </dialog>
  `;
}

function settingsDialogHtml(drawing) {
  return `
    <dialog id="settingsDialog" aria-labelledby="settingsTitle">
      <form id="settingsForm" method="dialog">
        <header>
          <h2 id="settingsTitle">システム設定</h2>
          <button id="closeSettingsBtn" type="button" class="dialog-close" aria-label="閉じる" title="閉じる">×</button>
        </header>
        <fieldset class="settings-group">
          <legend>作図補助</legend>
          <label class="toggle-row">
            <input name="showGrid" type="checkbox" ${state.settings.showGrid ? "checked" : ""} />
            <span>グリッド表示</span>
          </label>
          <label class="toggle-row">
            <input name="snapEnabled" type="checkbox" ${state.settings.snapEnabled ? "checked" : ""} />
            <span>グリッドスナップ</span>
          </label>
          <label class="toggle-row">
            <input name="orthoEnabled" type="checkbox" ${state.settings.orthoEnabled ? "checked" : ""} />
            <span>直交モード</span>
          </label>
          <label class="toggle-row">
            <input name="osnapEnabled" type="checkbox" ${state.settings.osnapEnabled ? "checked" : ""} />
            <span>図形スナップ（OSnap）</span>
          </label>
          <fieldset class="osnap-modes">
            <legend>OSnap対象</legend>
            ${Object.entries(OSNAP_MODE_LABELS)
              .map(
                ([mode, label]) =>
                  `<label class="toggle-row"><input name="osnapMode_${mode}" type="checkbox" ${
                    state.settings.osnapModes?.[mode] ? "checked" : ""
                  } /><span>${escapeHtml(label)}</span></label>`
              )
              .join("")}
          </fieldset>
          <label>
            グリッド間隔
            <select name="gridInterval">
              ${[100, 250, 500, 1000]
                .map(
                  (interval) =>
                    `<option value="${interval}" ${state.settings.gridInterval === interval ? "selected" : ""}>${interval} ${escapeHtml(
                      drawing.unit
                    )}</option>`
                )
                .join("")}
            </select>
          </label>
        </fieldset>
        <fieldset class="settings-group">
          <legend>寸法スタイル</legend>
          <label>寸法線オフセット<input name="dimensionOffset" type="number" min="0" value="${escapeHtml(state.settings.dimensionOffset)}" /></label>
          <label>小数桁<select name="dimensionPrecision">${[0, 1, 2, 3]
            .map((value) => `<option value="${value}" ${state.settings.dimensionPrecision === value ? "selected" : ""}>${value}</option>`)
            .join("")}</select></label>
          <label>接尾辞<input name="dimensionSuffix" maxlength="12" value="${escapeHtml(state.settings.dimensionSuffix)}" placeholder="例: mm" /></label>
        </fieldset>
        <fieldset class="settings-group">
          <legend>画面</legend>
          <label>
            ログ表示行数
            <select name="commandLogLines">
              ${[1, 2, 3]
                .map(
                  (lines) => `<option value="${lines}" ${state.settings.commandLogLines === lines ? "selected" : ""}>${lines}行</option>`
                )
                .join("")}
            </select>
          </label>
          <label>
            表示テーマ
            <select id="themeSelect" name="theme">
              <option value="system" ${state.settings.theme === "system" ? "selected" : ""}>システム設定に合わせる</option>
              <option value="light" ${state.settings.theme === "light" ? "selected" : ""}>ライトモード</option>
              <option value="dark" ${state.settings.theme === "dark" ? "selected" : ""}>ダークモード</option>
            </select>
          </label>
        </fieldset>
        <fieldset class="settings-group">
          <legend>AIモデル連携</legend>
          <p class="ai-settings-warning">
            AIモデル連携はサーバーの環境変数のみで管理されます。
            <strong>APIキーはこのブラウザには保存も送信もされません。</strong>
          </p>
          <dl class="system-summary">
            <dt>状態</dt><dd>${
              !state.aiStatus.known
                ? "確認できません（権限不足または通信エラー）"
                : state.aiStatus.enabled
                  ? "有効"
                  : "未設定（ルールベースAIのみ動作）"
            }</dd>
            ${state.aiStatus.known && state.aiStatus.enabled ? `<dt>プロバイダ</dt><dd>${escapeHtml(state.aiStatus.provider ?? "-")}</dd>` : ""}
            ${state.aiStatus.known && state.aiStatus.enabled ? `<dt>モデル</dt><dd>${escapeHtml(state.aiStatus.model ?? "-")}</dd>` : ""}
          </dl>
        </fieldset>
        <dl class="system-summary">
          <dt>保存状態</dt><dd>${escapeHtml(saveStatusInfo().label)}（${escapeHtml(saveStatusInfo().description)}）</dd>
          <dt>バージョン</dt><dd>0.1.0</dd>
        </dl>
        <div class="dialog-actions settings-actions">
          <button id="resetSettingsBtn" type="button">初期値</button>
          <span></span>
          <button id="cancelSettingsBtn" type="button">キャンセル</button>
          <button type="submit" class="primary">適用</button>
        </div>
      </form>
    </dialog>
  `;
}

function bindEvents() {
  const newDrawingDialog = /** @type {HTMLDialogElement} */ (document.querySelector("#newDrawingDialog"));
  const settingsDialog = /** @type {HTMLDialogElement} */ (document.querySelector("#settingsDialog"));
  const importFile = /** @type {HTMLInputElement} */ (document.querySelector("#importFile"));

  document.querySelector("#newDrawingBtn").addEventListener("click", () => openNewDrawingDialog());
  document.querySelector("#importBtn").addEventListener("click", () => importFile.click());
  importFile.addEventListener("change", handleImportFile);
  document.querySelector("#quickSaveBtn").addEventListener("click", () => persist("上書き保存"));
  document.querySelector("#undoBtn").addEventListener("click", undoLastTransaction);
  document.querySelector("#redoBtn").addEventListener("click", redoLastTransaction);
  document.querySelector("#quickPrintBtn").addEventListener("click", goLayoutSpace);
  document.querySelector("#resetBtn").addEventListener("click", () => {
    clearDrawing();
    state.drawing = seedDrawing();
    resetAuthoringState();
    fitCameraToDrawing();
    state.apiStatus = { state: "idle", message: "未確認", connected: false, roleLocked: false };
    persist("デモ初期化");
  });
  document.querySelector("#newDrawingForm").addEventListener("submit", createNewDrawingFromForm);
  document.querySelector("#closeNewDrawingBtn").addEventListener("click", () => newDrawingDialog.close());
  document.querySelector("#cancelNewDrawingBtn").addEventListener("click", () => newDrawingDialog.close());
  document.querySelector("#settingsBtn").addEventListener("click", () => settingsDialog.showModal());
  document.querySelector("#settingsForm").addEventListener("submit", saveSettingsFromForm);
  document.querySelector("#closeSettingsBtn").addEventListener("click", () => settingsDialog.close());
  document.querySelector("#cancelSettingsBtn").addEventListener("click", () => settingsDialog.close());
  document.querySelector("#resetSettingsBtn").addEventListener("click", resetUserSettings);
  document.querySelector("#themeSelect")?.addEventListener("change", (event) => {
    const theme = /** @type {HTMLSelectElement} */ (event.currentTarget).value;
    if (!THEMES.has(theme)) return;
    state.settings = { ...state.settings, theme };
    saveUserSettings();
    applyTheme(theme);
  });
  bindDockResize();

  /** @type {NodeListOf<HTMLButtonElement>} */
  (document.querySelectorAll("[data-ribbon-tab]")).forEach((button) => {
    button.addEventListener("click", () => switchRibbonTab(button.dataset.ribbonTab));
  });
  /** @type {NodeListOf<HTMLButtonElement>} */
  const toolButtons = document.querySelectorAll("[data-tool]");
  toolButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.tool = button.dataset.tool;
      state.draftPoints = [];
      log(`ツール切替: ${state.tool}`);
      render();
    });
  });
  /** @type {NodeListOf<HTMLButtonElement>} */
  (document.querySelectorAll(".ribbon [data-act]")).forEach((button) => {
    button.addEventListener("click", () => {
      const action = RIBBON_ACTIONS[button.dataset.act];
      if (action) action(button.dataset.arg);
    });
  });
  /** @type {NodeListOf<HTMLButtonElement>} */
  (document.querySelectorAll("[data-space]")).forEach((button) => {
    button.addEventListener("click", () => switchSpace(button.dataset.space));
  });
  /** @type {NodeListOf<HTMLButtonElement>} */
  (document.querySelectorAll("[data-dock]")).forEach((button) => {
    button.addEventListener("click", () => openDock(button.dataset.dock));
  });
  /** @type {NodeListOf<HTMLButtonElement>} */
  (document.querySelectorAll("[data-toggle]")).forEach((button) => {
    button.addEventListener("click", () => toggleSetting(button.dataset.toggle));
  });

  const commandForm = /** @type {HTMLFormElement} */ (document.querySelector("#commandForm"));
  const commandInput = /** @type {HTMLInputElement} */ (document.querySelector("#commandInput"));
  commandForm.addEventListener("submit", executeCommandLine);
  commandInput.addEventListener("keydown", navigateCommandHistory);

  /** @type {NodeListOf<HTMLButtonElement>} */
  const viewModeButtons = document.querySelectorAll("[data-view-mode]");
  viewModeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.viewMode = button.dataset.viewMode;
      state.selectedId = null;
      state.draftPoints = [];
      log(`表示状態: ${viewModeLabel(state.viewMode)}`);
      render();
    });
  });

  document.querySelector("#apiHealthBtn")?.addEventListener("click", checkApiHealth);

  const roleSelect = /** @type {HTMLSelectElement} */ (document.querySelector("#roleSelect"));
  roleSelect.addEventListener("change", () => {
    state.drawing.currentRole = roleSelect.value;
    persist("権限切替");
  });

  /** @type {HTMLSelectElement | null} */
  const layerSelect = document.querySelector("#layerSelect");
  layerSelect?.addEventListener("change", () => {
    state.currentLayerId = layerSelect.value;
    log(`現在レイヤー: ${layerName(state.currentLayerId)}`);
    render();
  });

  document.querySelector("#fitBtn")?.addEventListener("click", fitToDrawing);

  document.querySelector("#planAiBtn")?.addEventListener("click", planAiProposal);
  document.querySelector("#applyAiBtn")?.addEventListener("click", applyAiProposal);
  document.querySelector("#operationForm")?.addEventListener("submit", applyOperationForm);
  document.querySelector("#propertyForm")?.addEventListener("submit", updateSelectedProperties);
  document.querySelector("#layerForm")?.addEventListener("submit", createLayerFromForm);
  document.querySelector("#commentForm")?.addEventListener("submit", addCommentFromForm);
  document.querySelector("#layoutForm")?.addEventListener("submit", updateLayoutFromForm);
  document.querySelector("#layoutForm")?.addEventListener("input", previewLayoutFromForm);
  document.querySelector("#layoutForm")?.addEventListener("change", previewLayoutFromForm);
  document.querySelector("#printBtn")?.addEventListener("click", printDrawing);

  /** @type {NodeListOf<HTMLInputElement>} */
  const layerVisibilityInputs = document.querySelectorAll("[data-layer-visible]");
  layerVisibilityInputs.forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const layer = state.drawing.layers.find((item) => item.id === checkbox.dataset.layerVisible);
      if (!layer) return;
      commitCommands(`レイヤー表示切替: ${layer.name}`, [
        { op: "update_layer", id: layer.id, patch: { visible: checkbox.checked } }
      ]);
    });
  });
  /** @type {NodeListOf<HTMLButtonElement>} */
  const layerLockButtons = document.querySelectorAll("[data-layer-lock]");
  layerLockButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const layer = state.drawing.layers.find((item) => item.id === button.dataset.layerLock);
      if (!layer) return;
      commitCommands(`レイヤーロック切替: ${layer.name}`, [
        { op: "update_layer", id: layer.id, patch: { locked: !layer.locked } }
      ]);
    });
  });
  document.querySelectorAll("[data-layer-color]").forEach((input) => {
    const colorInput = /** @type {HTMLInputElement} */ (input);
    colorInput.addEventListener("change", () => commitCommands("レイヤー色変更", [
      { op: "update_layer", id: colorInput.dataset.layerColor, patch: { color: colorInput.value } }
    ]));
  });

  document.querySelector("#reviewBtn")?.addEventListener("click", () => changeReviewState("submit"));
  document.querySelector("#approveBtn")?.addEventListener("click", () => changeReviewState("approve"));
  document.querySelector("#newVersionBtn")?.addEventListener("click", () => changeReviewState("new_version"));

  /** @type {HTMLCanvasElement | null} */
  const canvas = document.querySelector("#cadCanvas");
  if (canvas) {
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", cancelDrag);
    canvas.addEventListener("lostpointercapture", cancelDrag);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("keydown", onCanvasKeyDown);
  }
  if (state.focusTarget === "command") commandInput.focus({ preventScroll: true });
  else canvas?.focus({ preventScroll: true });
  state.focusTarget = null;
}

function switchRibbonTab(key) {
  state.ribbonTab = key;
  render();
}

function switchSpace(key) {
  state.space = key;
  log(key === "layout" ? "レイアウト空間に切り替えました" : "モデル空間に切り替えました");
  render();
}

function goLayoutSpace() {
  switchSpace("layout");
}

function openDock(key) {
  state.dock = key;
  render();
}

function toggleSetting(key) {
  state.settings = { ...state.settings, [key]: !state.settings[key] };
  saveUserSettings();
  log(`${key}: ${state.settings[key] ? "ON" : "OFF"}`);
  render();
}

function beginOperation(op) {
  state.dock = "props";
  state.pendingOperation = op;
  render();
  /** @type {HTMLInputElement | null} */ (document.querySelector("#operationForm [name=value]"))?.focus();
}

function triggerImport() {
  /** @type {HTMLInputElement | null} */ (document.querySelector("#importFile"))?.click();
}

function zoomIn() {
  zoomAtCenter(1.25);
}

function zoomOut() {
  zoomAtCenter(0.8);
}

function exportDrawing() {
  exportDrawingFile(state.drawing);
}

function exportDrawingDxf() {
  try {
    const result = exportDxf(state.drawing);
    const note = result.skipped.length > 0 ? `（スキップ: ${result.skipped.length}件）` : "";
    log(`DXF書出し: ${result.exported}件${note}`);
    if (result.skipped.length > 0) {
      log(`DXF未対応: ${result.skipped.map((entry) => `${entry.type}:${entry.id}`).join(", ")}`);
    }
    for (const warning of result.warnings) log(warning);
    render();
    exportDxfFile(state.drawing, result.content);
  } catch (error) { log(`DXF書出し失敗: ${error instanceof Error ? error.message : String(error)}`); render(); }
}

function openNewDrawingDialog(name = "") {
  const dialog = /** @type {HTMLDialogElement} */ (document.querySelector("#newDrawingDialog"));
  const input = /** @type {HTMLInputElement} */ (document.querySelector("#newDrawingName"));
  if (name) input.value = name;
  dialog.showModal();
  input.select();
}

function osnapModesFromForm(data) {
  const modes = {};
  for (const mode of Object.keys(OSNAP_MODE_LABELS)) {
    modes[mode] = data.get(`osnapMode_${mode}`) === "on";
  }
  return sanitizeOsnapModes(modes);
}

function sanitizeOsnapModes(stored) {
  const modes = { ...DEFAULT_OSNAP_MODES };
  if (stored && typeof stored === "object") {
    for (const mode of Object.keys(OSNAP_MODE_LABELS)) {
      if (typeof stored[mode] === "boolean") modes[mode] = stored[mode];
    }
  }
  return modes;
}

function saveSettingsFromForm(event) {
  event.preventDefault();
  const form = /** @type {HTMLFormElement} */ (event.currentTarget);
  const data = new FormData(form);
  const gridInterval = Number(data.get("gridInterval"));
  const commandLogLines = Number(data.get("commandLogLines"));
  const dimensionOffset = Number(data.get("dimensionOffset"));
  const dimensionPrecision = Number(data.get("dimensionPrecision"));
  state.settings = {
    showGrid: data.get("showGrid") === "on",
    snapEnabled: data.get("snapEnabled") === "on",
    orthoEnabled: data.get("orthoEnabled") === "on",
    osnapEnabled: data.get("osnapEnabled") === "on",
    osnapModes: osnapModesFromForm(data),
    gridInterval: GRID_INTERVALS.has(gridInterval) ? gridInterval : DEFAULT_USER_SETTINGS.gridInterval,
    commandLogLines: [1, 2, 3].includes(commandLogLines) ? commandLogLines : DEFAULT_USER_SETTINGS.commandLogLines,
    dimensionOffset: Number.isFinite(dimensionOffset) && dimensionOffset >= 0 ? dimensionOffset : DEFAULT_USER_SETTINGS.dimensionOffset,
    dimensionPrecision: [0, 1, 2, 3].includes(dimensionPrecision) ? dimensionPrecision : DEFAULT_USER_SETTINGS.dimensionPrecision,
    dimensionSuffix: String(data.get("dimensionSuffix") ?? "").slice(0, 12),
    dockWidth: state.settings.dockWidth,
    theme: THEMES.has(String(data.get("theme"))) ? String(data.get("theme")) : DEFAULT_USER_SETTINGS.theme
  };
  saveUserSettings();
  applyTheme(state.settings.theme);
  log("システム設定を更新");
  /** @type {HTMLDialogElement} */ (document.querySelector("#settingsDialog")).close();
  render();
}

function resetUserSettings() {
  state.settings = { ...DEFAULT_USER_SETTINGS };
  saveUserSettings();
  applyTheme(state.settings.theme);
  log("システム設定を初期化");
  /** @type {HTMLDialogElement} */ (document.querySelector("#settingsDialog")).close();
  render();
}

function bindDockResize() {
  const handle = /** @type {HTMLElement} */ (document.querySelector("#dockResizeHandle"));
  const workspace = /** @type {HTMLElement} */ (document.querySelector(".workspace"));
  let dragStart = null;

  const applyWidth = (width, persist = false) => {
    const next = Math.round(Math.min(DOCK_WIDTH_MAX, Math.max(DOCK_WIDTH_MIN, width)));
    state.settings.dockWidth = next;
    workspace.style.setProperty("--dock-width", `${next}px`);
    handle.setAttribute("aria-valuenow", String(next));
    if (persist) saveUserSettings();
  };

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    dragStart = { x: event.clientX, width: state.settings.dockWidth };
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("active");
    event.preventDefault();
  });
  handle.addEventListener("pointermove", (event) => {
    if (!dragStart || !handle.hasPointerCapture(event.pointerId)) return;
    applyWidth(dragStart.width - (event.clientX - dragStart.x));
  });
  const finish = (event) => {
    if (!dragStart) return;
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    dragStart = null;
    handle.classList.remove("active");
    saveUserSettings();
    drawCanvas();
  };
  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", finish);
  handle.addEventListener("keydown", (event) => {
    const delta = event.key === "ArrowLeft" ? 8 : event.key === "ArrowRight" ? -8 : 0;
    if (!delta && event.key !== "Home") return;
    event.preventDefault();
    applyWidth(event.key === "Home" ? DEFAULT_USER_SETTINGS.dockWidth : state.settings.dockWidth + delta, true);
    drawCanvas();
  });
  handle.addEventListener("dblclick", () => {
    applyWidth(DEFAULT_USER_SETTINGS.dockWidth, true);
    drawCanvas();
  });
}

async function createNewDrawingFromForm(event) {
  event.preventDefault();
  const policy = ROLE_POLICIES[state.drawing.currentRole] ?? ROLE_POLICIES.viewer;
  if (!policy.canEdit) {
    log(`${policy.label}は図面を新規作成できません。`);
    /** @type {HTMLDialogElement} */ (document.querySelector("#newDrawingDialog")).close();
    render();
    return;
  }
  const form = /** @type {HTMLFormElement} */ (event.currentTarget);
  const data = new FormData(form);
  const name = String(data.get("name") ?? "新規図面").trim() || "新規図面";
  const unit = String(data.get("unit") ?? "mm");
  const template = String(data.get("template") ?? "blank");
  const role = state.drawing.currentRole;
  try {
    if (state.apiStatus.connected) {
      const body = await apiRequest("/api/drawings", {
        method: "POST",
        headers: idempotencyHeaders(),
        body: JSON.stringify({ name, unit, template })
      });
      state.drawing = { ...body.drawing, currentRole: role };
    } else {
      state.drawing = template === "demo" ? seedDrawing() : createDrawing();
      state.drawing.id = `dwg_${globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Date.now()}`;
      state.drawing.name = name;
      state.drawing.unit = unit;
      state.drawing.currentRole = role;
    }
    resetAuthoringState();
    fitCameraToDrawing();
    /** @type {HTMLDialogElement} */ (document.querySelector("#newDrawingDialog")).close();
    persist(`新規図面作成: ${name}`);
  } catch (error) {
    log(`新規図面作成失敗: ${errorMessage(error)}`);
    render();
  }
}

async function handleImportFile(event) {
  const input = /** @type {HTMLInputElement} */ (event.currentTarget);
  const file = input.files?.[0];
  if (!file) return;
  try {
    const imported = parseCadImport({
      filename: file.name,
      content: await file.text(),
      drawing: state.drawing,
      currentLayerId: state.currentLayerId
    });
    const importedName = file.name.replace(/\.[^./]+$/, "").trim();
    const commands = importedName
      ? [...imported.commands, { op: "update_drawing_meta", patch: { name: importedName } }]
      : imported.commands;
    const committed = await commitCommands(`Import: ${file.name}`, commands);
    if (committed) {
      for (const warning of imported.warnings) log(`Import警告: ${warning}`);
      log(`Import完了: ${imported.entityCount}/${imported.sourceCount}図形`);
      fitCameraToDrawing();
      render();
    }
  } catch (error) {
    log(`Import失敗: ${errorMessage(error)}`);
    render();
  }
}

async function executeCommandLine(event) {
  event.preventDefault();
  const input = /** @type {HTMLInputElement} */ (document.querySelector("#commandInput"));
  const raw = input.value.trim();
  if (!raw) return;
  state.commandHistory.push(raw);
  state.commandHistory = state.commandHistory.slice(-50);
  state.commandHistoryIndex = state.commandHistory.length;
  state.focusTarget = "command";
  log(`> ${raw}`);
  try {
    const parsed = parseCadCommand(raw, {
      drawing: state.drawing,
      currentLayerId: state.currentLayerId,
      selectedId: state.selectedId,
      selectedIds: state.selectedIds,
      previousSelection: state.previousSelection
    });
    if (parsed.kind === "transaction") {
      await commitCommands(`CLI ${parsed.label}`, parsed.commands);
      return;
    }
    if (parsed.kind === "message") log(parsed.message);
    if (parsed.kind === "ui" && !(await executeUiCommand(parsed))) return;
  } catch (error) {
    log(`Command Error: ${errorMessage(error)}`);
  }
  render();
}

async function executeUiCommand(command) {
  if (command.action === "tool") {
    state.tool = command.tool;
    state.draftPoints = [];
    log(`ツール切替: ${command.tool}`);
  }
  if (command.action === "layer") {
    state.currentLayerId = command.layerId;
    log(`現在レイヤー: ${layerName(command.layerId)}`);
  }
  if (command.action === "fit") fitCameraToDrawing();
  if (command.action === "pan") {
    state.camera.x += command.offset.x * state.camera.scale;
    state.camera.y += command.offset.y * state.camera.scale;
    state.viewChanged = true;
    state.cameraMode = "user";
    log(`パン: ${command.offset.x},${command.offset.y}`);
  }
  if (command.action === "plot") {
    printDrawing();
    return false;
  }
  if (command.action === "select") {
    state.selectedId = command.entityId;
    log(`選択: ${command.entityId}`);
  }
  if (command.action === "selectMany") {
    const ids = new Set(selectableEntities(activeDrawing()).map((entity) => entity.id));
    state.selectedIds = command.entityIds.filter((id) => ids.has(id));
    state.tool = "select";
  }
  if (command.action === "cancel") {
    state.draftPoints = [];
    state.selectedId = null;
    log("取消");
  }
  if (command.action === "undo") {
    await undoLastTransaction();
    return false;
  }
  if (command.action === "redo") {
    await redoLastTransaction();
    return false;
  }
  if (command.action === "new") {
    render();
    openNewDrawingDialog(command.name);
    return false;
  }
  if (command.action === "import") {
    /** @type {HTMLInputElement} */ (document.querySelector("#importFile")).click();
    return false;
  }
  return true;
}

function navigateCommandHistory(event) {
  if (!["ArrowUp", "ArrowDown"].includes(event.key)) return;
  event.preventDefault();
  if (event.key === "ArrowUp") state.commandHistoryIndex = Math.max(0, state.commandHistoryIndex - 1);
  if (event.key === "ArrowDown") state.commandHistoryIndex = Math.min(state.commandHistory.length, state.commandHistoryIndex + 1);
  event.currentTarget.value = state.commandHistory[state.commandHistoryIndex] ?? "";
}

function fitToDrawing() {
  fitCameraToDrawing();
  render();
}

function zoomReadoutText() {
  return formatZoomPercent(state.camera.scale);
}

// render()はfit確定前に縮尺を書き出し、ホイールズームはrenderを経由しないため、描画ごとに表示を最新のカメラへ合わせる。
function updateZoomReadouts() {
  const text = zoomReadoutText();
  const readout = document.querySelector(".zoom-readout");
  if (readout) readout.textContent = text;
  const scale = document.querySelector("#scaleReadout");
  if (scale && state.space !== "layout") scale.textContent = `縮尺 ${text}`;
}

/** 直前の描画時のCanvas表示寸法。寸法変化時に画面中心を保つために使う。 */
/** @type {{ width: number, height: number } | null} */
let lastCanvasView = null;
/** @type {ResizeObserver | null} */
let canvasResizeObserver = null;

// windowのresize以外(ドック幅・フォント読込・画面回転)でCanvasの表示寸法が変わっても追従する。
// renderごとにCanvasは作り直されるため監視対象を付け替え、寸法が実際に変わったときだけ再描画する。
function observeCanvasResize() {
  if (typeof ResizeObserver === "undefined") return;
  const canvas = /** @type {HTMLCanvasElement | null} */ (document.querySelector("#cadCanvas"));
  canvasResizeObserver ??= new ResizeObserver(() => {
    const current = /** @type {HTMLCanvasElement | null} */ (document.querySelector("#cadCanvas"));
    if (!current || !lastCanvasView) return;
    const view = canvasViewSize(current);
    if (view.width !== lastCanvasView.width || view.height !== lastCanvasView.height) drawCanvas();
  });
  canvasResizeObserver.disconnect();
  if (canvas) canvasResizeObserver.observe(canvas);
}

/** 保存待ちの表示位置(図面IDごと)。300ms以内に図面を切り替えても前の図面の保存を失わない。 */
/** @type {Map<string, { cx: number, cy: number, scale: number }>} */
const pendingViewSaves = new Map();
let viewSaveTimer = 0;

function loadSavedViews() {
  try {
    return parseSavedViews(localStorage.getItem(SAVED_VIEWS_KEY));
  } catch {
    return {};
  }
}

// ズーム・パンの連続操作で書き込みが集中しないよう、最後の表示だけを少し遅らせて保存する。
// 図面IDと表示位置は操作時点で確定させ、直後に図面が切り替わっても取り違えない・失わない。
function scheduleViewSave(view) {
  pendingViewSaves.set(state.drawing.id, cameraToSavedView(state.camera, view));
  clearTimeout(viewSaveTimer);
  viewSaveTimer = window.setTimeout(flushViewSave, 300);
}

function flushViewSave() {
  clearTimeout(viewSaveTimer);
  if (pendingViewSaves.size === 0) return;
  let views = loadSavedViews();
  const savedAt = Date.now();
  for (const [drawingId, view] of pendingViewSaves) views = rememberSavedView(views, drawingId, view, savedAt);
  pendingViewSaves.clear();
  try {
    localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify(views));
  } catch {
    // 保存できない環境(プライベートモード等)では表示位置を記憶しないだけにする。
  }
}

function fitCameraToDrawing() {
  const canvas = /** @type {HTMLCanvasElement | null} */ (document.querySelector("#cadCanvas"));
  if (canvas) syncCanvasBackingSize(canvas, window.devicePixelRatio);
  state.camera = fitCameraToBounds(state.drawing.entities.map(entityBounds).filter(Boolean), canvas ? canvasViewSize(canvas) : DEFAULT_CANVAS_SIZE);
  // 直後のrenderでCanvasが再生成され寸法が変わり得るため、次の描画で実寸に合わせて再計算する。
  state.fitPending = true;
}

function resetAuthoringState() {
  state.currentLayerId = state.drawing.layers.some((layer) => layer.id === "layer-structure")
    ? "layer-structure"
    : state.drawing.layers[0]?.id;
  state.selectedId = null;
  state.previousSelection = [];
  state.pathDrawing = false;
  state.draftPoints = [];
  state.previewProposal = null;
  state.previewRunId = null;
  state.viewMode = "normal";
  state.undoStack = [];
  state.redoStack = [];
  state.measurement = null;
  state.pendingOperation = null;
  state.space = "model";
  state.layoutDraft = null;
  state.saveStatus = "idle";
}

async function applyOperationForm(event) {
  event.preventDefault();
  const selected = state.drawing.entities.find((entity) => entity.id === state.selectedId);
  if (!selected) return;
  const data = new FormData(event.currentTarget);
  const operation = String(data.get("operation"));
  const value = String(data.get("value") ?? "").trim();
  try {
    if (["dimassoc", "dimhorizontal", "dimvertical", "dimradius", "dimdiameter", "dimstyle"].includes(operation)) {
      const input = operation === "dimstyle" ? `${operation} ${value}` : `${operation} ${selected.id} ${value}`;
      const parsed = parseCadCommand(input, { drawing: state.drawing, currentLayerId: state.currentLayerId, selectedIds: state.selectedIds });
      if (parsed.kind === "transaction") await commitCommands(parsed.label, parsed.commands);
      return;
    }
    if (["stretch", "explode", "matchprop", "lengthen", "reverse", "overkill"].includes(operation)) {
      const parsed = parseCadCommand(`${operation} ${value}`, { drawing: state.drawing, currentLayerId: state.currentLayerId, selectedIds: state.selectedIds });
      if (parsed.kind === "transaction") await commitCommands(parsed.label, parsed.commands);
      else if (parsed.kind === "message") { log(parsed.message); render(); }
      return;
    }
    if (state.selectedIds.length > 1 && ["move", "copy", "rotate", "scale"].includes(operation)) {
      const parsed = parseCadCommand(`${operation} ${value}`, { drawing: state.drawing, currentLayerId: state.currentLayerId, selectedIds: state.selectedIds });
      if (parsed.kind === "transaction") await commitCommands(parsed.label, parsed.commands);
      return;
    }
    if (state.selectedIds.length > 1) throw new Error("この操作は図形を1件選択して実行してください。");
    let next;
    if (["move", "copy"].includes(operation)) {
      const offset = parsePointValue(value, "dx,dy");
      next = transformEntity(selected, { dx: offset.x, dy: offset.y });
    }
    if (operation === "rotate") next = transformEntity(selected, { angle: parseNumberValue(value, "角度"), base: entityAnchor(selected) });
    if (operation === "scale") {
      const scale = parseNumberValue(value, "尺度");
      if (scale <= 0) throw new Error("尺度は0より大きい値を指定してください。");
      next = transformEntity(selected, { scale, base: entityAnchor(selected) });
    }
    if (operation === "offset") next = offsetEntity(selected, parseNumberValue(value, "距離"));
    if (["trim", "extend"].includes(operation)) {
      const boundaries = state.drawing.entities.filter((item) => item.id !== selected.id);
      const clickPoint = parsePointValue(value, "x,y");
      next = operation === "trim" ? trimEntityToBoundaries(selected, boundaries, clickPoint) : extendEntityToBoundary(selected, boundaries, clickPoint);
    }
    if (operation === "mirror") {
      const axis = parseTwoPointsValue(value, "x1,y1 x2,y2（鏡像軸の2点）");
      next = mirrorEntity(selected, axis[0], axis[1]);
    }
    if (operation === "array") {
      const { columns, rows, columnDistance, rowDistance } = parseArrayValue(value);
      const copies = arrayEntity(selected, columns, rows, columnDistance, rowDistance);
      if (copies.length === 0) throw new Error("配列の複写対象がありません。");
      state.pendingOperation = null;
      await commitCommands("配列", copies.map((copy) => ({ op: "add", entity: copy })));
      return;
    }
    if (operation === "break") {
      const pieces = breakEntity(selected, parsePointValue(value, "x,y"));
      const first = /** @type {any} */ (pieces[0]);
      state.selectedId = first?.id ?? state.selectedId;
      state.pendingOperation = null;
      await commitCommands("分割", [{ op: "delete", id: selected.id }, ...pieces.map((piece) => ({ op: "add", entity: /** @type {any} */ (piece) }))]);
      return;
    }
    if (operation === "join") {
      const target = state.drawing.entities.find((entity) => entity.id === value.trim());
      if (!target) throw new Error("結合する相手の図形IDを値に入力してください(例: e_box_1)。");
      const joined = joinLines(selected, target);
      if (!joined) throw new Error("端点が一致し同一線上にある2線分のみ結合できます。");
      state.pendingOperation = null;
      await commitCommands("結合", [{ op: "delete", id: selected.id }, { op: "delete", id: target.id }, { op: "add", entity: joined }]);
      return;
    }
    if (["chamfer", "fillet"].includes(operation)) {
      const parts = value.split(/\s+/).filter(Boolean);
      const targetId = parts.shift();
      const target = state.drawing.entities.find((entity) => entity.id === targetId);
      if (!target) throw new Error(`${OPERATION_LABELS[operation]}する相手の線分IDを入力してください。`);
      if (operation === "chamfer") {
        if (parts.length < 1 || parts.length > 2) throw new Error("形式: 相手ID 距離1 [距離2]");
        const result = chamferLines(selected, target, parseNumberValue(parts[0], "距離1"), parts[1] === undefined ? undefined : parseNumberValue(parts[1], "距離2"));
        state.pendingOperation = null;
        await commitCommands("面取り", [
          { op: "update", id: selected.id, patch: { points: result.first.points } },
          { op: "update", id: target.id, patch: { points: result.second.points } },
          { op: "add", entity: result.connector }
        ]);
      } else {
        if (parts.length !== 1) throw new Error("形式: 相手ID 半径");
        const result = filletLines(selected, target, parseNumberValue(parts[0], "半径"));
        state.pendingOperation = null;
        await commitCommands("フィレット", [
          { op: "update", id: selected.id, patch: { points: result.first.points } },
          { op: "update", id: target.id, patch: { points: result.second.points } },
          { op: "add", entity: result.arc }
        ]);
      }
      return;
    }
    if (operation === "boundary") {
      const ids = [selected.id, ...value.split(/\s+/).filter(Boolean).filter((id) => id !== selected.id)];
      const entities = ids.map((id) => {
        const entity = state.drawing.entities.find((item) => item.id === id);
        if (!entity) throw new Error(`境界要素が見つかりません: ${id}`);
        return entity;
      });
      const boundary = createBoundaryEntity(state.currentLayerId, entities);
      state.selectedId = boundary.id;
      state.pendingOperation = null;
      await commitCommands("境界作成", [{ op: "add", entity: boundary }]);
      return;
    }
    if (operation === "pedit") {
      const parts = value.split(/\s+/).filter(Boolean);
      const action = String(parts.shift() ?? "").toUpperCase();
      let edited;
      if (["CLOSE", "OPEN"].includes(action) && parts.length === 0) {
        edited = editPolyline(selected, action);
      } else if (action === "DELETE" && parts.length === 1) {
        edited = editPolyline(selected, action, parseVertexNumber(parts[0]));
      } else if (["MOVE", "ADD"].includes(action) && parts.length === 2) {
        edited = editPolyline(selected, action, parseVertexNumber(parts[0]), parsePointValue(parts[1], "x,y"));
      } else {
        throw new Error("形式: MOVE|ADD|DELETE 頂点番号 [x,y] / CLOSE / OPEN");
      }
      state.pendingOperation = null;
      await commitCommands("ポリライン編集", [{ op: "update", id: selected.id, patch: withoutIdentity(edited) }]);
      return;
    }
    if (operation === "block") {
      const name = value || `BLOCK_${selected.id}`;
      const child = transformEntity(selected);
      child.id = `child_${Date.now().toString(36)}`;
      const block = blockEntity(selected.layerId, name, [0, 0], [child]);
      state.selectedId = block.id;
      state.pendingOperation = null;
      await commitCommands("ブロック化", [{ op: "delete", id: selected.id }, { op: "add", entity: block }]);
      return;
    }
    if (!next) throw new Error("操作を選択してください。");
    if (["copy", "offset"].includes(operation)) {
      next.id = `e_${operation}_${Date.now().toString(36)}`;
      delete next.dxfRecordId;
      next.meta = { createdBy: "user", createdAt: new Date().toISOString() };
      state.selectedId = next.id;
      state.pendingOperation = null;
      await commitCommands(operation === "copy" ? "図形複写" : "オフセット", [{ op: "add", entity: next }]);
    } else if (operation === "mirror" && next.type !== selected.type) {
      // rect→polyline等、型が変わる鏡像はdelete+addで置換する
      state.pendingOperation = null;
      await commitCommands("鏡像", [{ op: "delete", id: selected.id }, { op: "add", entity: next }]);
    } else {
      state.pendingOperation = null;
      await commitCommands(operation.toUpperCase(), [{ op: "update", id: selected.id, patch: withoutIdentity(next) }]);
    }
  } catch (error) {
    log(`操作失敗: ${errorMessage(error)}`);
    render();
  }
}

async function updateSelectedProperties(event) {
  event.preventDefault();
  if (state.selectedIds.length !== 1) return;
  const selected = state.drawing.entities.find((entity) => entity.id === state.selectedId);
  if (!selected) return;
  const data = new FormData(event.currentTarget);
  const strokeWidth = Number(data.get("strokeWidth"));
  await commitCommands("プロパティ更新", [{
    op: "update", id: selected.id,
    patch: {
      layerId: String(data.get("layerId")),
      style: { ...selected.style, strokeWidth },
      ...(selected.definitionId ? { attributeReferences: (selected.attributeReferences ?? []).map((attribute, index) => ({ ...attribute, value: String(data.get(`blockAttribute_${index}`) ?? attribute.value) })) }
        : selected.type === "block" ? { attributes: parseAttributes(String(data.get("blockAttributes") ?? "")) } : {})
    }
  }]);
}

async function createLayerFromForm(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const name = String(data.get("name") ?? "").trim();
  const id = `layer_${globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Date.now().toString(36)}`;
  const succeeded = await commitCommands(`レイヤー追加: ${name}`, [{ op: "add_layer", layer: { id, name, color: String(data.get("color")) } }]);
  if (succeeded) state.currentLayerId = id;
}

async function addCommentFromForm(event) {
  event.preventDefault();
  const form = /** @type {HTMLFormElement} */ (event.currentTarget);
  const data = new FormData(form);
  const body = String(data.get("body") ?? "").trim();
  if (!body) return;
  const attachToSelected = data.get("attachToSelected") === "on";
  const entityId = attachToSelected && state.selectedId ? state.selectedId : null;
  const succeeded = await commitCommands("コメント追加", [{ op: "add_comment", body, entityId }], {
    path: `/api/drawings/${state.drawing.id}/comments`,
    body: { body, entityId }
  });
  if (succeeded) form.reset();
}

async function updateLayoutFromForm(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const ok = await commitCommands("レイアウト設定", [{ op: "update_layout", patch: Object.fromEntries(data) }]);
  if (ok) state.layoutDraft = null;
}

function previewLayoutFromForm(event) {
  const form = /** @type {HTMLFormElement} */ (event.currentTarget);
  const data = new FormData(form);
  state.layoutDraft = Object.fromEntries(data);
  const previewDrawing = activeLayoutDrawing(state.drawing);
  const stage = document.querySelector(".layout-stage");
  if (stage) stage.innerHTML = layoutPreviewHtml(previewDrawing);
  applyLayoutGeometry(previewDrawing);
}

function printDrawing() {
  document.body.dataset.printPaper = activeLayoutDrawing(state.drawing).layout?.paper ?? "A3";
  log("印刷プレビューを開きます。送信先でPDF保存を選択できます。");
  render();
  setTimeout(() => window.print(), 0);
}

function zoomAtCenter(factor) {
  const canvas = /** @type {HTMLCanvasElement} */ (document.querySelector("#cadCanvas"));
  if (!canvas) return;
  const view = canvasViewSize(canvas);
  const before = screenToWorld(view.width / 2, view.height / 2);
  state.camera.scale = clampCameraScale(state.camera.scale * factor, state.camera.scale);
  const after = screenToWorld(view.width / 2, view.height / 2);
  state.camera.x += (after.x - before.x) * state.camera.scale;
  state.camera.y += (after.y - before.y) * state.camera.scale;
  state.viewChanged = true;
  state.cameraMode = "user";
  log(`ズーム: ${zoomReadoutText()}`);
  render();
}

async function changeReviewState(action) {
  const policy = ROLE_POLICIES[state.drawing.currentRole] ?? ROLE_POLICIES.viewer;
  const allowed = action === "submit" ? policy.canEdit : policy.canApprove;
  if (!allowed) {
    log(`${policy.label}は${action === "submit" ? "レビュー提出" : "承認・新版作成"}できません。`);
    render();
    return;
  }
  if (action === "submit" && !["draft", "rejected"].includes(state.drawing.state)) {
    log("下書きまたは差戻し図面だけをレビュー提出できます。");
    render();
    return;
  }
  if (action === "new_version" && state.drawing.state !== "approved") {
    log("承認済み図面からのみ新版を作成できます。");
    render();
    return;
  }
  if (state.apiStatus.state !== "ok") {
    log("API未接続のため、レビュー提出・承認・新版作成はサーバー接続後に行ってください。オフライン中はローカルで確定させません。");
    render();
    return;
  }
  try {
    const body = await apiRequest(`/api/drawings/${state.drawing.id}/review`, {
      method: "POST",
      headers: transactionHeaders(),
      body: JSON.stringify({ action })
    });
    state.drawing = body.drawing;
    state.saveStatus = "synced";
    persist({ submit: "レビュー提出", approve: "承認完了", new_version: "新版作成" }[action]);
  } catch (error) {
    state.saveStatus = error instanceof Error && "status" in error && error.status === 409 ? "conflict" : "unsynced";
    log(`API操作失敗: ${errorMessage(error)}`);
    render();
  }
}

function onPointerDown(event) {
  if (state.viewMode === "loading" || state.viewMode === "error") {
    log(`${viewModeLabel(state.viewMode)}状態ではCanvas操作を停止しています。`);
    render();
    return;
  }
  const rawWorld = screenToWorld(event.offsetX, event.offsetY);
  const world = state.tool === "select" ? rawWorld : snapPoint(rawWorld);
  const policy = ROLE_POLICIES[state.drawing.currentRole] ?? ROLE_POLICIES.viewer;

  if (state.tool === "pan" || event.button === 1) {
    state.panStart = { x: event.clientX, y: event.clientY, camera: { ...state.camera } };
    event.currentTarget.setPointerCapture(event.pointerId);
    return;
  }

  if (state.tool === "measure") {
    state.draftPoints.push(world);
    if (state.draftPoints.length === 2) {
      state.measurement = measurePoints(state.draftPoints[0], state.draftPoints[1]);
      log(`計測: 距離=${formatNumber(state.measurement.distance)} ${state.drawing.unit} / 角度=${formatNumber(state.measurement.angle)}°`);
      state.draftPoints = [];
      render();
    } else drawCanvas(world);
    return;
  }

  if (state.tool === "area") {
    state.draftPoints.push(world);
    if (state.draftPoints.length === 2) {
      const [a, b] = state.draftPoints;
      const area = Math.abs((b.x - a.x) * (b.y - a.y));
      const areaInSquareMeters = state.drawing.unit === "m" ? area : area / 1e6;
      log(`AREA = ${formatNumber(areaInSquareMeters)} m²`);
      state.draftPoints = [];
      render();
    } else drawCanvas(world);
    return;
  }

  if (state.tool === "id") {
    log(`ID点 — X=${formatNumber(world.x)}, Y=${formatNumber(world.y)}`);
    render();
    return;
  }

  if (state.tool === "select") {
    if (event.button !== 0) return;
    const entities = selectableEntities(activeDrawing());
    const selection = new Set(state.selectedIds);
    const selected = entities.filter((entity) => selection.has(entity.id));
    const editable = policy.canEdit && state.drawing.state !== "approved";
    const unlocked = (entity) => !state.drawing.layers.find((layer) => layer.id === entity.layerId)?.locked;
    const gripEntity = selected.length === 1 && editable && unlocked(selected[0]) ? selected[0] : null;
    const grip = gripEntity && entityGrips(gripEntity).find((item) => Math.hypot(item.point.x - world.x, item.point.y - world.y) * state.camera.scale <= 7);
    const hit = hitTest({ ...activeDrawing(), entities }, world, 8 / state.camera.scale);
    if (grip && !event.shiftKey) {
      state.drag = { start: world, originals: [gripEntity], grip, preview: [], moved: false };
    } else if (hit) {
      if (event.shiftKey) {
        state.selectedIds = state.selectedIds.includes(hit.id) ? state.selectedIds.filter((id) => id !== hit.id) : [...state.selectedIds, hit.id];
      } else {
        if (!state.selectedIds.includes(hit.id)) state.selectedId = hit.id;
        const originals = selection.has(hit.id) ? selected : [hit];
        if (editable && originals.every(unlocked)) state.drag = { start: world, originals, preview: [], moved: false };
      }
    } else {
      state.selectionBox = { start: world, end: world, previous: [...state.selectedIds], additive: event.shiftKey };
    }
    if (state.drag || state.selectionBox) {
      event.currentTarget.setPointerCapture(event.pointerId);
      drawCanvas();
    } else render();
    return;
  }

  if (["fence", "lasso"].includes(state.tool)) {
    if (event.button !== 0) return;
    if (state.tool === "lasso") {
      state.draftPoints = [rawWorld];
      state.pathDrawing = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    } else if (state.draftPoints.length < 2000) state.draftPoints.push(rawWorld);
    drawCanvas(rawWorld);
    return;
  }

  if (!policy.canEdit) {
    log(`${policy.label}は作図できません。`);
    render();
    return;
  }

  if (state.tool === "line" || state.tool === "rect" || state.tool === "circle" || state.tool === "dimension") {
    state.draftPoints.push(world);
    if (state.draftPoints.length === 2) {
      commitTwoPointTool();
    } else {
      drawCanvas(world);
    }
  }

  if (state.tool === "arc") {
    state.draftPoints.push(world);
    if (state.draftPoints.length === 3) commitArcTool();
    else drawCanvas(world);
  }

  if (state.tool === "ellipse") {
    state.draftPoints.push(world);
    if (state.draftPoints.length === 3) commitEllipseTool();
    else drawCanvas(world);
  }

  if (state.tool === "polyline" || state.tool === "spline") {
    state.draftPoints.push(world);
    drawCanvas(world);
  }

  if (state.tool === "hatch") {
    state.draftPoints.push(world);
    drawCanvas(world);
  }

  if (state.tool === "text") {
    const value = prompt("配置する文字を入力", "施工注記");
    if (value) {
      commitCommands("文字追加", [{ op: "add", entity: text(state.currentLayerId, [world.x, world.y], value) }]);
    }
  }
}

function onPointerMove(event) {
  if (state.panStart) {
    state.camera.x = state.panStart.camera.x + event.clientX - state.panStart.x;
    state.camera.y = state.panStart.camera.y + event.clientY - state.panStart.y;
    drawCanvas();
    return;
  }
  const rawWorld = screenToWorld(event.offsetX, event.offsetY);
  if (state.pathDrawing) {
    const last = state.draftPoints.at(-1);
    if (state.draftPoints.length < 2000 && Math.hypot(last.x - rawWorld.x, last.y - rawWorld.y) * state.camera.scale >= 3) state.draftPoints.push(rawWorld);
    drawCanvas(rawWorld);
    return;
  }
  if (state.selectionBox) {
    state.selectionBox.end = rawWorld;
    drawCanvas();
    return;
  }
  if (state.drag) {
    const target = state.settings.orthoEnabled ? applyOrtho(state.drag.start, rawWorld) : rawWorld;
    updateCoordReadout(target);
    const dx = target.x - state.drag.start.x;
    const dy = target.y - state.drag.start.y;
    state.drag.moved = Math.hypot(dx, dy) * state.camera.scale > 3;
    try {
      state.drag.preview = state.drag.moved ? state.drag.originals.map((entity) => state.drag.grip ? moveGrip(entity, state.drag.grip, target) : moveEntity(entity, dx, dy)) : [];
    } catch {
      state.drag.preview = [];
    }
    drawCanvas();
    return;
  }
  const world = snapPoint(rawWorld);
  updateCoordReadout(world);
  if (state.draftPoints.length > 0) {
    drawCanvas(world);
  }
}

function onPointerUp() {
  if (state.pathDrawing) {
    state.pathDrawing = false;
    finishPathSelection();
    return;
  }
  if (state.panStart) {
    const moved = state.camera.x !== state.panStart.camera.x || state.camera.y !== state.panStart.camera.y;
    state.panStart = null;
    if (moved) {
      state.viewChanged = true;
      state.cameraMode = "user";
    }
    log("パン表示を更新");
    render();
    return;
  }
  if (state.selectionBox) {
    const { start, end, previous, additive } = state.selectionBox;
    const ids = Math.hypot(end.x - start.x, end.y - start.y) * state.camera.scale > 3 ? selectInBox(activeDrawing(), start, end) : [];
    state.selectedIds = additive ? [...new Set([...previous, ...ids])] : ids;
    state.selectionBox = null;
    log(`選択: ${state.selectedIds.length}件`);
    render();
    return;
  }
  if (!state.drag) return;
  const commands = state.drag.preview.map((entity) => ({ op: "update", id: entity.id, patch: withoutIdentity(entity) }));
  const label = state.drag.grip ? "グリップ編集" : "図形移動";
  state.drag = null;
  if (commands.length) commitCommands(label, commands);
  else render();
}

function cancelDrag() {
  if (state.pathDrawing) {
    state.pathDrawing = false;
    state.draftPoints = [];
    render();
    return;
  }
  if (state.panStart) {
    state.camera = state.panStart.camera;
    state.panStart = null;
    render();
    return;
  }
  if (!state.drag && !state.selectionBox) return;
  state.selectionBox = null;
  state.drag = null;
  log("図形移動を取消");
  render();
}

function onWheel(event) {
  event.preventDefault();
  const factor = event.deltaY < 0 ? 1.12 : 0.9;
  const before = screenToWorld(event.offsetX, event.offsetY);
  state.camera.scale = clampCameraScale(state.camera.scale * factor, state.camera.scale);
  const after = screenToWorld(event.offsetX, event.offsetY);
  state.camera.x += (after.x - before.x) * state.camera.scale;
  state.camera.y += (after.y - before.y) * state.camera.scale;
  state.viewChanged = true;
  state.cameraMode = "user";
  drawCanvas();
}

function onCanvasKeyDown(event) {
  if (event.key === "Enter" && state.tool === "fence") {
    event.preventDefault();
    finishPathSelection();
    return;
  }
  if (event.key === "Escape") {
    cancelDrag();
    state.draftPoints = [];
    state.selectedId = null;
    log("取消");
    render();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
    event.preventDefault();
    state.selectedIds = selectableEntities(activeDrawing()).map((entity) => entity.id);
    render();
  }
  if (event.key === "Enter" && state.tool === "polyline" && state.draftPoints.length >= 3) {
    commitCommands("ポリライン作成", [
      { op: "add", entity: polyline(state.currentLayerId, state.draftPoints, { closed: event.shiftKey }) }
    ]);
    state.draftPoints = [];
  }
  if (event.key === "Enter" && state.tool === "spline" && state.draftPoints.length >= 2) {
    commitCommands("スプライン作成", [{ op: "add", entity: spline(state.currentLayerId, state.draftPoints) }]);
    state.draftPoints = [];
  }
  if (event.key === "Enter" && state.tool === "hatch" && state.draftPoints.length >= 3) {
    commitCommands("ハッチング作成", [{ op: "add", entity: hatchEntity(state.currentLayerId, state.draftPoints) }]);
    state.draftPoints = [];
  }
  if (event.key === "0") fitToDrawing();
  if (event.key === "+" || event.key === "=") zoomAtCenter(1.25);
  if (event.key === "-") zoomAtCenter(0.8);
  if ((event.key === "Delete" || event.key === "Backspace") && state.selectedId) {
    event.preventDefault();
    deleteSelected();
  }
}

function finishPathSelection() {
  try { state.selectedIds = selectByPath(activeDrawing(), state.draftPoints, state.tool); }
  catch (error) { log(errorMessage(error)); }
  state.draftPoints = [];
  state.tool = "select";
  render();
}

function commitTwoPointTool() {
  const [a, b] = state.draftPoints;
  const commands = [];
  if (state.tool === "line") {
    commands.push({ op: "add", entity: line(state.currentLayerId, [a.x, a.y], [b.x, b.y]) });
  }
  if (state.tool === "rect") {
    commands.push({ op: "add", entity: rect(state.currentLayerId, [a.x, a.y], b.x - a.x, b.y - a.y) });
  }
  if (state.tool === "circle") {
    commands.push({ op: "add", entity: circle(state.currentLayerId, [a.x, a.y], Math.hypot(b.x - a.x, b.y - a.y)) });
  }
  if (state.tool === "dimension") {
    commands.push({ op: "add", entity: dimensionEntity(state.currentLayerId, a, b, {
      offset: state.settings.dimensionOffset, precision: state.settings.dimensionPrecision, suffix: state.settings.dimensionSuffix
    }) });
  }
  commitCommands(`${state.tool}作成`, commands);
  state.draftPoints = [];
}

function commitArcTool() {
  const [center, start, end] = state.draftPoints;
  const radius = Math.hypot(start.x - center.x, start.y - center.y);
  const startAngle = (Math.atan2(start.y - center.y, start.x - center.x) * 180) / Math.PI;
  const endAngle = (Math.atan2(end.y - center.y, end.x - center.x) * 180) / Math.PI;
  state.draftPoints = [];
  if (radius <= 1e-9 || Math.abs((((endAngle - startAngle) % 360) + 360) % 360) <= 1e-9) {
    log("円弧作成失敗: 中心・始点・終点を異なる位置で指定してください。");
    render();
    return;
  }
  commitCommands("arc作成", [{ op: "add", entity: arc(state.currentLayerId, center, radius, startAngle, endAngle) }]);
}

function commitEllipseTool() {
  const [center, majorEnd, minorPoint] = state.draftPoints;
  const majorX = majorEnd.x - center.x;
  const majorY = majorEnd.y - center.y;
  const radiusX = Math.hypot(majorX, majorY);
  const radiusY = radiusX <= 1e-9 ? 0 : Math.abs((majorX * (minorPoint.y - center.y) - majorY * (minorPoint.x - center.x)) / radiusX);
  state.draftPoints = [];
  if (radiusX <= 1e-9 || radiusY <= 1e-9 || radiusY > radiusX) {
    log("楕円作成失敗: 中心、長軸端、長軸以下の短半径を順に指定してください。");
    render();
    return;
  }
  const rotation = Math.atan2(majorY, majorX) * 180 / Math.PI;
  commitCommands("ellipse作成", [{ op: "add", entity: ellipse(state.currentLayerId, center, radiusX, radiusY, rotation) }]);
}

async function deleteSelected() {
  if (!state.selectedId) {
    log("削除対象が未選択です。");
    render();
    return;
  }
  if (await commitCommands("図形削除", state.selectedIds.map((id) => ({ op: "delete", id })))) {
    state.selectedId = null;
    render();
  }
}

async function undoLastTransaction() {
  const target = state.undoStack.pop();
  if (!target) {
    log("元に戻せる操作がありません。");
    render();
    return;
  }
  const current = structuredClone(state.drawing);
  state.redoStack.push(current);
  const succeeded = await commitCommands("UNDO", snapshotCommands(state.drawing, target), { recordHistory: false });
  if (!succeeded) {
    state.redoStack.pop();
    state.undoStack.push(target);
  }
}

async function redoLastTransaction() {
  const target = state.redoStack.pop();
  if (!target) {
    log("やり直せる操作がありません。");
    render();
    return;
  }
  const current = structuredClone(state.drawing);
  state.undoStack.push(current);
  const succeeded = await commitCommands("REDO", snapshotCommands(state.drawing, target), { recordHistory: false });
  if (!succeeded) {
    state.undoStack.pop();
    state.redoStack.push(target);
  }
}

function snapshotCommands(current, target) {
  const commands = [];
  const resourcesChanged = JSON.stringify(current.blockDefinitions ?? []) !== JSON.stringify(target.blockDefinitions ?? []) || JSON.stringify(current.dxfSources ?? []) !== JSON.stringify(target.dxfSources ?? []);
  for (const set of current.selectionSets ?? []) {
    if (!(target.selectionSets ?? []).some((item) => item.name === set.name)) commands.push({ op: "delete_selection", name: set.name });
  }
  const currentById = new Map(current.entities.map((entity) => [entity.id, entity]));
  const targetById = new Map(target.entities.map((entity) => [entity.id, entity]));
  for (const entity of current.entities) {
    if (!targetById.has(entity.id)) commands.push({ op: "delete", id: entity.id });
  }
  if (current.unit !== target.unit) {
    if (resourcesChanged) commands.push({ op: "set_block_resources", definitions: [], sources: [] });
    commands.push({ op: "set_empty_drawing_unit", unit: target.unit });
  }
  if (resourcesChanged) commands.push({ op: "set_block_resources", definitions: target.blockDefinitions ?? [], sources: target.dxfSources ?? [] });
  for (const entity of target.entities) {
    const existing = currentById.get(entity.id);
    if (!existing) commands.push({ op: "add", entity: structuredClone(entity) });
    else if (JSON.stringify(existing) !== JSON.stringify(entity)) {
      commands.push({ op: "update", id: entity.id, patch: withoutIdentity(entity) });
    }
  }
  for (const layer of current.layers) {
    if (!target.layers.some((item) => item.id === layer.id)) {
      commands.push({ op: "delete_layer", id: layer.id });
    }
  }
  for (const layer of target.layers) {
    const existing = current.layers.find((item) => item.id === layer.id);
    if (!existing) commands.unshift({ op: "add_layer", layer: structuredClone(layer) });
    else if (JSON.stringify(existing) !== JSON.stringify(layer)) {
      commands.push({
        op: "update_layer",
        id: layer.id,
        patch: { visible: layer.visible, locked: layer.locked, printable: layer.printable, name: layer.name, color: layer.color }
      });
    }
  }
  if (JSON.stringify(current.layout) !== JSON.stringify(target.layout)) commands.push({ op: "update_layout", patch: target.layout });
  for (const set of target.selectionSets ?? []) {
    if (JSON.stringify((current.selectionSets ?? []).find((item) => item.name === set.name)) !== JSON.stringify(set)) {
      const existing = new Set(target.entities.map((entity) => entity.id));
      const entityIds = set.entityIds.filter((id) => existing.has(id));
      if (entityIds.length) commands.push({ op: "save_selection", name: set.name, entityIds });
    }
  }
  return commands;
}

async function planAiProposal() {
  const promptInput = /** @type {HTMLTextAreaElement} */ (document.querySelector("#aiPrompt"));
  const promptValue = promptInput.value;
  state.aiBusy = true;
  state.aiError = null;
  render();
  if (state.apiStatus.connected) {
    try {
      const body = await apiRequest(`/api/drawings/${state.drawing.id}/agent-runs`, {
        method: "POST",
        body: JSON.stringify({ prompt: promptValue })
      });
      state.previewProposal = body.run.proposal;
      state.previewRunId = body.run.id;
      state.aiEngine = body.run.proposal?.engine ?? "rule";
    } catch (error) {
      state.aiBusy = false;
      state.aiError = errorMessage(error);
      log(`AI Preview失敗: ${errorMessage(error)}`);
      render();
      return;
    }
  } else {
    state.previewProposal = buildAiProposal(state.drawing, promptValue);
    state.previewRunId = null;
    state.aiEngine = "rule";
  }
  state.aiBusy = false;
  log(state.previewProposal.status === "planned" ? `AI Preview生成: ${state.previewProposal.label}` : "AI追加入力が必要");
  render();
}

async function applyAiProposal() {
  const policy = ROLE_POLICIES[state.drawing.currentRole] ?? ROLE_POLICIES.viewer;
  if (!policy.canRunAi && !policy.canEdit) {
    log(`${policy.label}はAI提案を適用できません。`);
    render();
    return;
  }

  if (state.apiStatus.connected && state.previewRunId) {
    try {
      const body = await apiRequest(`/api/agent-runs/${state.previewRunId}/approve`, {
        method: "POST",
        headers: transactionHeaders(),
        body: JSON.stringify({ drawingId: state.drawing.id, proposal: state.previewProposal })
      });
      state.drawing = body.drawing;
      state.saveStatus = "synced";
      state.previewProposal = null;
      state.previewRunId = null;
      persist("AI提案を承認適用 / サーバー同期");
    } catch (error) {
      state.saveStatus = error instanceof Error && "status" in error && error.status === 409 ? "conflict" : "unsynced";
      log(`AI適用失敗: ${errorMessage(error)}`);
      render();
    }
    return;
  }

  const result = applyTransaction(state.drawing, proposalToTransaction(state.previewProposal, state.drawing.currentRole));
  if (!result.ok) {
    log(`AI適用失敗: ${result.error}`);
    render();
    return;
  }
  state.drawing = result.drawing;
  state.saveStatus = "unsynced";
  state.previewProposal = null;
  persist("AI提案を承認適用");
}

async function commitCommands(label, commands, options = {}) {
  const before = structuredClone(state.drawing);
  const path = options.path ?? `/api/drawings/${state.drawing.id}/transactions`;
  const requestBody = options.body ?? { label, commands };
  if (state.apiStatus.connected) {
    state.saveStatus = "syncing";
    try {
      const body = await apiRequest(path, {
        method: "POST",
        headers: transactionHeaders(),
        body: JSON.stringify(requestBody)
      });
      state.drawing = body.drawing;
      state.saveStatus = "synced";
      recordDrawingHistory(before, options);
      persist(`${label} / サーバー同期`);
      return true;
    } catch (error) {
      state.saveStatus = error instanceof Error && "status" in error && error.status === 409 ? "conflict" : "unsynced";
      log(`${label}失敗: ${errorMessage(error)}`);
      render();
      return false;
    }
  }

  const result = applyTransaction(state.drawing, {
    source: "user",
    actor: state.drawing.currentRole,
    label,
    commands
  });
  if (!result.ok) {
    log(`${label}失敗: ${result.error}`);
    render();
    return false;
  }
  state.drawing = result.drawing;
  state.saveStatus = "unsynced";
  recordDrawingHistory(before, options);
  persist(label);
  return true;
}

function recordDrawingHistory(before, options) {
  if (options.recordHistory === false) return;
  state.undoStack.push(before);
  state.undoStack = state.undoStack.slice(-20);
  state.redoStack = [];
}

function drawCanvas(pointerWorld = null) {
  const canvas = /** @type {HTMLCanvasElement | null} */ (document.querySelector("#cadCanvas"));
  if (!canvas) return;
  const drawing = activeDrawing();
  syncCanvasBackingSize(canvas, window.devicePixelRatio);
  const view = canvasViewSize(canvas);
  // フォント読込やドック幅でCanvas寸法が描画後に変わった場合、全体表示・復元の意図を保つ。
  // パンのドラッグ中は利用者の操作を優先して追従しない。
  if (lastCanvasView && !state.panStart && (lastCanvasView.width !== view.width || lastCanvasView.height !== view.height)) {
    if (state.cameraMode === "fit") {
      state.camera = fitCameraToBounds(state.fitBounds, view);
      // 利用者が明示した全体表示は、再fit後の表示を記憶位置へ反映する。
      if (state.fitExplicit) state.viewChanged = true;
    } else if (state.cameraMode === "restored") {
      state.camera = keepCenterOnResize(state.camera, lastCanvasView, view);
    }
  }
  lastCanvasView = view;
  if (state.boundsRecheckPending && !state.fitPending && !state.outOfViewFitPending) {
    // 同じ図面の再同期: 全体表示中なら新しい図形範囲へ合わせ直し、それ以外は図形が表示から完全に外れたときだけfitする。
    // 一部を拡大して見ている利用者の表示は維持する。
    const bounds = state.drawing.entities.map(entityBounds).filter(Boolean);
    if (state.cameraMode === "fit") {
      state.fitBounds = bounds;
      state.camera = fitCameraToBounds(bounds, view);
    } else if (bounds.length > 0 && !boundsIntersectView(bounds, state.camera, view)) {
      state.camera = fitCameraToBounds(bounds, view);
      state.cameraMode = "fit";
      state.fitBounds = bounds;
      state.fitExplicit = false;
    }
  }
  state.boundsRecheckPending = false;
  if (state.fitPending || state.outOfViewFitPending) {
    const bounds = state.drawing.entities.map(entityBounds).filter(Boolean);
    const saved = state.fitPending ? null : loadSavedViews()[state.drawing.id];
    const restored = saved ? savedViewToCamera(saved, view) : null;
    if (state.fitPending) {
      state.camera = fitCameraToBounds(bounds, view);
      state.cameraMode = "fit";
      state.fitBounds = bounds;
      state.fitExplicit = true;
      state.viewChanged = true;
    } else if (restored && (bounds.length === 0 || boundsIntersectView(bounds, restored, view))) {
      // 前回この図面を見ていた位置へ戻す。保存位置が図面から外れている(内容が変わった)場合は使わない。
      state.camera = restored;
      state.cameraMode = "restored";
    } else if (!boundsVisibleInView(bounds, state.camera, view)) {
      state.camera = fitCameraToBounds(bounds, view);
      state.cameraMode = "fit";
      state.fitBounds = bounds;
      state.fitExplicit = false;
    }
    state.fitPending = false;
    state.outOfViewFitPending = false;
  }
  updateZoomReadouts();
  if (state.viewChanged) {
    state.viewChanged = false;
    scheduleViewSave(view);
  }
  const ctx = canvas.getContext("2d");
  // 以降の描画はCSS px座標で行い、backing storeの高DPI倍率はtransformで吸収する。
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(canvas.width / view.width, 0, 0, canvas.height / view.height, 0, 0);
  drawGrid(ctx, view);
  drawPaper(ctx);

  const viewport = worldViewportBounds(view);
  const selection = new Set(state.selectedIds);
  const previews = new Map((state.drag?.preview ?? []).map((entity) => [entity.id, entity]));
  for (const entity of visibleEntities(drawing.entities, viewport)) {
    if (!previews.has(entity.id)) drawEntity(ctx, entity, selection.has(entity.id) ? "#ff8a00" : null);
  }
  for (const entity of previews.values()) drawEntity(ctx, entity, "#ff8a00");
  if (state.tool === "select" && state.selectedIds.length === 1 && !state.drag) {
    const entity = drawing.entities.find((item) => item.id === state.selectedId);
    if (entity) for (const grip of entityGrips(entity)) {
      const point = worldToScreen(grip.point);
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "#136cc1";
      ctx.fillRect(point.x - 4, point.y - 4, 8, 8);
      ctx.strokeRect(point.x - 4, point.y - 4, 8, 8);
    }
  }
  if (state.selectionBox) {
    const a = worldToScreen(state.selectionBox.start);
    const b = worldToScreen(state.selectionBox.end);
    const crossing = b.x < a.x;
    ctx.save();
    ctx.strokeStyle = crossing ? "#148349" : "#136cc1";
    ctx.fillStyle = crossing ? "rgba(20,131,73,0.12)" : "rgba(19,108,193,0.12)";
    ctx.setLineDash(crossing ? [6, 4] : []);
    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.restore();
  }

  if (state.previewProposal?.status === "planned") {
    for (const command of state.previewProposal.commands) {
      if (command.op === "add") drawEntity(ctx, command.entity, "#18b6c9", true);
    }
  }

  if (state.draftPoints.length > 0 && pointerWorld) {
    ctx.save();
    ctx.strokeStyle = "#ff8a00";
    ctx.setLineDash([8, 6]);
    if (state.tool === "ellipse" && state.draftPoints.length === 2) {
      const [center, majorEnd] = state.draftPoints;
      const majorX = majorEnd.x - center.x;
      const majorY = majorEnd.y - center.y;
      const radiusX = Math.hypot(majorX, majorY);
      const radiusY = radiusX <= 1e-9 ? 0 : Math.abs((majorX * (pointerWorld.y - center.y) - majorY * (pointerWorld.x - center.x)) / radiusX);
      if (radiusX > 1e-9 && radiusY > 1e-9 && radiusY <= radiusX) {
        const screenCenter = worldToScreen(center);
        ctx.beginPath();
        ctx.ellipse(screenCenter.x, screenCenter.y, radiusX * state.camera.scale, radiusY * state.camera.scale, Math.atan2(majorY, majorX), 0, Math.PI * 2);
        ctx.stroke();
      }
    } else {
      const points = [...state.draftPoints, pointerWorld];
      ctx.beginPath();
      const first = worldToScreen(points[0]);
      ctx.moveTo(first.x, first.y);
      for (const pointValue of points.slice(1)) {
        const screen = worldToScreen(pointValue);
        ctx.lineTo(screen.x, screen.y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  if (state.viewMode === "loading" || state.viewMode === "error" || state.viewMode === "empty") {
    drawStateOverlay(ctx, view, state.viewMode);
  }
}

function drawGrid(ctx, view) {
  ctx.save();
  ctx.fillStyle = "#f8fbfd";
  ctx.fillRect(0, 0, view.width, view.height);
  const step = displayGridStep(state.settings.gridInterval * state.camera.scale);
  if (!state.settings.showGrid || step === null) {
    ctx.restore();
    return;
  }
  ctx.strokeStyle = "#e4edf3";
  ctx.lineWidth = 1;
  for (let x = state.camera.x % step; x < view.width; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, view.height);
    ctx.stroke();
  }
  for (let y = state.camera.y % step; y < view.height; y += step) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(view.width, y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawPaper(ctx) {
  const a = worldToScreen({ x: 0, y: 0 });
  const b = worldToScreen({ x: 12000, y: 7000 });
  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#bfd0dc";
  ctx.lineWidth = 2;
  ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
  ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
  ctx.restore();
}

function drawEntity(ctx, entity, overrideColor = null, preview = false) {
  const layer = activeDrawing().layers.find((item) => item.id === entity.layerId);
  if (!layer?.visible) return;
  ctx.save();
  ctx.strokeStyle = overrideColor ?? layer.color;
  ctx.fillStyle = entity.style?.fill === "transparent" ? "transparent" : entity.style?.fill ?? "transparent";
  ctx.lineWidth = preview ? 3 : entity.style?.strokeWidth ?? 2;
  ctx.setLineDash(overrideColor ? [8, 6] : entity.style?.lineDash ?? []);

  if (entity.type === "line") {
    const [a, b] = entity.points.map(worldToScreen);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  if (entity.type === "rect") {
    const a = worldToScreen(entity.origin);
    ctx.strokeRect(a.x, a.y, entity.width * state.camera.scale, entity.height * state.camera.scale);
  }
  if (entity.type === "circle") {
    const center = worldToScreen(entity.center);
    ctx.beginPath();
    ctx.arc(center.x, center.y, entity.radius * state.camera.scale, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (entity.type === "arc") {
    const center = worldToScreen(entity.center);
    ctx.beginPath();
    ctx.arc(
      center.x,
      center.y,
      entity.radius * state.camera.scale,
      (entity.startAngle * Math.PI) / 180,
      (entity.endAngle * Math.PI) / 180,
      false
    );
    ctx.stroke();
  }
  if (entity.type === "ellipse") {
    const center = worldToScreen(entity.center);
    ctx.beginPath();
    ctx.ellipse(
      center.x,
      center.y,
      entity.radiusX * state.camera.scale,
      entity.radiusY * state.camera.scale,
      entity.rotation * Math.PI / 180,
      entity.startParameter,
      entity.endParameter
    );
    ctx.stroke();
  }
  if (entity.type === "spline") {
    const points = sampleSpline(entity).map(worldToScreen);
    if (points.length > 1) {
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (const pointValue of points.slice(1)) ctx.lineTo(pointValue.x, pointValue.y);
      if (entity.closed) ctx.closePath();
      ctx.stroke();
    }
  }
  if (entity.type === "polyline") {
    const points = entity.points.map(worldToScreen);
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (const pointValue of points.slice(1)) ctx.lineTo(pointValue.x, pointValue.y);
    if (entity.closed) ctx.closePath();
    ctx.stroke();
  }
  if (entity.type === "text") {
    const at = worldToScreen(entity.at);
    ctx.fillStyle = overrideColor ?? layer.color;
    ctx.font = `${Math.max(11, entity.size * state.camera.scale)}px sans-serif`;
    ctx.translate(at.x, at.y);
    ctx.rotate((entity.rotation ?? 0) * Math.PI / 180);
    const sx = (entity.generationFlags ?? 0)&2 ? -1 : 1, sy = (entity.generationFlags ?? 0)&4 ? -1 : 1;
    ctx.transform((entity.widthFactor ?? 1)*sx, 0, Math.tan((entity.oblique ?? 0)*Math.PI/180)*sy, sy, 0, 0);
    ctx.fillText(entity.value, 0, 0);
  }
  if (entity.type === "dimension") {
    const geometry = dimensionGeometry(entity);
    const da = worldToScreen(geometry.start), db = worldToScreen(geometry.end);
    ctx.beginPath();
    for (const [start, end] of geometry.segments) {
      const a = worldToScreen(start), b = worldToScreen(end);
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
    const arrow = geometry.arrowSize * state.camera.scale;
    ctx.fillStyle = overrideColor ?? layer.color;
    for (const arrowhead of [{ tip: da, direction: 1 }, { tip: db, direction: -1 }]) {
      const { tip, direction } = arrowhead;
      const angle = Math.atan2(db.y - da.y, db.x - da.x);
      ctx.beginPath(); ctx.moveTo(tip.x, tip.y); ctx.lineTo(tip.x + Math.cos(angle + 0.45) * arrow * direction, tip.y + Math.sin(angle + 0.45) * arrow * direction); ctx.lineTo(tip.x + Math.cos(angle - 0.45) * arrow * direction, tip.y + Math.sin(angle - 0.45) * arrow * direction); ctx.closePath(); ctx.fill();
    }
    ctx.font = `${geometry.textSize * state.camera.scale}px sans-serif`;
    ctx.textAlign = "center";
    const labelPoint = worldToScreen(geometry.textPoint);
    ctx.fillText(geometry.label, labelPoint.x, labelPoint.y);
  }
  if (entity.type === "hatch") {
    const paths = (entity.boundaries ?? [{ points: entity.points }]).map((boundary) => (boundary.points ?? []).map(worldToScreen)).filter((points) => points.length >= 3);
    ctx.beginPath();
    for (const points of paths) { ctx.moveTo(points[0].x, points[0].y); for (const pointValue of points.slice(1)) ctx.lineTo(pointValue.x, pointValue.y); ctx.closePath(); }
    // 塗りつぶしハッチ(DXF group 70=1 または pattern=SOLID)は面で塗る。斜線を重ねても
    // 不透明な塗りに隠れるだけなので、solidの場合は斜線描画そのものを行わない。
    if (entity.solidFill || entity.pattern === "SOLID") {
      ctx.fillStyle = overrideColor ?? layer.color;
      ctx.fill("evenodd");
    } else {
      ctx.stroke(); ctx.clip("evenodd");
      const bounds = entityBounds(entity);
      const a = worldToScreen({ x: bounds.minX, y: bounds.minY });
      const b = worldToScreen({ x: bounds.maxX, y: bounds.maxY });
      const spacing = Math.max(5, entity.spacing * state.camera.scale);
      for (let x = a.x - Math.abs(b.y - a.y); x < b.x + Math.abs(b.y - a.y); x += spacing) {
        ctx.beginPath(); ctx.moveTo(x, b.y); ctx.lineTo(x + (b.y - a.y), a.y); ctx.stroke();
      }
    }
  }
  if (entity.type === "viewport") {
    const bounds = entityBounds(entity);
    const a = worldToScreen({ x: bounds.minX, y: bounds.minY });
    const b = worldToScreen({ x: bounds.maxX, y: bounds.maxY });
    ctx.save(); ctx.setLineDash([8, 5]); ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y); ctx.restore();
  }
  if (entity.type === "block") {
    if (entity.definitionId) {
      for (const child of blockWorldEntities(entity)) drawEntity(ctx, child, overrideColor, preview);
    } else for (const child of entity.children ?? []) {
      const transformed = transformEntity(child, { dx: entity.insertion?.x ?? 0, dy: entity.insertion?.y ?? 0, angle: entity.rotation ?? 0, scale: entity.scale ?? 1 });
      drawEntity(ctx, { ...transformed, layerId: entity.definitionId ? transformed.layerId : entity.layerId }, overrideColor, preview);
    }
    const at = worldToScreen(entity.insertion ?? { x: 0, y: 0 });
    ctx.fillStyle = overrideColor ?? layer.color;
    ctx.font = "11px sans-serif";
    if (!entity.definitionId) ctx.fillText(`${entity.name}${Object.keys(entity.attributes ?? {}).length ? ` [${Object.values(entity.attributes).join(" / ")}]` : ""}`, at.x + 5, at.y - 5);
  }
  ctx.restore();
}

function moveEntity(entity, dx, dy) {
  return transformEntity(entity, { dx, dy });
}

function worldToScreen(point) {
  return {
    x: state.camera.x + point.x * state.camera.scale,
    y: state.camera.y + point.y * state.camera.scale
  };
}

function screenToWorld(x, y) {
  return {
    x: (x - state.camera.x) / state.camera.scale,
    y: (y - state.camera.y) / state.camera.scale
  };
}

function worldViewportBounds(view) {
  const topLeft = screenToWorld(0, 0);
  const bottomRight = screenToWorld(view.width, view.height);
  return {
    minX: Math.min(topLeft.x, bottomRight.x),
    minY: Math.min(topLeft.y, bottomRight.y),
    maxX: Math.max(topLeft.x, bottomRight.x),
    maxY: Math.max(topLeft.y, bottomRight.y)
  };
}

let cachedSpatialIndex = null;
let cachedSpatialIndexEntities = null;

function visibleEntities(entities, viewport) {
  if (cachedSpatialIndexEntities !== entities) {
    cachedSpatialIndex = buildSpatialIndex(entities);
    cachedSpatialIndexEntities = entities;
  }
  return queryBounds(cachedSpatialIndex, viewport);
}

function snapPoint(point) {
  let next = point;
  let snappedToEntity = false;
  if (state.settings.osnapEnabled) {
    const toleranceWorld = 10 / state.camera.scale;
    const candidate = findOsnapPoint(activeDrawing(), point, toleranceWorld, state.settings.osnapModes);
    if (candidate) {
      next = candidate;
      snappedToEntity = true;
    }
  }
  if (!snappedToEntity && state.settings.snapEnabled) {
    const interval = state.settings.gridInterval;
    next = { x: Math.round(next.x / interval) * interval, y: Math.round(next.y / interval) * interval };
  }
  if (!snappedToEntity && state.settings.orthoEnabled && state.draftPoints.length > 0) {
    next = applyOrtho(state.draftPoints[state.draftPoints.length - 1], next);
  }
  return next;
}

function updateCoordReadout(world) {
  const el = document.querySelector("#coordReadout");
  if (el) el.textContent = `${formatNumber(world.x)}, ${formatNumber(world.y)}`;
}

function persist(message) {
  const result = saveDrawing(state.drawing);
  if (result.ok) {
    log(message);
  } else {
    // 保存できなかったことを必ず利用者へ伝える。以前は例外で log/render に到達せず、
    // 「画面には反映されたが何も保存されていない」無言のデータ喪失になっていた。
    state.saveStatus = "failed";
    log(`${message}(ただしローカル保存に失敗: ${result.reason})`);
  }
  render();
}

async function checkApiHealth() {
  state.apiStatus = { state: "loading", message: "確認中", connected: false, roleLocked: false };
  render();
  try {
    const body = await apiRequest("/api/health");
    const drawingBody = await apiRequest("/api/drawings/demo");
    const roleLocked = body.auth.mode !== "demo";
    const selectedRole = roleLocked ? body.auth.role : state.drawing.currentRole;
    const drawingChanged = drawingBody.drawing.id !== state.drawing.id;
    if (drawingChanged) state.layoutDraft = null;
    state.drawing = { ...drawingBody.drawing, currentRole: selectedRole };
    // 別図面へ替わった場合、または起動後まだ表示を操作していない場合だけ、記憶位置の復元・fit判定を行う。
    // 同じ図面の再同期で、利用者が今見ている表示を古い記憶位置へ戻さない。
    if (drawingChanged || state.cameraMode === "default") state.outOfViewFitPending = true;
    else state.boundsRecheckPending = true;
    state.saveStatus = saveDrawing(state.drawing).ok ? "synced" : "failed";
    state.apiStatus = {
      state: "ok",
      message: `${body.service} / ${body.auth.anonymous ? "公開閲覧" : `auth=${body.auth.mode}`} / db=${body.db.mode} / 同期済み`,
      connected: true,
      roleLocked
    };
    try {
      const aiStatusBody = await apiRequest("/api/ai/status");
      state.aiStatus = {
        known: true,
        enabled: aiStatusBody.enabled === true,
        provider: aiStatusBody.provider ?? null,
        model: aiStatusBody.model ?? null
      };
    } catch {
      state.aiStatus = { known: false, enabled: false, provider: null, model: null };
    }
  } catch (error) {
    state.apiStatus = { state: "error", message: `API未接続: ${errorMessage(error)}`, connected: false, roleLocked: true };
  }
  render();
}

async function apiRequest(pathname, options = {}) {
  const response = await fetch(pathname, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-demo-role": state.drawing.currentRole,
      ...options.headers
    }
  });
  const body = await response.json();
  if (!response.ok || !body.ok) {
    throw Object.assign(new Error(body.error ?? `HTTP ${response.status}`), { status: response.status });
  }
  return body;
}

function transactionHeaders() {
  return {
    ...idempotencyHeaders(),
    "expected-version": String(state.drawing.revision ?? 1)
  };
}

function idempotencyHeaders() {
  return { "idempotency-key": globalThis.crypto?.randomUUID?.() ?? `web-${Date.now()}` };
}

function log(message) {
  state.commandLog.push(`${new Date().toLocaleTimeString("ja-JP")} ${message}`);
}

function stateButton(mode, label) {
  return `<button data-view-mode="${mode}" class="${state.viewMode === mode ? "active" : ""}" aria-pressed="${
    state.viewMode === mode
  }">${label}</button>`;
}

function stateLabel(value) {
  return {
    draft: "下書き",
    in_review: "レビュー中",
    approved: "承認済み",
    rejected: "差戻し"
  }[value] ?? value;
}

function saveStatusInfo() {
  if (state.saveStatus === "conflict") {
    return {
      key: "conflict",
      label: "競合",
      description: "サーバー側の版と競合しました。API Healthで最新の状態を再取得してください。"
    };
  }
  if (state.saveStatus === "syncing" || state.apiStatus.state === "loading") {
    return { key: "syncing", label: "同期中", description: "サーバーと同期しています。" };
  }
  if (state.saveStatus === "unsynced") {
    return {
      key: "offline",
      label: "保存に失敗しました",
      description: "直前の変更がサーバーへ反映されていません。変更はこのブラウザにのみ保存されています。再試行するかAPI Healthで状態を確認してください。"
    };
  }
  if (state.apiStatus.connected) {
    return {
      key: "synced",
      label: "サーバー同期済み",
      description: "この図面はサーバーに保存され、他の利用者と共有されています。"
    };
  }
  if (state.apiStatus.state === "error") {
    return {
      key: "offline",
      label: "オフライン",
      description: "サーバーに接続できません。変更はこのブラウザにのみ保存され、他の利用者と共有されません。"
    };
  }
  return {
    key: "local-only",
    label: "ブラウザのみ保存",
    description: "サーバー同期が未確認です。変更はこのブラウザにのみ保存されます。"
  };
}

function layerName(layerId) {
  return state.drawing.layers.find((layer) => layer.id === layerId)?.name ?? layerId;
}

function activeDrawing() {
  if (state.viewMode === "empty") {
    return createDrawing({
      id: "dwg_empty_preview",
      name: "空状態確認",
      currentRole: state.drawing.currentRole,
      layers: structuredClone(state.drawing.layers),
      entities: [],
      commandEvents: [],
      auditLog: []
    });
  }
  return state.drawing;
}

function viewModeLabel(mode) {
  return {
    normal: "正常",
    empty: "空",
    loading: "Loading",
    error: "Error"
  }[mode] ?? mode;
}

function drawStateOverlay(ctx, view, mode) {
  const labels = {
    empty: ["空の図面", "新規作成直後の状態です"],
    loading: ["Loading", "図面データを取得しています"],
    error: ["Error", "APIまたは図面読込に失敗した状態です"]
  };
  const [title, subtitle] = labels[mode] ?? labels.empty;
  ctx.save();
  ctx.fillStyle = "rgba(255, 255, 255, 0.86)";
  ctx.fillRect(0, 0, view.width, view.height);
  ctx.fillStyle = mode === "error" ? "#be3c3c" : "#10253c";
  ctx.textAlign = "center";
  ctx.font = "700 28px sans-serif";
  ctx.fillText(title, view.width / 2, view.height / 2 - 12);
  ctx.fillStyle = "#5f7182";
  ctx.font = "16px sans-serif";
  ctx.fillText(subtitle, view.width / 2, view.height / 2 + 22);
  ctx.restore();
}

function proposalHtml() {
  const proposal = state.previewProposal;
  if (!proposal) return "<p>AI提案はまだありません。Previewで差分を生成します。</p>";
  if (proposal.status === "needs_input") return `<p class="warn">${escapeHtml(proposal.question ?? "追加の情報が必要です。")}</p>`;
  return `
    <dl>
      <dt>Skill</dt><dd>${escapeHtml(proposal.skill?.id ?? "-")}@${escapeHtml(proposal.skill?.version ?? "-")}</dd>
      <dt>Impact</dt><dd>追加 ${escapeHtml(proposal.impact?.add ?? 0)} / 更新 ${escapeHtml(proposal.impact?.update ?? 0)} / 削除 ${escapeHtml(
        proposal.impact?.delete ?? 0
      )}</dd>
      <dt>Gate</dt><dd>${escapeHtml((proposal.postconditions ?? []).join(", "))}</dd>
    </dl>
    ${(proposal.warnings ?? []).map((warning) => `<p class="warn">${escapeHtml(warning)}</p>`).join("")}
  `;
}

function inspectionHtml() {
  const disconnectedNotice =
    state.apiStatus.state !== "ok"
      ? '<p class="warn">検査不能: サーバーに接続できないため、最新の検証結果を保証できません。承認操作は無効化されています。</p>'
      : "";
  const issues = validateDrawing(activeDrawing());
  if (issues.length === 0) return `${disconnectedNotice}<p class="ok">検査OK: Critical/Highなし</p>`;
  return `
    ${disconnectedNotice}
    <ul class="issue-list">
      ${issues
        .map((issue) => `<li class="${issue.severity}"><b>${issue.severity}</b> ${escapeHtml(issue.message)}</li>`)
        .join("")}
    </ul>
  `;
}

function quantityHtml() {
  const value = measurements(activeDrawing());
  return `
    <dl>
      <dt>図形数</dt><dd>${value.entityCount}</dd>
      <dt>総延長</dt><dd>${value.totalLength.toLocaleString()} mm</dd>
      <dt>面積</dt><dd>${value.totalArea.toLocaleString()} mm²</dd>
    </dl>
  `;
}

function withoutIdentity(entity) {
  const { id, ...rest } = entity;
  return rest;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeColor(value) {
  return /^#[0-9a-f]{6}$/i.test(String(value)) ? String(value) : "#5b6b7a";
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function parsePointValue(value, label) {
  const parts = String(value).split(",").map(Number);
  if (parts.length !== 2 || !parts.every(Number.isFinite)) throw new Error(`${label}形式で入力してください。`);
  return { x: parts[0], y: parts[1] };
}

function parseNumberValue(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label}を数値で入力してください。`);
  return parsed;
}

function parseVertexNumber(value) {
  const parsed = parseNumberValue(value, "頂点番号");
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error("頂点番号は1以上の整数で入力してください。");
  return parsed - 1;
}

function parseTwoPointsValue(value, label) {
  const tokens = String(value).trim().split(/\s+/);
  if (tokens.length !== 2) throw new Error(`${label}形式で入力してください。`);
  return tokens.map((token) => parsePointValue(token, label));
}

function parseArrayValue(value) {
  const tokens = String(value).trim().split(/\s+/);
  if (tokens.length !== 4) throw new Error("列数 行数 列間隔 行間隔 の4値を入力してください(例: 2 3 1000 800)。");
  const columns = parseNumberValue(tokens[0], "列数");
  const rows = parseNumberValue(tokens[1], "行数");
  if (columns < 1 || rows < 1 || !Number.isInteger(columns) || !Number.isInteger(rows)) throw new Error("列数・行数は1以上の整数で指定してください。");
  const columnDistance = parseNumberValue(tokens[2], "列間隔");
  const rowDistance = parseNumberValue(tokens[3], "行間隔");
  return { columns, rows, columnDistance, rowDistance };
}

function entityAnchor(entity) {
  return entity.center ?? entity.origin ?? entity.at ?? entity.insertion ?? entity.points?.[0] ?? entity.controlPoints?.[0] ?? { x: 0, y: 0 };
}

function formatNumber(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function parseAttributes(value) {
  return Object.fromEntries(String(value).split(";").map((pair) => pair.split("=")).filter(([key, item]) => key?.trim() && item !== undefined).map(([key, item]) => [key.trim().slice(0, 40), item.trim().slice(0, 200)]));
}

function loadUserSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(USER_SETTINGS_KEY) ?? "null");
    const gridInterval = Number(stored?.gridInterval);
    const commandLogLines = Number(stored?.commandLogLines);
    const dimensionOffset = Number(stored?.dimensionOffset);
    const dimensionPrecision = Number(stored?.dimensionPrecision);
    const dockWidth = Number(stored?.dockWidth);
    return {
      showGrid: typeof stored?.showGrid === "boolean" ? stored.showGrid : DEFAULT_USER_SETTINGS.showGrid,
      snapEnabled: typeof stored?.snapEnabled === "boolean" ? stored.snapEnabled : DEFAULT_USER_SETTINGS.snapEnabled,
      orthoEnabled: typeof stored?.orthoEnabled === "boolean" ? stored.orthoEnabled : DEFAULT_USER_SETTINGS.orthoEnabled,
      osnapEnabled: typeof stored?.osnapEnabled === "boolean" ? stored.osnapEnabled : DEFAULT_USER_SETTINGS.osnapEnabled,
      osnapModes: sanitizeOsnapModes(stored?.osnapModes),
      gridInterval: GRID_INTERVALS.has(gridInterval) ? gridInterval : DEFAULT_USER_SETTINGS.gridInterval,
      commandLogLines: [1, 2, 3].includes(commandLogLines) ? commandLogLines : DEFAULT_USER_SETTINGS.commandLogLines,
      dimensionOffset: Number.isFinite(dimensionOffset) && dimensionOffset >= 0 ? dimensionOffset : DEFAULT_USER_SETTINGS.dimensionOffset,
      dimensionPrecision: [0, 1, 2, 3].includes(dimensionPrecision) ? dimensionPrecision : DEFAULT_USER_SETTINGS.dimensionPrecision,
      dimensionSuffix: typeof stored?.dimensionSuffix === "string" ? stored.dimensionSuffix.slice(0, 12) : DEFAULT_USER_SETTINGS.dimensionSuffix,
      dockWidth: Number.isFinite(dockWidth) ? Math.min(DOCK_WIDTH_MAX, Math.max(DOCK_WIDTH_MIN, dockWidth)) : DEFAULT_USER_SETTINGS.dockWidth,
      theme: THEMES.has(stored?.theme) ? stored.theme : DEFAULT_USER_SETTINGS.theme
    };
  } catch {
    return { ...DEFAULT_USER_SETTINGS };
  }
}

function saveUserSettings() {
  // 設定の保存に失敗しても操作を止めない(容量超過等)。失敗は画面に出し、
  // renderまで到達させる(以前は例外で以降の処理が走らなかった)。
  try {
    localStorage.setItem(USER_SETTINGS_KEY, JSON.stringify(state.settings));
    return { ok: true };
  } catch {
    state.settingsSaveError = true;
    return { ok: false };
  }
}

function applyTheme(theme) {
  if (theme === "light" || theme === "dark") {
    document.documentElement.dataset.theme = theme;
  } else {
    delete document.documentElement.dataset.theme;
  }
}

try {
  localStorage.removeItem(LEGACY_AI_SETTINGS_KEY);
} catch {
  // LocalStorageが利用できない環境では何もしない。
}
applyTheme(state.settings.theme);
// 表示寸法の変化でbacking storeを追従させる(カメラは維持)。
window.addEventListener("resize", () => drawCanvas());
window.addEventListener("pagehide", flushViewSave);
render();
checkApiHealth();
