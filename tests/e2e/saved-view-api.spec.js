import { expect, test } from "@playwright/test";
import { circle, createDrawing, line } from "../../src/cad-core.js";

// 同じ図面をAPIから再同期しても、利用者が今見ている表示を古い記憶位置へ戻さない。
const drawing = createDrawing({ currentRole: "drafter", entities: [
  line("layer-structure", [0, 0], [20000, 0], { id: "base" }),
  circle("layer-structure", [10000, 6000], 3000, { id: "ring" })
] });

test("same-drawing API refresh keeps the view the user just changed", async ({ page }) => {
  await page.addInitScript(({ doc }) => {
    if (!localStorage.getItem("mirai-web-cad-mvp")) localStorage.setItem("mirai-web-cad-mvp", JSON.stringify(doc));
    if (!localStorage.getItem("mirai-web-cad-views")) localStorage.setItem("mirai-web-cad-views", JSON.stringify({ dwg_demo_001: { cx: 10000, cy: 4500, scale: 0.02, savedAt: 1 } }));
  }, { doc: drawing });
  const json = (body) => ({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, ...body }) });
  await page.route("**/api/health", (route) => route.fulfill(json({ service: "mock", auth: { mode: "demo", role: "drafter", anonymous: false }, db: { mode: "memory" } })));
  await page.route("**/api/drawings/demo", (route) => route.fulfill(json({ drawing })));
  await page.route("**/api/ai/status", (route) => route.fulfill(json({ enabled: false })));
  await page.goto("/");
  await expect(page.locator(".save-status")).toHaveText("サーバー同期済み");
  await expect(page.locator(".zoom-readout")).toHaveText("20%");
  const box = await page.locator("#cadCanvas").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -100);
  await page.mouse.wheel(0, -100);
  const zoomed = await page.locator(".zoom-readout").textContent();
  expect(zoomed).not.toBe("20%");
  // 保存のデバウンス(300ms)が終わる前に同じ図面を再同期する。
  await page.getByLabel("パネルを切替").getByRole("button", { name: "検査/承認", exact: true }).click();
  await page.getByRole("button", { name: "API Health" }).click();
  await expect(page.locator(".api-status")).toContainText("同期済み");
  await expect(page.locator(".zoom-readout")).toHaveText(zoomed);
});
