import { expect, test } from "@playwright/test";
import { circle, createDrawing } from "../../src/cad-core.js";

const drawing = createDrawing({ currentRole: "drafter", entities: [circle("layer-structure", [3000, 2000], 800, { id: "ring" })] });

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
const lastEntity = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("mirai-web-cad-mvp")).entities.at(-1));
// 図面座標→Canvas座標の対応を、実際のカーソル座標表示から測る(起動時の自動fitの有無や
// Canvas寸法に依存しない)。選択ツール・OSnap無効の状態で呼ぶこと(座標が吸着しない)。
async function calibrate(page) {
  const canvas = page.locator("#cadCanvas");
  const read = async (x, y) => {
    await canvas.hover({ position: { x, y } });
    return (await page.locator("#coordReadout").textContent()).split(",").map((value) => Number(value.trim()));
  };
  const [x0, y0] = await read(20, 20);
  const [x1] = await read(120, 20);
  const scale = 100 / (x1 - x0);
  return (x, y) => ({ x: 20 + (x - x0) * scale, y: 20 + (y - y0) * scale });
}

test("F3/F7/F8/F9 toggle drafting aids, but not while a dialog is open", async ({ page }) => {
  const toggle = (name) => page.locator(".status-toggle", { hasText: name });
  await page.locator("#cadCanvas").focus();
  await expect(toggle("直交")).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("F8");
  await expect(toggle("直交")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("F3");
  await expect(toggle("OSnap")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("F9");
  await expect(toggle("スナップ")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("F7");
  await expect(toggle("グリッド")).toHaveAttribute("aria-pressed", "false");
  // コマンド入力中でも切り替えられる。
  await page.locator("#commandInput").focus();
  await page.keyboard.press("F8");
  await expect(toggle("直交")).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "システム設定" }).click();
  await page.keyboard.press("F8");
  await page.keyboard.press("Escape");
  await expect(toggle("直交")).toHaveAttribute("aria-pressed", "false");
});

test("a leading @ continues from the last entered point", async ({ page }) => {
  await command(page, "LINE 0,0 100,0");
  await command(page, "LINE @0,100 @100,0");
  expect((await lastEntity(page)).points).toEqual([{ x: 100, y: 100 }, { x: 200, y: 100 }]);
  // 直前のLINEの最終点(200,100)を基準に矩形を置く。
  await command(page, "RECT @0,0 @50,-40");
  const rectangle = await lastEntity(page);
  expect(rectangle.type).toBe("rect");
  expect([rectangle.origin, rectangle.width, rectangle.height]).toEqual([{ x: 200, y: 60 }, 50, 40]);
});

test("typing a distance while drawing places the point toward the cursor", async ({ page }) => {
  const toCanvas = await calibrate(page);
  await command(page, "LINE");
  const canvas = page.locator("#cadCanvas");
  const start = toCanvas(1000, 1000);
  await canvas.click({ position: start });
  await canvas.hover({ position: { x: start.x + 60, y: start.y } });
  await command(page, "750");
  const created = await lastEntity(page);
  expect(created.type).toBe("line");
  const [a, b] = created.points;
  expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(750, 6);
  expect(b.x - a.x).toBeCloseTo(750, 6);
  await expect(page.getByLabel("コマンドログ")).toContainText("距離の直接入力: 750");
  // レイアウト空間では受け付けず、図形を追加しない。
  const count = (await page.evaluate(() => JSON.parse(localStorage.getItem("mirai-web-cad-mvp")).entities.length));
  await command(page, "LINE");
  await canvas.click({ position: start });
  await page.getByRole("button", { name: "レイアウト1", exact: true }).click();
  await command(page, "300");
  await expect(page.getByLabel("コマンドログ")).toContainText("モデル空間でのみ使用できます");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("mirai-web-cad-mvp")).entities.length)).toBe(count);
});

test("tangent OSnap snaps the second point to the tangent point on a circle", async ({ page }) => {
  const toCanvas = await calibrate(page);
  await page.getByRole("button", { name: "システム設定" }).click();
  await page.getByLabel("図形スナップ（OSnap）").check();
  await page.getByRole("checkbox", { name: "接線" }).check();
  await page.getByRole("button", { name: "適用", exact: true }).click();
  await command(page, "LINE");
  const canvas = page.locator("#cadCanvas");
  await canvas.click({ position: toCanvas(1000, 2000) });
  // 外部点(1000,2000)から中心(3000,2000)・半径800の円への接点の近くをクリックする。
  const angle = Math.PI - Math.acos(800 / 2000);
  const tangent = { x: 3000 + 800 * Math.cos(angle), y: 2000 + 800 * Math.sin(angle) };
  const near = toCanvas(tangent.x, tangent.y);
  await canvas.click({ position: { x: near.x + 3, y: near.y + 2 } });
  const [from, to] = (await lastEntity(page)).points;
  // 1点目はクリック位置の丸めでわずかにずれるため、接線の条件そのもので判定する:
  // 終点は円周上にあり、半径と線分が直交する(クリック位置そのままなら成り立たない)。
  expect(Math.hypot(to.x - 3000, to.y - 2000)).toBeCloseTo(800, 6);
  const radius = { x: to.x - 3000, y: to.y - 2000 };
  const segment = { x: from.x - to.x, y: from.y - to.y };
  expect(Math.abs(radius.x * segment.x + radius.y * segment.y) / (800 * Math.hypot(segment.x, segment.y))).toBeLessThan(1e-9);
  expect(Math.hypot(to.x - tangent.x, to.y - tangent.y)).toBeLessThan(5);
});

test("function keys keep a partial command, and ignore Shift and other input fields", async ({ page }) => {
  const toggle = (name) => page.locator(".status-toggle", { hasText: name });
  const input = page.locator("#commandInput");
  await input.fill("LINE 0,0 1");
  await input.press("ArrowLeft");
  await page.keyboard.press("F8");
  await expect(toggle("直交")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#commandInput")).toHaveValue("LINE 0,0 1");
  await expect(page.locator("#commandInput")).toBeFocused();
  // Shift付きは対象外。
  await page.keyboard.press("Shift+F8");
  await expect(toggle("直交")).toHaveAttribute("aria-pressed", "true");
  // 操作値の入力欄では切り替えず、入力値も失わない。
  const operationValue = page.locator("#operationForm [name=value]");
  await operationValue.fill("500,0");
  await operationValue.focus();
  await page.keyboard.press("F8");
  await expect(toggle("直交")).toHaveAttribute("aria-pressed", "true");
  await expect(operationValue).toHaveValue("500,0");
});

test("LASTPOINT is cleared when the drawing is reset", async ({ page }) => {
  await command(page, "LINE 0,0 100,0");
  await page.getByRole("button", { name: "デモ初期化" }).click();
  await command(page, "LINE @10,0 50,0");
  await expect(page.getByLabel("コマンドログ")).toContainText("直前の点(LASTPOINT)がありません");
});
