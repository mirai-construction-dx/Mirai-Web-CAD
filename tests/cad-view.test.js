import test from "node:test";
import assert from "node:assert/strict";
import { boundsIntersectView, boundsVisibleInView, cameraToSavedView, parseSavedViews, rememberSavedView, SAVED_VIEW_LIMIT, savedViewToCamera, CAMERA_MAX_SCALE, CAMERA_MIN_SCALE, canvasViewSize, clampCameraScale, displayGridStep, MIN_GRID_STEP_PX, FIT_MARGIN, FIT_MAX_SCALE, fitCameraToBounds, formatZoomPercent, syncCanvasBackingSize } from "../src/cad-view.js";

const toScreen = (camera, x, y) => ({ x: camera.x + x * camera.scale, y: camera.y + y * camera.scale });

function assertInsideMargins(camera, bounds, viewport) {
  const topLeft = toScreen(camera, bounds.minX, bounds.minY);
  const bottomRight = toScreen(camera, bounds.maxX, bounds.maxY);
  assert.ok(topLeft.x >= FIT_MARGIN - 1e-6 && topLeft.y >= FIT_MARGIN - 1e-6, JSON.stringify(topLeft));
  assert.ok(bottomRight.x <= viewport.width - FIT_MARGIN + 1e-6, JSON.stringify(bottomRight));
  assert.ok(bottomRight.y <= viewport.height - FIT_MARGIN + 1e-6, JSON.stringify(bottomRight));
}

test("ZOOM EXTENTS fits a 60,000mm drawing inside the margins without the old 0.025 floor (Issue #78)", () => {
  const bounds = { minX: -5000, minY: 2000, maxX: 55000, maxY: 32000 };
  const viewport = { width: 1180, height: 760 };
  const camera = fitCameraToBounds([bounds], viewport);
  assert.ok(camera.scale < 0.025, `scale ${camera.scale}`);
  assertInsideMargins(camera, bounds, viewport);
});

test("ZOOM EXTENTS uses the actual canvas size for desktop and mobile viewports", () => {
  const bounds = { minX: 0, minY: 0, maxX: 20000, maxY: 12000 };
  for (const viewport of [{ width: 1600, height: 900 }, { width: 393, height: 360 }]) {
    const camera = fitCameraToBounds([bounds], viewport);
    assertInsideMargins(camera, bounds, viewport);
    const center = toScreen(camera, 10000, 6000);
    assert.ok(Math.abs(center.x - viewport.width / 2) < 1e-9 && Math.abs(center.y - viewport.height / 2) < 1e-9);
    const limiting = Math.min((viewport.width - FIT_MARGIN * 2) / 20000, (viewport.height - FIT_MARGIN * 2) / 12000);
    assert.equal(camera.scale, limiting);
  }
});

test("ZOOM EXTENTS merges every entity bound, centers it and keeps small drawings at the fit cap", () => {
  const camera = fitCameraToBounds([{ minX: 400, minY: 400, maxX: 1600, maxY: 400 }, { minX: 400, minY: 1000, maxX: 1600, maxY: 1000 }], { width: 1180, height: 760 });
  assert.deepEqual(camera, { x: 590 - 1000 * FIT_MAX_SCALE, y: 380 - 700 * FIT_MAX_SCALE, scale: FIT_MAX_SCALE });
  assert.deepEqual(fitCameraToBounds([], { width: 1180, height: 760 }), { x: 45, y: 45, scale: 0.08 });
});

test("ZOOM EXTENTS stays finite for a viewport smaller than the margins and for huge extents", () => {
  const tiny = fitCameraToBounds([{ minX: 0, minY: 0, maxX: 1000, maxY: 1000 }], { width: 60, height: 40 });
  assert.ok(Number.isFinite(tiny.scale) && tiny.scale >= CAMERA_MIN_SCALE);
  const hugeBounds = { minX: 0, minY: 0, maxX: 1e9, maxY: 1e9 };
  const huge = fitCameraToBounds([hugeBounds], { width: 1180, height: 760 });
  assert.ok(huge.scale > 0 && huge.scale < CAMERA_MIN_SCALE, String(huge.scale));
  assertInsideMargins(huge, hugeBounds, { width: 1180, height: 760 });
});

test("camera scale clamp is shared by wheel, zoom buttons and fit", () => {
  assert.equal(clampCameraScale(10), CAMERA_MAX_SCALE);
  assert.equal(clampCameraScale(0), CAMERA_MIN_SCALE);
  assert.equal(clampCameraScale(Number.NaN), CAMERA_MIN_SCALE);
  assert.equal(clampCameraScale(0.3), 0.3);
  // ZOOM EXTENTSで下限未満になった後の拡大は、下限へ跳ばず現在の縮尺から続く。
  assert.equal(clampCameraScale(0.00001 * 1.12, 0.00001), 0.00001 * 1.12);
  assert.equal(clampCameraScale(0.00001 * 0.9, 0.00001), 0.00001);
});

