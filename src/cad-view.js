// 表示カメラとCanvas寸法の純粋な計算。DOM状態は引数で受け取り、app.jsから利用する。

/** ホイール・ボタン・ZOOM EXTENTSで共通のカメラ縮尺範囲(画面px/図面単位)。 */
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

export function clampCameraScale(scale) {
  if (!Number.isFinite(scale)) return CAMERA_MIN_SCALE;
  return Math.min(CAMERA_MAX_SCALE, Math.max(CAMERA_MIN_SCALE, scale));
}

/**
 * 図形境界の一覧を、左上へFIT_MARGIN余白を置いたまま画面内へ収めるカメラを返す。
 * @param {{ minX: number, minY: number, maxX: number, maxY: number }[]} bounds
 * @param {{ width: number, height: number }} viewport Canvasのbacking store寸法(=CSS表示寸法)
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
  const scale = clampCameraScale(Math.min(FIT_MAX_SCALE, availableWidth / width, availableHeight / height));
  return { x: FIT_MARGIN - minX * scale, y: FIT_MARGIN - minY * scale, scale };
}

/**
 * CSS表示寸法とbacking store寸法を一致させ、縦横比の歪みとポインター座標のずれを防ぐ。
 * 表示寸法が0(未配置・非表示)の場合は既存寸法を維持する。
 * @param {{ width: number, height: number, clientWidth: number, clientHeight: number }} canvas
 * @returns {boolean} 寸法を変更した場合true
 */
export function syncCanvasBackingSize(canvas) {
  const width = Math.round(canvas.clientWidth);
  const height = Math.round(canvas.clientHeight);
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
