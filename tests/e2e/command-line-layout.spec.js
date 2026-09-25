import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", (route) => route.abort());
  await page.goto("/");
  await expect(page.locator(".save-status")).toHaveText("オフライン");
});

const boxes = (page) => page.evaluate(() => {
  const rect = (selector) => {
    const value = document.querySelector(selector).getBoundingClientRect();
    return { top: value.top, bottom: value.bottom, height: value.height };
  };
  return { canvas: rect("#cadCanvas"), command: rect(".command-line"), viewport: window.innerHeight, position: getComputedStyle(document.querySelector(".command-line")).position };
});

test("command line never covers the canvas, and stays docked at the bottom on desktop", async ({ page }, testInfo) => {
  if (testInfo.project.name === "desktop-chromium") {
    const layout = await boxes(page);
    expect(layout.position).toBe("fixed");
    expect(layout.command.bottom).toBeCloseTo(layout.viewport, 0);
    expect(layout.canvas.bottom).toBeLessThanOrEqual(layout.command.top + 0.5);
    return;
  }
  // mobile: 画面全体が縦スクロールするため、Canvas下端を画面下端へ合わせた位置でも覆われないこと。
  await page.locator("#cadCanvas").evaluate((element) => element.scrollIntoView({ block: "end" }));
  const layout = await boxes(page);
  expect(layout.position).toBe("static");
  expect(layout.command.top).toBeGreaterThanOrEqual(layout.canvas.bottom - 0.5);
  const hit = await page.evaluate(({ y }) => {
    const canvas = document.querySelector("#cadCanvas").getBoundingClientRect();
    return document.elementFromPoint(canvas.left + canvas.width / 2, y)?.id;
  }, { y: layout.canvas.bottom - 4 });
  expect(hit).toBe("cadCanvas");
  // ステータスバーの作図補助トグルは文字を折り返さず1行で表示する(横幅不足はバー内スクロール)。
  const toggleHeights = await page.locator(".status-toggle").evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height));
  expect(Math.max(...toggleHeights)).toBeLessThan(24);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  // コマンド入力はCanvasの直後にあり、入力・実行できる。
  await page.locator("#commandInput").fill("ZOOM E");
  await page.locator("#commandInput").press("Enter");
  await expect(page.getByLabel("コマンドログ")).toContainText("ZOOM E");
  await testInfo.attach("mobile-command-line", { body: await page.screenshot(), contentType: "image/png" });
});
