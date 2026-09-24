import { expect, test } from "@playwright/test";
import { circle, createDrawing, entityBounds, line } from "../../src/cad-core.js";
import { FIT_MARGIN, fitCameraToBounds } from "../../src/cad-view.js";

// 起動時の描画後にAPIが大図面へ差し替えた場合も、表示に収まらなければZOOM EXTENTSする。
const small = createDrawing({ currentRole: "drafter", entities: [line("layer-structure", [400, 400], [1600, 400], { id: "small" })] });
const large = createDrawing({ currentRole: "drafter", entities: [
  line("layer-structure", [0, 0], [60000, 40000], { id: "diagonal" }),
  circle("layer-structure", [30000, 20000], 5000, { id: "center-circle" })
] });

test("drawing replaced by the API after startup is fitted when it does not fit the view", async ({ page }) => {
  await page.addInitScript((doc) => { if (!localStorage.getItem("mirai-web-cad-mvp")) localStorage.setItem("mirai-web-cad-mvp", JSON.stringify(doc)); }, small);
  const json = (body) => ({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, ...body }) });
  await page.route("**/api/health", (route) => route.fulfill(json({ service: "mock", auth: { mode: "demo", role: "drafter", anonymous: false }, db: { mode: "memory" } })));
  await page.route("**/api/drawings/demo", (route) => route.fulfill(json({ drawing: large })));
  await page.route("**/api/ai/status", (route) => route.fulfill(json({ enabled: false })));
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("mirai-web-cad-mvp")).entities.length)).toBe(2);
  const size = await page.locator("#cadCanvas").evaluate((element) => ({ width: element.clientWidth, height: element.clientHeight }));
  const camera = fitCameraToBounds(large.entities.map(entityBounds), size);
  const bottomRight = { x: camera.x + 60000 * camera.scale, y: camera.y + 40000 * camera.scale };
  expect(bottomRight.x).toBeLessThanOrEqual(size.width - FIT_MARGIN + 1e-6);
  // 表示中のカメラがfit結果と一致することを、円の中心付近のクリック選択で確かめる。
  await page.locator("#cadCanvas").click({ position: { x: camera.x + 35000 * camera.scale, y: camera.y + 20000 * camera.scale } });
  await expect(page.getByText("選択: 1件 / center-circle", { exact: true })).toBeVisible();
});
