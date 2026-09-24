// 表示カメラとCanvas寸法の純粋な計算。DOM状態は引数で受け取り、app.jsから利用する。

/** ホイール・ボタン操作のカメラ縮尺範囲(画面px/図面単位)。ZOOM EXTENTSは下限に縛られない。 */
export const CAMERA_MIN_SCALE = 0.0001;
export const CAMERA_MAX_SCALE = 2;
/** 小さな図面をZOOM EXTENTSで過大表示しない上限。 */
export const FIT_MAX_SCALE = 0.5;
/** ZOOM EXTENTSで図面境界の外側に確保する余白(画面px)。 */
export const FIT_MARGIN = 50;
/** 表示格子の最小間隔(画面px)。これより密な縮尺では格子間隔を10倍ずつ粗くする。 */
export const MIN_GRID_STEP_PX = 4;
/** Canvasの実寸が得られない場合(未配置・非表示)の既定backing store寸法。 */
export const DEFAULT_CANVAS_SIZE = Object.freeze({ width: 1180, height: 760 });

/**
 * ホイール・ボタン操作後の縮尺を範囲内へ丸める。ZOOM EXTENTSで下限未満になっている場合は、
 * 拡大操作で下限へ跳ばないよう現在の縮尺を下限として扱う。
 * @param {number} scale
 * @param {number} [current] 操作前の縮尺
 */
export function clampCameraScale(scale, current = CAMERA_MIN_SCALE) {
  const floor = Number.isFinite(current) && current > 0 ? Math.min(CAMERA_MIN_SCALE, current) : CAMERA_MIN_SCALE;
  if (!Number.isFinite(scale)) return floor;
  return Math.min(CAMERA_MAX_SCALE, Math.max(floor, scale));
}

/**
 * 図形境界の一覧を、四辺にFIT_MARGIN以上の余白を置いて画面中央へ収めるカメラを返す。
 * @param {{ minX: number, minY: number, maxX: number, maxY: number }[]} bounds
 * @param {{ width: number, height: number }} viewport Canvasの表示寸法(CSS px)
 */
export function fitCameraToBounds(bounds, viewport) {
  if (bounds.length === 0) return { x: 45, y: 45, scale: 0.08 };
  const minX = Math.min(...bounds.map((value) => value.minX));
  const minY = Math.min(...bounds.map((value) => value.minY));
  const maxX = Math.max(...bounds.map((value) => value.maxX));
  const maxY = Math.max(...bounds.map((value) => value.maxY));
  const width = Math.max(maxX - minX, 100);
  const height = Math.max(maxY - minY, 100);
  const availableWidth = Math.max(viewport.width - FIT_MARGIN * 2, 1);
  const availableHeight = Math.max(viewport.height - FIT_MARGIN * 2, 1);
  // 操作用の縮尺下限は適用しない。超巨大図面でも余白を保って全体を収める。
  const scale = Math.min(FIT_MAX_SCALE, availableWidth / width, availableHeight / height);
  return {
    x: viewport.width / 2 - ((minX + maxX) / 2) * scale,
    y: viewport.height / 2 - ((minY + maxY) / 2) * scale,
    scale
  };
}

/**
 * backing store寸法をCSS表示寸法×devicePixelRatioへ合わせ、縦横比の歪み・ポインター座標のずれ・
 * 高DPI画面でのぼやけを防ぐ。表示寸法が0(未配置・非表示)の場合は既存寸法を維持する。
 * @param {{ width: number, height: number, clientWidth: number, clientHeight: number }} canvas
 * @param {number} [pixelRatio] window.devicePixelRatio
 * @returns {boolean} 寸法を変更した場合true
 */
export function syncCanvasBackingSize(canvas, pixelRatio = 1) {
  const ratio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1;
  const width = Math.round(canvas.clientWidth * ratio);
  const height = Math.round(canvas.clientHeight * ratio);
  if (width <= 0 || height <= 0) return false;
  if (canvas.width === width && canvas.height === height) return false;
  canvas.width = width;
  canvas.height = height;
  return true;
}

/**
 * 表示用の格子間隔(画面px)を返す。縮小表示で格子が密になりすぎる場合は間隔を10倍ずつ広げ、
 * 1フレームで数万本の格子線を描かないようにする(適応格子)。スナップ間隔は変えない。
 * @param {number} stepPx 設定上の格子間隔を画面pxへ換算した値
 * @returns {number | null} 描画できない値の場合null
 */
export function displayGridStep(stepPx) {
  if (!Number.isFinite(stepPx) || stepPx <= 0) return null;
  let step = stepPx;
  while (step < MIN_GRID_STEP_PX) step *= 10;
  return step;
}

