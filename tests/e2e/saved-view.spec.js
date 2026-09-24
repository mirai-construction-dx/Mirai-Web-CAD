import { expect, test } from "@playwright/test";
import { circle, createDrawing, line } from "../../src/cad-core.js";

const drawing = createDrawing({ currentRole: "drafter", entities: [
  line("layer-structure", [0, 0], [20000, 0], { id: "base" }),
  circle("layer-structure", [10000, 6000], 3000, { id: "ring" })
] });

test.beforeEach(async ({ page }) => {
  await page.addInitScript((doc) => { if (!localStorage.getItem("mirai-web-cad-mvp")) localStorage.setItem("mirai-web-cad-mvp", JSON.stringify(doc)); }, drawing);
  await page.route("**/api/**", (route) => route.abort());
  await page.goto("/");
  await expect(page.locator(".save-status")).toHaveText("オフライン");
});

const command = async (page, value) => {
  await page.locator("#commandInput").fill(value);
  await page.locator("#commandInput").press("Enter");
};
const readout = (page) => page.locator(".zoom-readout").textContent();
const cursorWorld = async (page, x, y) => {
  const box = await page.locator("#cadCanvas").boundingBox();
  await page.mouse.move(box.x + x, box.y + y);
  return page.locator("#coordReadout").textContent();
};

test("zoom and pan of a drawing are restored after reload", async ({ page }) => {
  await command(page, "ZOOM E");
  const box = await page.locator("#cadCanvas").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -100);
  await page.mouse.wheel(0, -100);
  await command(page, "PAN 500,300");
  const zoom = await readout(page);
  const before = await cursorWorld(page, 60, 40);
  await expect.poll(() => page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("mirai-web-cad-views") ?? "{}")))).toEqual(["dwg_demo_001"]);
  await page.reload();
  await expect(page.locator(".save-status")).toHaveText("オフライン");
  expect(await readout(page)).toBe(zoom);
  expect(await cursorWorld(page, 60, 40)).toBe(before);
});

test("a saved view that no longer shows the drawing falls back to ZOOM EXTENTS", async ({ page }) => {
  await page.evaluate(() => localStorage.setItem("mirai-web-cad-views", JSON.stringify({ dwg_demo_001: { cx: 9e7, cy: 9e7, scale: 0.5, savedAt: 1 } })));
  await page.reload();
  await expect(page.locator(".save-status")).toHaveText("オフライン");
  const box = await page.locator("#cadCanvas").boundingBox();
  // fit後はCanvas中央付近が図面(円の中心付近)を指す。
  const center = await cursorWorld(page, box.width / 2, box.height / 2);
  const [x, y] = center.split(",").map((value) => Number(value.trim()));
  expect(Math.abs(x - 10000)).toBeLessThan(1500);
  expect(Math.abs(y - 4500)).toBeLessThan(1500);
});