test("canvas backing store follows the CSS size so circles are not stretched", () => {
  const canvas = { width: 1180, height: 760, clientWidth: 1203.4, clientHeight: 511.6 };
  assert.equal(syncCanvasBackingSize(canvas), true);
  assert.deepEqual([canvas.width, canvas.height], [1203, 512]);
  assert.equal(syncCanvasBackingSize(canvas), false);
  const retina = { width: 1180, height: 760, clientWidth: 393, clientHeight: 360 };
  assert.equal(syncCanvasBackingSize(retina, 2.625), true);
  assert.deepEqual([retina.width, retina.height], [1032, 945]);
  assert.deepEqual(canvasViewSize(retina), { width: 393, height: 360 });
  assert.equal(syncCanvasBackingSize({ width: 1, height: 1, clientWidth: 10, clientHeight: 10 }, Number.NaN), true);
  const hidden = { width: 1180, height: 760, clientWidth: 0, clientHeight: 0 };
  assert.equal(syncCanvasBackingSize(hidden), false);
  assert.deepEqual([hidden.width, hidden.height], [1180, 760]);
});

test("display grid coarsens by powers of ten instead of drawing tens of thousands of lines", () => {
  assert.equal(displayGridStep(25), 25);
  assert.equal(displayGridStep(2.1), 21);
  const tiny = displayGridStep(250 * CAMERA_MIN_SCALE);
  assert.ok(tiny >= MIN_GRID_STEP_PX && tiny < MIN_GRID_STEP_PX * 10, String(tiny));
  assert.equal(displayGridStep(0), null);
  assert.equal(displayGridStep(Number.NaN), null);
});

test("startup fits only drawings that do not fit the default view", () => {
  const camera = { x: 50, y: 40, scale: 0.075 };
  const viewport = { width: 1000, height: 600 };
  assert.equal(boundsVisibleInView([{ minX: 400, minY: 400, maxX: 1600, maxY: 1000 }], camera, viewport), true);
  assert.equal(boundsVisibleInView([{ minX: 0, minY: 0, maxX: 60000, maxY: 40000 }], camera, viewport), false);
  assert.equal(boundsVisibleInView([{ minX: -1000, minY: 0, maxX: 10, maxY: 10 }], camera, viewport), false);
  assert.equal(boundsVisibleInView([], camera, viewport), true);
});

test("zoom readout keeps significant digits below 1% instead of rounding to 0%", () => {
  assert.equal(formatZoomPercent(0.075), "75%");
  assert.equal(formatZoomPercent(0.0157), "16%");
  assert.equal(formatZoomPercent(0.00157), "1.6%");
  assert.equal(formatZoomPercent(0.0001), "0.1%");
  assert.equal(formatZoomPercent(0.0000123), "0.012%");
  assert.equal(formatZoomPercent(0), "0%");
});

test("saved views keep the world center and scale across canvas sizes", () => {
  const camera = { x: 120, y: -40, scale: 0.02 };
  const view = cameraToSavedView(camera, { width: 1000, height: 600 });
  assert.deepEqual(savedViewToCamera(view, { width: 1000, height: 600 }), camera);
  const resized = savedViewToCamera(view, { width: 400, height: 300 });
  assert.equal(resized.scale, camera.scale);
  assert.ok(Math.abs((200 - resized.x) / resized.scale - view.cx) < 1e-9);
  assert.ok(Math.abs((150 - resized.y) / resized.scale - view.cy) < 1e-9);
});

test("saved views are validated and pruned to the most recent entries", () => {
  assert.deepEqual(parseSavedViews(null), {});
  assert.deepEqual(parseSavedViews("{broken"), {});
  assert.deepEqual(parseSavedViews("[1,2]"), {});
  const parsed = parseSavedViews(JSON.stringify({
    ok: { cx: 1, cy: 2, scale: 0.5, savedAt: 10, extra: "dropped" },
    nan: { cx: "1", cy: 2, scale: 0.5, savedAt: 10 },
    zero: { cx: 1, cy: 2, scale: 0, savedAt: 10 },
    huge: { cx: 1, cy: 2, scale: 1e9, savedAt: 10 }
  }));
  assert.deepEqual(parsed, { ok: { cx: 1, cy: 2, scale: 0.5, savedAt: 10 } });
  let views = {};
  for (let index = 0; index < SAVED_VIEW_LIMIT + 5; index += 1) views = rememberSavedView(views, `d${index}`, { cx: index, cy: 0, scale: 1 }, index);
  assert.equal(Object.keys(views).length, SAVED_VIEW_LIMIT);
  assert.ok(!("d0" in views) && "d34" in views);
  views = rememberSavedView(views, "d5", { cx: 9, cy: 9, scale: 0.1 }, 100);
  assert.deepEqual(views.d5, { cx: 9, cy: 9, scale: 0.1, savedAt: 100 });
});

test("a saved view is only restored when it still shows part of the drawing", () => {
  const camera = { x: 0, y: 0, scale: 1 };
  const viewport = { width: 100, height: 100 };
  assert.equal(boundsIntersectView([{ minX: 90, minY: 90, maxX: 200, maxY: 200 }], camera, viewport), true);
  assert.equal(boundsIntersectView([{ minX: 101, minY: 0, maxX: 200, maxY: 50 }], camera, viewport), false);
  assert.equal(boundsIntersectView([], camera, viewport), false);
});
