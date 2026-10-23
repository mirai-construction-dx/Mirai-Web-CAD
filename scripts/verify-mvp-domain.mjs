import { chromium } from "playwright";

const baseUrl = process.env.E2E_BASE_URL ?? "https://mirai-web-cad-mvp.mirai-dx-platform.com";
const clientId = process.env.E2E_CF_ACCESS_CLIENT_ID;
const clientSecret = process.env.E2E_CF_ACCESS_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error("E2E_CF_ACCESS_CLIENT_ID と E2E_CF_ACCESS_CLIENT_SECRET が必要です。");
  process.exit(78);
}

const headers = {
  "CF-Access-Client-Id": clientId,
  "CF-Access-Client-Secret": clientSecret
};
const results = [];
const browser = await chromium.launch({ headless: true });

try {
  for (const target of [
    { name: "desktop", viewport: { width: 1440, height: 960 }, edit: true },
    { name: "mobile", viewport: { width: 412, height: 915 }, edit: false }
  ]) {
    const context = await browser.newContext({ viewport: target.viewport, extraHTTPHeaders: headers });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 45_000 });

    await assertVisible(page.getByRole("heading", { name: "Mirai Web CAD" }), `${target.name}: heading`);
    const canvas = page.getByLabel("作図キャンバス");
    await assertVisible(canvas, `${target.name}: canvas`);
    const paintedPixels = await canvas.evaluate((element) => {
      const context2d = element.getContext("2d");
      const pixels = context2d.getImageData(0, 0, element.width, element.height).data;
      let count = 0;
      for (let index = 0; index < pixels.length; index += 16) {
        if (pixels[index] < 245 || pixels[index + 1] < 245 || pixels[index + 2] < 245) count += 1;
      }
      return count;
    });
    if (paintedPixels <= 1_000) throw new Error(`${target.name}: Canvasが空白です。`);

    const health = await page.evaluate(async () => {
      const response = await fetch("/api/health");
      return { status: response.status, body: await response.json().catch(() => null) };
    });
    // AUTH_MODE=accessでは実利用者のAccess JWTがある場合だけAPIを利用できる。Access Service Tokenは
    // エッジ(302の壁)を通過してもユーザーJWTを持たないため、アプリは fail-closed で401を返す(想定どおり)。
    // 200のときだけDBプローブを検証し、401は「正しく拒否している」証跡として記録する。
    // 接続DB名の一致は check-mvp-health.sh(psql) と unit の EXPECTED_DATABASE で検証する。
    if (health.status !== 200 && health.status !== 401) {
      throw new Error(`${target.name}: /api/health が想定外のステータスです(status=${health.status})`);
    }
    const apiAccessible = health.status === 200;
    const dbProbe = health.body?.db;
    if (apiAccessible && (dbProbe?.provider !== "postgres" || dbProbe?.mode !== "connected" || dbProbe?.migrated !== true)) {
      throw new Error(`${target.name}: MVP DB healthが不正です。`);
    }

    let drawingName = null;
    if (target.edit && apiAccessible) {
      drawingName = `Cloudflare MVP E2E ${Date.now()}`;
      await page.getByRole("button", { name: "新規図面" }).click();
      const dialog = page.getByRole("dialog", { name: "新規図面" });
      await assertVisible(dialog, "desktop: new drawing dialog");
      await dialog.getByLabel("図面名").fill(drawingName);
      await dialog.getByLabel("テンプレート").selectOption("blank");
      await dialog.getByRole("button", { name: "作成", exact: true }).click();
      await page.getByText(drawingName, { exact: true }).waitFor({ state: "visible", timeout: 15_000 });

      const command = page.getByLabel("コマンド入力");
      await command.fill("LINE 0,0 1200,800");
      await command.press("Enter");
      await page.getByText("図形数").locator("xpath=following-sibling::dd[1]").waitFor({ state: "visible" });
      await waitForText(page.locator(".save-status"), "サーバー同期済み", "desktop: server sync");
    }

    results.push({ target: target.name, paintedPixels, apiStatus: health.status, apiAccessible, dbProvider: dbProbe?.provider ?? null, dbMode: dbProbe?.mode ?? null, drawingName });
    await context.close();
  }
} finally {
  await browser.close();
}

console.log(JSON.stringify({ ok: true, baseUrl, results }, null, 2));

async function assertVisible(locator, label) {
  try {
    await locator.waitFor({ state: "visible", timeout: 15_000 });
  } catch {
    throw new Error(`${label} が表示されません。`);
  }
}

async function waitForText(locator, expected, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if ((await locator.textContent())?.includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} が「${expected}」になりません。`);
}
