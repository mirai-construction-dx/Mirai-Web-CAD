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
// Canvas中央が指す図面座標(カーソル座標表示から読む)。
const centerWorld = async (page) => {
  const canvas = page.locator("#cadCanvas");
  const box = await canvas.boundingBox();
  await canvas.hover({ position: { x: box.width / 2, y: box.height / 2 } });
  return (await page.locator("#coordReadout").textContent()).split(",").map((value) => Number(value.trim()));
};
const readout = (page) => page.locator(".zoom-readout").textContent();

test("ZOOM W, nX and P change and restore the view", async ({ page }) => {
  await command(page, "ZOOM E");
  const extents = await readout(page);
  await command(page, "ZOOM W 9000,5000 11000,7000");
  const [x, y] = await centerWorld(page);
  const windowScale = Number.parseFloat(await readout(page));
  // 窓の中心が画面中央に来る(許容: 画面上5px相当)。
  const fivePixels = 5 / (windowScale / 1000);
  expect(Math.abs(x - 10000)).toBeLessThan(fivePixels);
  expect(Math.abs(y - 6000)).toBeLessThan(fivePixels);
  expect(windowScale).toBeGreaterThan(Number.parseFloat(extents));
  await command(page, "ZOOM 0.5X");
  // 縮尺表示は整数%へ丸められるため、丸め分(1%)を許容する。
  expect(Math.abs(Number.parseFloat(await readout(page)) - windowScale / 2)).toBeLessThanOrEqual(1);
  await command(page, "ZOOM P");
  expect(await readout(page)).toBe(`${windowScale}%`);
  await command(page, "ZOOM P");
  expect(await readout(page)).toBe(extents);
  await command(page, "ZOOM P");
  await command(page, "ZOOM P");
  await expect(page.getByLabel("コマンドログ")).toContainText("戻れる前の表示がありません");
});

test("ZOOM W without points picks the window with two canvas clicks", async ({ page }) => {
  await command(page, "ZOOM E");
  const before = Number.parseFloat(await readout(page));
  await command(page, "ZOOM W");
  const canvas = page.locator("#cadCanvas");
  const box = await canvas.boundingBox();
  await canvas.click({ position: { x: box.width / 2 - 20, y: box.height / 2 - 15 } });
  await expect(page.getByLabel("コマンドログ")).toContainText("もう一方の角");
  await canvas.click({ position: { x: box.width / 2 + 20, y: box.height / 2 + 15 } });
  await expect.poll(async () => Number.parseFloat(await readout(page))).toBeGreaterThan(before * 3);
  // 1回のZOOM Pで窓ズーム前へ戻り、ツールは選択へ戻っている。
  await command(page, "ZOOM P");
  expect(Number.parseFloat(await readout(page))).toBe(before);
  await expect(page.getByText(/^SELECT/)).toBeVisible();
});

test("ZOOM P ignores view actions that did not change the view and ends wheel groups", async ({ page }) => {
  await command(page, "ZOOM E");
  await command(page, "ZOOM W 9000,5000 11000,7000");
  const windowView = await readout(page);
  // 変化のない全体表示の繰り返し・ZOOM 1Xは履歴を消費しない。
  await command(page, "ZOOM E");
  const extents = await readout(page);
  await command(page, "ZOOM E");
  await command(page, "ZOOM 1X");
  await command(page, "ZOOM P");
  expect(await readout(page)).toBe(windowView);
  // ホイール→ZOOM P→(800ms以内に)再びホイールしても、ZOOM Pで直前の表示へ戻れる。
  await command(page, "ZOOM E");
  const canvas = page.locator("#cadCanvas");
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -100);
  await command(page, "ZOOM P");
  expect(await readout(page)).toBe(extents);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -100);
  await expect.poll(() => readout(page)).not.toBe(extents);
  await command(page, "ZOOM P");
  expect(await readout(page)).toBe(extents);
});
