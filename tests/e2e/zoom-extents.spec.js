import { expect, test } from "@playwright/test";
import { circle, createDrawing, entityBounds, line } from "../../src/cad-core.js";
import { FIT_MARGIN, fitCameraToBounds, formatZoomPercent } from "../../src/cad-view.js";

// Issue #78: 非公開サンプルの代わりに、60,000mm級の合成図形で表示回帰を検査する。
const drawing = createDrawing({ currentRole: "drafter", entities: [
  line("layer-structure", [0, 0], [60000, 0], { id: "frame-top" }),
  line("layer-structure", [60000, 0], [60000, 40000], { id: "frame-right" }),
  line("layer-structure", [0, 40000], [60000, 40000], { id: "frame-bottom" }),
  line("layer-structure", [4000, 2000], [20000, 2000], { id: "target" }),
  circle("layer-structure", [10000, 9000], 6000, { id: "big-circle" })
] });

test.beforeEach(async ({ page }, testInfo) => {
  if (testInfo.project.name === "desktop-chromium") await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript((doc) => { if (!localStorage.getItem("mirai-web-cad-mvp")) localStorage.setItem("mirai-web-cad-mvp", JSON.stringify(doc)); }, drawing);
  await page.route("**/api/**", (route) => route.abort());
  await page.goto("/");
  await expect(page.locator(".save-status")).toHaveText("オフライン");
  await page.locator("#commandInput").fill("ZOOM E");
  await page.locator("#commandInput").press("Enter");
});

const canvasSize = (page) => page.locator("#cadCanvas").evaluate((element) => ({
  width: element.width, height: element.height, clientWidth: element.clientWidth, clientHeight: element.clientHeight, ratio: window.devicePixelRatio
}));

async function screenPoint(page, x, y) {
  const size = await canvasSize(page);
  const camera = fitCameraToBounds(drawing.entities.map(entityBounds), { width: size.clientWidth, height: size.clientHeight });
  return { x: camera.x + x * camera.scale, y: camera.y + y * camera.scale };
}

test("ZOOM EXTENTS fits a 60,000mm drawing inside the margins with an undistorted canvas", async ({ page }, testInfo) => {
  const size = await canvasSize(page);
  // backing storeがCSS表示寸法×devicePixelRatioと一致すれば、円の横径と縦径のCSS表示が等しく、高DPIでもぼやけない。
  expect(size.width).toBe(Math.round(size.clientWidth * size.ratio));
  expect(size.height).toBe(Math.round(size.clientHeight * size.ratio));
  if (testInfo.project.name === "mobile-chromium") expect(size.ratio).toBeGreaterThan(1);
  const topLeft = await screenPoint(page, 0, 0);
  const bottomRight = await screenPoint(page, 60000, 40000);
  expect(topLeft.x).toBeGreaterThanOrEqual(FIT_MARGIN - 1e-6);
  expect(topLeft.y).toBeGreaterThanOrEqual(FIT_MARGIN - 1e-6);
  expect(bottomRight.x).toBeLessThanOrEqual(size.clientWidth - FIT_MARGIN + 1e-6);
  expect(bottomRight.y).toBeLessThanOrEqual(size.clientHeight - FIT_MARGIN + 1e-6);
  // 中央寄せ: 左右・上下の余白が等しい。
  expect(topLeft.x).toBeCloseTo(size.clientWidth - bottomRight.x, 6);
  expect(topLeft.y).toBeCloseTo(size.clientHeight - bottomRight.y, 6);
  // 右下隅の図形が実際に描画されていること(縮尺下限で画面外へ切れていた不具合の回帰)。
  const painted = await page.locator("#cadCanvas").evaluate((element, point) => {
    const ratio = element.width / element.clientWidth;
    const data = element.getContext("2d").getImageData(Math.round(point.x * ratio) - 4, Math.round(point.y * ratio) - 4, 9, 9).data;
    const background = element.getContext("2d").getImageData(2, 2, 1, 1).data;
    let differs = 0;
    for (let index = 0; index < data.length; index += 4) if (Math.abs(data[index] - background[0]) + Math.abs(data[index + 1] - background[1]) + Math.abs(data[index + 2] - background[2]) > 60) differs++;
    return differs;
  }, bottomRight);
  expect(painted).toBeGreaterThan(0);
  // 縮尺表示はfit確定後のカメラと一致する(render時の暫定縮尺が残らない)。
  const camera = fitCameraToBounds(drawing.entities.map(entityBounds), { width: size.clientWidth, height: size.clientHeight });
  const expected = formatZoomPercent(camera.scale);
  await expect(page.locator(".zoom-readout")).toHaveText(expected);
  await expect(page.locator("#scaleReadout")).toHaveText(`縮尺 ${expected}`);
  // ホイールズームはrenderを経由しないが、縮尺表示は追従する。
  const box = await page.locator("#cadCanvas").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 100);
  await expect(page.locator(".zoom-readout")).toHaveText(formatZoomPercent(camera.scale * 0.9));
  await testInfo.attach("zoom-extents", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
});

test("pointer picking and OSnap follow the fitted camera after ZOOM EXTENTS", async ({ page }) => {
  const canvas = page.locator("#cadCanvas");
  const target = await screenPoint(page, 12000, 2000);
  await canvas.click({ position: { x: target.x, y: target.y } });
  await expect(page.getByText("選択: 1件 / target", { exact: true })).toBeVisible();
  const quadrant = await screenPoint(page, 16000, 9000);
  await canvas.click({ position: { x: quadrant.x, y: quadrant.y } });
  await expect(page.getByText("選択: 1件 / big-circle", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "システム設定" }).click();
  await page.getByLabel("図形スナップ（OSnap）").check();
  await page.getByRole("button", { name: "適用", exact: true }).click();
  await page.getByRole("button", { name: "線", exact: true }).click();
  await canvas.click({ position: { x: quadrant.x + 3, y: quadrant.y - 2 } });
  const end = await screenPoint(page, 30000, 9000);
  await canvas.click({ position: { x: end.x, y: end.y } });
  const created = await page.evaluate(() => {
    const doc = JSON.parse(localStorage.getItem("mirai-web-cad-mvp"));
    return doc.entities[doc.entities.length - 1];
  });
  expect(created.type).toBe("line");
  expect(created.points[0]).toEqual({ x: 16000, y: 9000 });
});

test("reload fits a drawing that does not fit the default view, and the zoom readout is not 0%", async ({ page }) => {
  await page.reload();
  await expect(page.locator(".save-status")).toHaveText("オフライン");
  const bottomRight = await screenPoint(page, 60000, 40000);
  const size = await canvasSize(page);
  expect(bottomRight.x).toBeLessThanOrEqual(size.clientWidth - FIT_MARGIN + 1e-6);
  expect(bottomRight.y).toBeLessThanOrEqual(size.clientHeight - FIT_MARGIN + 1e-6);
  await expect(page.locator(".zoom-readout")).not.toHaveText("0%");
  await expect(page.locator(".zoom-readout")).toHaveText(/^\d+(\.\d+)?%$/);
});
