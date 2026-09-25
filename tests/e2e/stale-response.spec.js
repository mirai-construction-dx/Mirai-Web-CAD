import { expect, test } from "@playwright/test";
import { createDrawing, line } from "../../src/cad-core.js";

// 応答待ちの間に図面を切り替えたら、前の図面向けの応答を今の図面へ適用しない。
test("a transaction response that arrives after switching drawings is discarded", async ({ page }) => {
  const server = createDrawing({ currentRole: "drafter", entities: [line("layer-structure", [0, 0], [1000, 0], { id: "server-line" })] });
  const stale = { ...server, revision: 2, entities: [...server.entities, line("layer-structure", [0, 0], [500, 500], { id: "stale-marker" })] };
  const json = (body) => ({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, ...body }) });
  await page.route("**/api/health", (route) => route.fulfill(json({ service: "mock", auth: { mode: "demo", role: "drafter", anonymous: false }, db: { mode: "memory" } })));
  await page.route("**/api/drawings/demo", (route) => route.fulfill(json({ drawing: server })));
  await page.route("**/api/ai/status", (route) => route.fulfill(json({ enabled: false })));
  await page.route("**/api/drawings/*/transactions", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.fulfill(json({ drawing: stale }));
  });
  await page.goto("/");
  await expect(page.locator(".save-status")).toHaveText("サーバー同期済み");
  await page.locator("#commandInput").fill("LINE 0,0 500,500");
  await page.locator("#commandInput").press("Enter");
  await page.getByRole("button", { name: "デモ初期化" }).click();
  // 遅延した応答(1.5秒)が確実に届いた後の図面を確かめる。
  await page.waitForResponse("**/api/drawings/*/transactions");
  await page.waitForTimeout(300);
  const ids = await page.evaluate(() => JSON.parse(localStorage.getItem("mirai-web-cad-mvp")).entities.map((entity) => entity.id));
  expect(ids).not.toContain("stale-marker");
  expect(ids).not.toContain("server-line");
  await expect(page.getByLabel("コマンドログ")).toContainText("応答待ちの間に図面が切り替わったため、結果を破棄しました");
});

test("an UNDO response that arrives after switching drawings does not restore the old history", async ({ page }) => {
  const server = createDrawing({ currentRole: "drafter", entities: [line("layer-structure", [0, 0], [1000, 0], { id: "server-line" })] });
  const json = (body) => ({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, ...body }) });
  await page.route("**/api/health", (route) => route.fulfill(json({ service: "mock", auth: { mode: "demo", role: "drafter", anonymous: false }, db: { mode: "memory" } })));
  await page.route("**/api/drawings/demo", (route) => route.fulfill(json({ drawing: server })));
  await page.route("**/api/ai/status", (route) => route.fulfill(json({ enabled: false })));
  let transactions = 0;
  await page.route("**/api/drawings/*/transactions", async (route) => {
    transactions += 1;
    // 1回目(LINE)は即時成功、2回目(UNDO)は遅延させて失敗させる。
    if (transactions === 1) {
      const added = { ...server, revision: 2, entities: [...server.entities, line("layer-structure", [0, 0], [500, 500], { id: "added" })] };
      await route.fulfill(json({ drawing: added }));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ ok: false, error: "conflict" }) });
  });
  await page.goto("/");
  await expect(page.locator(".save-status")).toHaveText("サーバー同期済み");
  const undoButton = page.getByRole("group", { name: "クイックアクセス" }).getByRole("button", { name: "元に戻す" });
  await page.locator("#commandInput").fill("LINE 0,0 500,500");
  await page.locator("#commandInput").press("Enter");
  await expect(undoButton).toBeEnabled();
  await page.locator("#commandInput").fill("UNDO");
  await page.locator("#commandInput").press("Enter");
  await page.getByRole("button", { name: "デモ初期化" }).click();
  await page.waitForResponse("**/api/drawings/*/transactions");
  await page.waitForTimeout(300);
  await expect(page.getByLabel("コマンドログ")).toContainText("応答待ちの間に図面が切り替わったため、結果を破棄しました");
  // 新しい図面には元に戻す履歴がない(前の図面のUNDO失敗で履歴を戻さない)。戻っていると、
  // 次のUNDOが前の図面の形状を新しい図面へ適用してしまう。
  await page.locator("#commandInput").fill("UNDO");
  await page.locator("#commandInput").press("Enter");
  await expect(page.getByLabel("コマンドログ")).toContainText("元に戻せる操作がありません。");
  await expect(undoButton).toBeDisabled();
});
