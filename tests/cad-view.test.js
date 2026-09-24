import test from "node:test";
import assert from "node:assert/strict";
import { CAMERA_MAX_SCALE, CAMERA_MIN_SCALE, clampCameraScale, displayGridStep, MIN_GRID_STEP_PX, FIT_MARGIN, FIT_MAX_SCALE, fitCameraToBounds, syncCanvasBackingSize } from "../src/cad-view.js";

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
    const limiting = Math.min((viewport.width - FIT_MARGIN * 2) / 20000, (viewport.height - FIT_MARGIN * 2) / 12000);
    assert.equal(camera.scale, limiting);
  }
});

test("ZOOM EXTENTS merges every entity bound and keeps small drawings at the fit cap", () => {
  const camera = fitCameraToBounds([{ minX: 400, minY: 400, maxX: 1600, maxY: 400 }, { minX: 400, minY: 1000, maxX: 1600, maxY: 1000 }], { width: 1180, height: 760 });
  assert.deepEqual(camera, { x: FIT_MARGIN - 400 * FIT_MAX_SCALE, y: FIT_MARGIN - 400 * FIT_MAX_SCALE, scale: FIT_MAX_SCALE });
  assert.deepEqual(fitCameraToBounds([], { width: 1180, height: 760 }), { x: 45, y: 45, scale: 0.08 });
});

test("ZOOM EXTENTS stays finite for a viewport smaller than the margins and for huge extents", () => {
  const tiny = fitCameraToBounds([{ minX: 0, minY: 0, maxX: 1000, maxY: 1000 }], { width: 60, height: 40 });
  assert.ok(Number.isFinite(tiny.scale) && tiny.scale >= CAMERA_MIN_SCALE);
  const huge = fitCameraToBounds([{ minX: 0, minY: 0, maxX: 1e9, maxY: 1e9 }], { width: 1180, height: 760 });
  assert.equal(huge.scale, CAMERA_MIN_SCALE);
});

test("camera scale clamp is shared by wheel, zoom buttons and fit", () => {
  assert.equal(clampCameraScale(10), CAMERA_MAX_SCALE);
  assert.equal(clampCameraScale(0), CAMERA_MIN_SCALE);
  assert.equal(clampCameraScale(Number.NaN), CAMERA_MIN_SCALE);
  assert.equal(clampCameraScale(0.3), 0.3);
});

test("canvas backing store follows the CSS size so circles are not stretched", () => {
  const canvas = { width: 1180, height: 760, clientWidth: 1203.4, clientHeight: 511.6 };
  assert.equal(syncCanvasBackingSize(canvas), true);
  assert.deepEqual([canvas.width, canvas.height], [1203, 512]);
  assert.equal(syncCanvasBackingSize(canvas), false);
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