/**
 * 描画・カメラ計算に使うCanvasの表示寸法(CSS px)。非表示時はbacking store寸法を使う。
 * @param {{ width: number, height: number, clientWidth: number, clientHeight: number }} canvas
 */
export function canvasViewSize(canvas) {
  if (canvas.clientWidth > 0 && canvas.clientHeight > 0) return { width: canvas.clientWidth, height: canvas.clientHeight };
  return { width: canvas.width, height: canvas.height };
}

/**
 * 図形境界の全体が、カメラで画面内に表示されているか。起動時に既定表示で収まらない図面だけを
 * ZOOM EXTENTSする判定に使う。図形がない場合はtrue。
 */
export function boundsVisibleInView(bounds, camera, viewport) {
  return bounds.every((value) => {
    const left = camera.x + value.minX * camera.scale;
    const top = camera.y + value.minY * camera.scale;
    const right = camera.x + value.maxX * camera.scale;
    const bottom = camera.y + value.maxY * camera.scale;
    return left >= 0 && top >= 0 && right <= viewport.width && bottom <= viewport.height;
  });
}

/**
 * ステータス表示用のズーム率。従来のscale×1000%表記を保ち、1%未満でも0%へ丸めないよう
 * 桁数を縮尺に応じて変える。
 */
export function formatZoomPercent(scale) {
  const percent = scale * 1000;
  if (!Number.isFinite(percent) || percent <= 0) return "0%";
  if (percent >= 10) return `${Math.round(percent)}%`;
  if (percent >= 1) return `${Number(percent.toFixed(1))}%`;
  return `${Number(percent.toPrecision(2))}%`;
}

/** 図面ごとに記憶する表示位置の上限件数(古いものから破棄)。 */
export const SAVED_VIEW_LIMIT = 30;

/**
 * カメラを、Canvas寸法に依存しない「表示中心の図面座標+縮尺」へ変換する。
 * @param {{ x: number, y: number, scale: number }} camera
 * @param {{ width: number, height: number }} viewport Canvasの表示寸法(CSS px)
 */
export function cameraToSavedView(camera, viewport) {
  return {
    cx: (viewport.width / 2 - camera.x) / camera.scale,
    cy: (viewport.height / 2 - camera.y) / camera.scale,
    scale: camera.scale
  };
}

/** 保存した表示位置を、現在のCanvas寸法で同じ中心・縮尺になるカメラへ戻す。 */
export function savedViewToCamera(view, viewport) {
  return { x: viewport.width / 2 - view.cx * view.scale, y: viewport.height / 2 - view.cy * view.scale, scale: view.scale };
}

function validSavedView(view) {
  return Boolean(view) && typeof view === "object"
    && Number.isFinite(view.cx) && Number.isFinite(view.cy)
    && Number.isFinite(view.scale) && view.scale > 0 && view.scale <= CAMERA_MAX_SCALE
    && Number.isFinite(view.savedAt);
}

/**
 * ブラウザ保存値を検証して読み込む。壊れた値・不正な項目は捨てる(表示位置は利便機能のため失敗しても既定表示へ戻すだけ)。
 * @param {string | null} raw
 * @returns {Record<string, { cx: number, cy: number, scale: number, savedAt: number }>}
 */
export function parseSavedViews(raw) {
  /** @type {Record<string, { cx: number, cy: number, scale: number, savedAt: number }>} */
  const views = {};
  try {
    const parsed = JSON.parse(raw ?? "null");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return views;
    for (const [drawingId, view] of Object.entries(parsed)) {
      if (validSavedView(view)) views[drawingId] = { cx: view.cx, cy: view.cy, scale: view.scale, savedAt: view.savedAt };
    }
  } catch {
    // 破損した保存値は無視する。
  }
  return views;
}

/** 図面の表示位置を記録し、上限を超えた古い記録を破棄した新しい一覧を返す。 */
export function rememberSavedView(views, drawingId, view, savedAt) {
  const next = { ...views, [drawingId]: { cx: view.cx, cy: view.cy, scale: view.scale, savedAt } };
  const ids = Object.keys(next).sort((a, b) => next[b].savedAt - next[a].savedAt);
  for (const id of ids.slice(SAVED_VIEW_LIMIT)) delete next[id];
  return next;
}

/** 表示範囲に図形境界が1つでも入っているか。保存位置が図面から外れている場合は復元せずfitする判定に使う。 */
export function boundsIntersectView(bounds, camera, viewport) {
  return bounds.some((value) => {
    const left = camera.x + value.minX * camera.scale;
    const top = camera.y + value.minY * camera.scale;
    const right = camera.x + value.maxX * camera.scale;
    const bottom = camera.y + value.maxY * camera.scale;
    return right >= 0 && bottom >= 0 && left <= viewport.width && top <= viewport.height;
  });
}
