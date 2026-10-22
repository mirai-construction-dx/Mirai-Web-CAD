import { chromium } from "playwright";

// StagingのE2E。2つのモードがある。
//   (既定) 公開URL + Cloudflare Access Service Token。トークンが無ければ exit 78。
//   --local  http://127.0.0.1:18814 を直接検証する。トークン不要。書込みは行わない。
// 追加の環境変数:
//   E2E_EXPECT_COMMIT  指定すると /api/health の deploy.commit / deploy.distCommit と照合する。
//   E2E_BASE_URL       検証対象URL(既定: 公開Staging URL、--local時は 127.0.0.1:18814)。
//
// Access Service Tokenはエッジ(302の壁)を通過してもユーザーJWTを持たないため、アプリは
// fail-closedで401を返す(想定どおり)。200のときだけDBプローブを検証し、401は
// 「正しく拒否している」証跡として記録する。編集操作は、ユーザーJWTが無いため行わない。
const args = new Set(process.argv.slice(2));
const local = args.has("--local") || process.env.E2E_STAGING_LOCAL === "1";
const readOnly = local || args.has("--read-only") || process.env.E2E_STAGING_READ_ONLY === "1";
const baseUrl = process.env.E2E_BASE_URL ?? (local ? "http://127.0.0.1:18814" : "https://mirai-web-cad-stg.mirai-dx-platform.com");
const expectCommit = process.env.E2E_EXPECT_COMMIT ?? null;
const clientId = process.env.E2E_CF_ACCESS_CLIENT_ID;
const clientSecret = process.env.E2E_CF_ACCESS_CLIENT_SECRET;

if (!local && (!clientId || !clientSecret)) {
  console.error("E2E_CF_ACCESS_CLIENT_ID と E2E_CF_ACCESS_CLIENT_SECRET が必要です。ローカル検証は --local を付けてください。");
  process.exit(78);
}

const headers = local
  ? {}
  : {
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
    // --local はアプリへ直接到達するため200が正常。公開URL + Service Tokenは401が正常。
    const expectedStatuses = local ? [200] : [200, 401];
    if (!expectedStatuses.includes(health.status)) {
      throw new Error(`${target.name}: /api/health が想定外のステータスです(status=${health.status})`);
    }
    const apiAccessible = health.status === 200;
    const dbProbe = health.body?.db;
    if (apiAccessible && (dbProbe?.provider !== "postgres" || dbProbe?.mode !== "connected" || dbProbe?.migrated !== true)) {
      throw new Error(`${target.name}: Staging DB healthが不正です。`);
    }
    if (expectCommit && apiAccessible) {
      const deployed = health.body?.deploy ?? {};
      const actual = deployed.distCommit ?? deployed.commit;
      if (actual !== expectCommit) {
        throw new Error(`${target.name}: 配信commitが一致しません(expected=${expectCommit}, actual=${actual ?? "null"})`);
      }
    }

    let drawingName = null;
    if (target.edit && apiAccessible && !readOnly) {
      drawingName = `Cloudflare Staging E2E ${Date.now()}`;
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

    results.push({
      target: target.name,
      mode: local ? "local" : "public-access-token",
      paintedPixels,
      apiStatus: health.status,
      apiAccessible,
      dbProvider: dbProbe?.provider ?? null,
      dbMode: dbProbe?.mode ?? null,
      deployedCommit: health.body?.deploy?.distCommit ?? health.body?.deploy?.commit ?? null,
      drawingName
    });
    await context.close();
  }
} finally {
  await browser.close();
}

console.log(JSON.stringify({ ok: true, baseUrl, mode: local ? "local" : "public-access-token", results }, null, 2));

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
