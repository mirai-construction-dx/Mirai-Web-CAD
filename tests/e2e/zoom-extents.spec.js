import { expect, test } from "@playwright/test";
import { circle, createDrawing, entityBounds, line } from "../../src/cad-core.js";
import { FIT_MARGIN, fitCameraToBounds } from "../../src/cad-view.js";

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
  width: element.width, height: element.height, clientWidth: element.clientWidth, clientHeight: element.clientHeight
}));

async function screenPoint(page, x, y) {
  const size = await canvasSize(page);
  const camera = fitCameraToBounds(drawing.entities.map(entityBounds), size);
  return { x: camera.x + x * camera.scale, y: camera.y + y * camera.scale };
}

test("ZOOM EXTENTS fits a 60,000mm drawing inside the margins with an undistorted canvas", async ({ page }, testInfo) => {
  const size = await canvasSize(page);
  // backing storeとCSS表示寸法が一致すれば、円の横径と縦径のCSS表示が等しくなる。
  expect(size.width).toBe(size.clientWidth);
  expect(size.height).toBe(size.clientHeight);
  const topLeft = await screenPoint(page, 0, 0);
  const bottomRight = await screenPoint(page, 60000, 40000);
  expect(topLeft.x).toBeCloseTo(FIT_MARGIN, 6);
  expect(topLeft.y).toBeCloseTo(FIT_MARGIN, 6);
  expect(bottomRight.x).toBeLessThanOrEqual(size.width - FIT_MARGIN + 1e-6);
  expect(bottomRight.y).toBeLessThanOrEqual(size.height - FIT_MARGIN + 1e-6);
  // 右下隅の図形が実際に描画されていること(縮尺下限で画面外へ切れていた不具合の回帰)。
  const painted = await page.locator("#cadCanvas").evaluate((element, point) => {
    const data = element.getContext("2d").getImageData(Math.round(point.x) - 3, Math.round(point.y) - 3, 7, 7).data;
    const background = element.getContext("2d").getImageData(2, 2, 1, 1).data;
    let differs = 0;
    for (let index = 0; index < data.length; index += 4) if (Math.abs(data[index] - background[0]) + Math.abs(data[index + 1] - background[1]) + Math.abs(data[index + 2] - background[2]) > 60) differs++;
    return differs;
  }, bottomRight);
  expect(painted).toBeGreaterThan(0);
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
