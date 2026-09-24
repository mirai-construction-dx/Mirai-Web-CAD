import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "デモ初期化" }).click();
});

async function openDock(page, label) {
  await page.getByLabel("パネルを切替").getByRole("button", { name: label, exact: true }).click();
}

function quantityLocator(page) {
  return page.getByText("図形数").locator("xpath=following-sibling::dd[1]");
}

function quickAccess(page) {
  return page.getByRole("group", { name: "クイックアクセス" });
}

test("主要CAD画面は描画済みでAPI HealthとAI承認を操作できる", async ({ page }, testInfo) => {
  await expect(page.getByRole("heading", { name: "Mirai Web CAD" })).toBeVisible();
  const canvas = page.getByLabel("作図キャンバス");
  await expect(canvas).toBeVisible();

  const paintedPixels = await canvas.evaluate((element) => {
    const context = element.getContext("2d");
    const pixels = context.getImageData(0, 0, element.width, element.height).data;
    let nonWhite = 0;
    for (let index = 0; index < pixels.length; index += 16) {
      if (pixels[index] < 245 || pixels[index + 1] < 245 || pixels[index + 2] < 245) nonWhite += 1;
    }
    return nonWhite;
  });
  expect(paintedPixels).toBeGreaterThan(1_000);

  await openDock(page, "検査/承認");
  await page.getByRole("button", { name: "API Health" }).click();
  await expect(page.locator(".api-status")).toContainText("mirai-web-cad-api");
  await expect(page.locator(".api-status")).toContainText("同期済み");
  await expect(page.locator(".save-status")).toHaveText("サーバー同期済み");
  await expect(page.locator(".save-status")).toHaveClass(/synced/);

  if (testInfo.project.name === "mobile-chromium") {
    await testInfo.attach("cad-mobile", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png"
    });
    return;
  }

  await openDock(page, "プロパティ");
  const quantity = quantityLocator(page);
  const beforeCount = Number(await quantity.textContent());
  await page.getByRole("button", { name: "線", exact: true }).click();
  await canvas.click({ position: { x: 100, y: 100 } });

  const roleSelect = page.getByLabel("権限を切替");
  if (await roleSelect.isDisabled()) {
    await expect(roleSelect).toHaveValue("viewer");
    await expect(quantity).toHaveText(String(beforeCount));
    await expect(page.getByLabel("コマンドログ")).toContainText("閲覧者は作図できません");
    return;
  }

  await canvas.click({ position: { x: 200, y: 150 } });
  await expect(quantity).toHaveText(String(beforeCount + 1));

  await openDock(page, "AI提案");
  await page.getByPlaceholder("例: クレーンの重機範囲を追加").fill("クレーンの重機範囲を追加");
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.locator("#aiPreview")).toContainText("追加 2");
  await page.getByRole("button", { name: "承認して適用" }).click();
  await openDock(page, "プロパティ");
  await expect(quantity).toHaveText(String(beforeCount + 3));
  await expect(page.getByLabel("コマンドログ")).toContainText("サーバー同期");

  await openDock(page, "AI履歴");
  await expect(page.locator(".ai-history-list li").first()).toContainText("クレーン作業範囲を追加");
  await expect(page.locator(".ai-history-list li").first()).toContainText("追加 2");

  await openDock(page, "プロパティ");
  await page.getByPlaceholder("コメントを入力").fill("この寸法を確認してください");
  await page.getByRole("button", { name: "コメントを追加" }).click();
  await expect(page.locator(".comment-list").first()).toContainText("この寸法を確認してください");

  await testInfo.attach("cad-desktop", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png"
  });
});

test("状態表示、権限拒否、Keyboard操作を確認できる", async ({ page }) => {
  await openDock(page, "検査/承認");
  for (const label of ["空", "Loading", "Error", "正常"]) {
    const button = page.getByRole("button", { name: label, exact: true });
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
  }

  await page.getByLabel("権限を切替").selectOption("viewer");
  await expect(page.locator(".role-badge")).toHaveText("閲覧者");
  await openDock(page, "レイヤー");
  const firstLayer = page.locator("[data-layer-visible]").first();
  await expect(firstLayer).toBeChecked();
  await firstLayer.click();
  await expect(page.locator("[data-layer-visible]").first()).toBeChecked();
  await expect(page.getByLabel("コマンドログ")).toContainText("図面を変更できません");

  await expect(page.getByRole("button", { name: "線" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "新規図面" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "上書き保存" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "選択", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "計測", exact: true })).toBeEnabled();

  await page.getByLabel("作図キャンバス").press("Escape");
  await expect(page.getByLabel("コマンドログ")).toContainText("取消");
});

test("エラー通知はスクリーンリーダー向けのlive regionにも流れる", async ({ page }) => {
  // コマンドログは render のたびに #app の中で作り直されるため、その中の
  // aria-live は読み上げられない。#app の外にある #sr-announcer に同じ文言が
  // 入ることを確認する(エラーが支援技術へ届く唯一の経路)。
  const announcer = page.locator("#sr-announcer");
  await expect(announcer).toHaveAttribute("aria-live", "polite");

  await page.getByLabel("権限を切替").selectOption("viewer");
  await openDock(page, "レイヤー");
  await page.locator("[data-layer-visible]").first().click();
  await expect(page.getByLabel("コマンドログ")).toContainText("図面を変更できません");
  await expect(announcer).toContainText("図面を変更できません");
});

test("新規図面、コマンドライン、JSON Importを連続操作できる", async ({ page }) => {
  await page.getByRole("button", { name: "新規図面" }).click();
  await expect(page.getByRole("dialog", { name: "新規図面" })).toBeVisible();
  await page.getByLabel("図面名").fill("CLI施工図");
  await page.getByLabel("テンプレート").selectOption("blank");
  await page.getByRole("button", { name: "作成", exact: true }).click();
  await expect(page.getByText("CLI施工図", { exact: true })).toBeVisible();

  const quantity = quantityLocator(page);
  await expect(quantity).toHaveText("0");
  const command = page.getByLabel("コマンド入力");
  await command.fill("LINE 0,0 1200,800");
  await command.press("Enter");
  await expect(quantity).toHaveText("1");
  await expect(page.getByLabel("コマンドログ")).toContainText("CLI LINE");

  await command.fill("UNDO");
  await command.press("Enter");
  await expect(quantity).toHaveText("0");
  await expect(quickAccess(page).getByRole("button", { name: "やり直す" })).toBeEnabled();

  await command.fill("REDO");
  await command.press("Enter");
  await expect(quantity).toHaveText("1");
  await expect(quickAccess(page).getByRole("button", { name: "元に戻す" })).toBeEnabled();

  const imported = {
    layers: [{ id: "survey", name: "測量", color: "#224466" }],
    entities: [{ type: "circle", layerId: "survey", center: { x: 1600, y: 900 }, radius: 300 }]
  };
  await page.locator("#importFile").setInputFiles({
    name: "survey.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(imported))
  });
  await expect(quantity).toHaveText("2");
  await expect(page.getByLabel("コマンドログ")).toContainText("Import完了: 1/1図形");
  await expect(page.getByLabel("図面状態")).toContainText("survey");

  await openDock(page, "レイヤー");
  await expect(page.getByLabel("図面情報パネル").getByText("測量", { exact: true })).toBeVisible();

  await command.fill("UNDO");
  await command.press("Enter");
  await expect(page.getByLabel("図面情報パネル").getByText("測量", { exact: true })).toHaveCount(0);

  await command.fill("REDO");
  await command.press("Enter");
  await expect(page.getByLabel("図面情報パネル").getByText("測量", { exact: true })).toBeVisible();

  await openDock(page, "プロパティ");
  await command.fill("PLINE 0,0 @1000,0 @500<90 CLOSE");
  await command.press("Enter");
  await expect(quantity).toHaveText("3");
  await expect(page.getByLabel("コマンドログ")).toContainText("CLI PLINE");

  await command.fill("LINE @100,0 200,0");
  await command.press("Enter");
  await expect(page.getByLabel("コマンドログ")).toContainText("先頭の点に相対座標(@)は使用できません");
  await expect(quantity).toHaveText("3");
});

test("CriticalまたはSeriousのアクセシビリティ違反がない", async ({ page }) => {
  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations.filter((violation) => ["critical", "serious"].includes(violation.impact));
  expect(blocking).toEqual([]);
});

test("ダークモード(システム設定)でもCriticalまたはSeriousのアクセシビリティ違反がない", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.reload();
  await page.getByRole("button", { name: "デモ初期化" }).click();
  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations.filter((violation) => ["critical", "serious"].includes(violation.impact));
  expect(blocking).toEqual([]);
});

test("設定ダイアログでダークモードへその場で切り替えられ、再読込後も保持される", async ({ page }) => {
  await page.getByRole("button", { name: "システム設定" }).click();
  await page.locator("#themeSelect").selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.getByRole("button", { name: "システム設定" }).click();
  await page.locator("#themeSelect").selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("URLと保存図面の文字列をHTMLとして実行しない", async ({ page }) => {
  await page.evaluate(() => {
    const drawing = JSON.parse(localStorage.getItem("mirai-web-cad-mvp"));
    drawing.layers[0].id = 'unsafe\"><img src=x onerror="window.__miraiXss=1">';
    drawing.layers[0].name = '<img src=x onerror="window.__miraiXss=1">';
    drawing.layers[0].color = "red;position:fixed;inset:0";
    localStorage.setItem("mirai-web-cad-mvp", JSON.stringify(drawing));
  });
  await page.goto('/?state=%3Cimg%20src%3Dx%20onerror%3D%22window.__miraiXss%3D1%22%3E');
  await expect(page.getByText("表示状態: 正常")).toBeVisible();
  await expect(page.locator("#app img")).toHaveCount(0);
  expect(await page.evaluate(() => window.__miraiXss)).toBeUndefined();
  await openDock(page, "レイヤー");
  await expect(page.locator(".swatch").first()).toHaveValue("#5b6b7a");
});

test("上部設定から作図補助とコマンドライン表示を保存できる", async ({ page }) => {
  const commandLine = page.getByLabel("コマンドライン");
  expect((await commandLine.boundingBox()).height).toBeLessThanOrEqual(90);

  await page.getByRole("button", { name: "システム設定" }).click();
  const dialog = page.getByRole("dialog", { name: "システム設定" });
  await expect(dialog).toBeVisible();
  await expect(page.getByLabel("グリッド表示")).toBeChecked();
  await expect(page.getByLabel("直交モード")).not.toBeChecked();
  await expect(page.getByLabel("図形スナップ（OSnap）")).not.toBeChecked();
  await page.getByLabel("グリッドスナップ").check();
  await page.getByLabel("直交モード").check();
  await page.getByLabel("グリッド間隔").selectOption("250");
  await page.getByLabel("ログ表示行数").selectOption("1");
  await page.getByRole("button", { name: "適用", exact: true }).click();

  await expect(dialog).not.toBeVisible();
  await expect(page.getByText("SNAP: 250 mm", { exact: true })).toBeVisible();
  expect((await commandLine.boundingBox()).height).toBeLessThanOrEqual(72);

  await page.reload();
  await page.getByRole("button", { name: "システム設定" }).click();
  await expect(page.getByLabel("グリッドスナップ")).toBeChecked();
  await expect(page.getByLabel("直交モード")).toBeChecked();
  await expect(page.getByLabel("グリッド間隔")).toHaveValue("250");
  await expect(page.getByLabel("ログ表示行数")).toHaveValue("1");
});

test("AIモデル連携はサーバー管理の読み取り専用状態として表示され、ブラウザにキー入力欄がない", async ({ page }) => {
  await page.getByRole("button", { name: "システム設定" }).click();
  await expect(page.getByText("AIモデル連携はサーバーの環境変数のみで管理されます。")).toBeVisible();
  await expect(page.getByText("未設定（ルールベースAIのみ動作）")).toBeVisible();

  await expect(page.locator("#aiApiKeyInput")).toHaveCount(0);
  await expect(page.locator("#aiProviderSelect")).toHaveCount(0);
  await expect(page.locator("#saveAiKeyBtn")).toHaveCount(0);
  await expect(page.locator("#clearAiKeyBtn")).toHaveCount(0);
});

test("旧バージョンのブラウザ側AI設定キーが残っていても起動時に削除される", async ({ page }) => {
  await page.evaluate(() => localStorage.setItem("mirai-web-cad-ai-settings", JSON.stringify({ apiKey: "sk-leftover" })));
  await page.reload();
  const remaining = await page.evaluate(() => localStorage.getItem("mirai-web-cad-ai-settings"));
  expect(remaining).toBeNull();
});

test("サーバー接続に失敗すると保存状態バッジがオフラインを示す", async ({ page }) => {
  await page.route("**/api/health", (route) => route.abort("failed"));
  await openDock(page, "検査/承認");
  await page.getByRole("button", { name: "API Health" }).click();
  await expect(page.locator(".save-status")).toHaveText("オフライン");
  await expect(page.locator(".save-status")).toHaveClass(/offline/);
  await expect(page.locator(".save-status")).toHaveAttribute("title", /このブラウザにのみ保存/);
});

test("保存要求が失敗すると保存状態バッジは「保存に失敗しました」を示し「サーバー同期済み」のままにしない", async ({ page }) => {
  await openDock(page, "検査/承認");
  await page.getByRole("button", { name: "API Health" }).click();
  await expect(page.locator(".save-status")).toHaveText("サーバー同期済み");

  await page.route("**/api/drawings/*/transactions", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: "internal error" }) })
  );

  const canvas = page.getByLabel("作図キャンバス");
  await page.getByRole("button", { name: "線", exact: true }).click();
  await canvas.click({ position: { x: 100, y: 100 } });
  await canvas.click({ position: { x: 200, y: 150 } });

  await expect(page.locator(".save-status")).toHaveText("保存に失敗しました");
  await expect(page.locator(".save-status")).toHaveClass(/offline/);
});

test("狭い画面でも主要操作領域が表示範囲を破綻させない", async ({ page }) => {
  const metrics = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth
  }));
  expect(metrics.content).toBeLessThanOrEqual(metrics.viewport + 1);
  await expect(page.getByRole("button", { name: "新規図面" })).toBeVisible();
  await expect(page.getByLabel("作図キャンバス")).toBeVisible();
  await expect(page.getByRole("button", { name: "システム設定" })).toBeVisible();
  await expect(page.getByLabel("リボンタブ")).toBeVisible();
  expect((await page.getByLabel("コマンドライン").boundingBox()).height).toBeLessThanOrEqual(110);
});

test("右パネル幅をドラッグ・キーボードで調整して保存できる", async ({ page }, testInfo) => {
  const handle = page.getByRole("separator", { name: "右パネル幅を調整" });
  if (testInfo.project.name === "mobile-chromium") {
    await expect(handle).toBeHidden();
    return;
  }

  const initialWidth = Number(await handle.getAttribute("aria-valuenow"));
  const initialHandleBox = await handle.boundingBox();
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, {
    x: initialHandleBox.x + 2,
    y: initialHandleBox.y + 20
  })).toBe("dockResizeHandle");
  await handle.focus();
  await handle.press("ArrowLeft");
  await expect(handle).toHaveAttribute("aria-valuenow", String(initialWidth + 8));

  const resizedHandleBox = await handle.boundingBox();
  await page.mouse.move(resizedHandleBox.x + 2, resizedHandleBox.y + 20);
  await page.mouse.down();
  await page.mouse.move(resizedHandleBox.x - 32, resizedHandleBox.y + 20);
  await page.mouse.up();
  const resizedWidth = Number(await handle.getAttribute("aria-valuenow"));
  expect(resizedWidth).toBeGreaterThanOrEqual(initialWidth + 8 + 27);
  expect(resizedWidth).toBeLessThanOrEqual(initialWidth + 8 + 37);

  await page.reload();
  await expect(page.getByRole("separator", { name: "右パネル幅を調整" })).toHaveAttribute("aria-valuenow", String(resizedWidth));
  expect(Math.round((await page.getByLabel("図面情報パネル").boundingBox()).width)).toBe(resizedWidth);
});

test("高度CAD編集、レイヤー、レイアウトを一連操作できる", async ({ page }) => {
  const command = page.getByLabel("コマンド入力");
  await openDock(page, "プロパティ");
  const quantity = quantityLocator(page);
  const before = Number(await quantity.textContent());

  for (const value of ["DIM 1000,1000 2500,1000", "HATCH 3000,1000 4000,1000 4000,1800 3000,1800", "SELECT e_box_1", "OFFSET 150", "ROTATE 15", "SCALE 1.05"]) {
    await command.fill(value);
    await command.press("Enter");
  }
  await expect(quantity).toHaveText(String(before + 3));
  await expect(page.getByRole("heading", { name: "CAD Operations" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Properties" })).toBeVisible();

  await page.getByLabel("図形操作").selectOption("block");
  await page.getByLabel("操作値").fill("構造物記号");
  await page.getByRole("button", { name: "選択図形へ適用" }).click();
  await page.locator("#propertyForm input[name=blockAttributes]").fill("番号=B-01;種別=構造物");
  await page.getByRole("button", { name: "プロパティ更新" }).click();
  await expect(page.locator("#propertyForm input[name=blockAttributes]")).toHaveValue("番号=B-01;種別=構造物");

  await openDock(page, "レイヤー");
  await page.getByLabel("新規レイヤー名").fill("測量");
  await page.getByRole("button", { name: "レイヤー追加" }).click();
  await expect(page.getByLabel("図面情報パネル").getByText("測量", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "レイアウト1", exact: true }).click();
  await page.locator("#layoutForm select[name=paper]").selectOption("A1");
  await page.locator("#layoutForm input[name=scale]").fill("200");
  await page.getByRole("button", { name: "設定保存" }).click();
  await expect(page.locator("#layoutForm select[name=paper]")).toHaveValue("A1");
  await page.evaluate(() => { window.print = () => localStorage.setItem("print-invoked", "yes"); });
  await page.getByRole("button", { name: "PDF / 印刷" }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("print-invoked"))).toBe("yes");
});

test("直交モードは水平・垂直に拘束し、OSnapは既存図形の頂点へ吸着する", async ({ page }) => {
  await page.getByRole("button", { name: "システム設定" }).click();
  await page.getByLabel("直交モード").check();
  await page.getByLabel("図形スナップ（OSnap）").check();
  await page.getByRole("button", { name: "適用", exact: true }).click();

  await page.getByRole("button", { name: "線", exact: true }).click();
  const canvas = page.getByLabel("作図キャンバス");
  await canvas.click({ position: { x: 80, y: 80 } });
  await canvas.click({ position: { x: 220, y: 140 } });
  const orthoLine = await page.evaluate(() => {
    const d = JSON.parse(localStorage.getItem("mirai-web-cad-mvp"));
    return d.entities[d.entities.length - 1].points;
  });
  expect(orthoLine[0].y).toBe(orthoLine[1].y);

  await openDock(page, "検査/承認");
  await page.getByRole("button", { name: "空", exact: true }).click();
  await page.getByRole("button", { name: "正常", exact: true }).click();
});

test("面積・ID点ツールがコマンドログへ計測結果を出力する", async ({ page }) => {
  const canvas = page.getByLabel("作図キャンバス");
  await page.getByRole("button", { name: "面積", exact: true }).click();
  await canvas.click({ position: { x: 80, y: 80 } });
  await canvas.click({ position: { x: 200, y: 160 } });
  await expect(page.getByLabel("コマンドログ")).toContainText("AREA =");

  await page.getByRole("button", { name: "ID点", exact: true }).click();
  await canvas.click({ position: { x: 120, y: 100 } });
  await expect(page.getByLabel("コマンドログ")).toContainText("ID点");
});

test("レイアウト空間のプレビューに実データの表題欄が表示される", async ({ page }) => {
  await page.getByRole("button", { name: "レイアウト1", exact: true }).click();
  await expect(page.locator(".layout-titleblock")).toContainText("道路拡幅 仮設施工図");
  await expect(page.locator(".layout-titleblock")).toContainText("v1");
  await expect(page.locator(".layout-titleblock")).toContainText("1:100");
});

test("レイアウト用紙はCSP適用下でもcomputed width/heightが0にならない", async ({ page }) => {
  await page.getByRole("button", { name: "レイアウト1", exact: true }).click();
  const page1 = page.locator(".layout-page");
  const box = await page1.boundingBox();
  if (!box) throw new Error("layout-page bounding box is null");
  expect(box.width).toBeGreaterThan(100);
  expect(box.height).toBeGreaterThan(100);
});

test("用紙サイズ選択(A4/A1)がレイアウト用紙のサイズへ反映される", async ({ page }) => {
  await page.getByRole("button", { name: "レイアウト1", exact: true }).click();
  const paper = page.locator(".layout-page");

  await page.locator("#layoutForm select[name=paper]").selectOption("A4");
  await page.getByRole("button", { name: "設定保存" }).click();
  const a4Box = await paper.boundingBox();
  if (!a4Box) throw new Error("layout-page bounding box is null (A4)");

  await page.locator("#layoutForm select[name=paper]").selectOption("A1");
  await page.getByRole("button", { name: "設定保存" }).click();
  const a1Box = await paper.boundingBox();
  if (!a1Box) throw new Error("layout-page bounding box is null (A1)");

  expect(a1Box.width).toBeGreaterThan(a4Box.width);
  expect(a1Box.height).toBeGreaterThan(a4Box.height);
});

test("用紙サイズ選択は「設定保存」を押す前でもプレビューへ即時反映される(A4/A3/A1)", async ({ page }) => {
  await page.getByRole("button", { name: "レイアウト1", exact: true }).click();
  const paper = page.locator(".layout-page");
  const paperSelect = page.locator("#layoutForm select[name=paper]");

  // 初期状態(A3)であることを確認
  await expect(paperSelect).toHaveValue("A3");
  await expect(page.locator(".paper-note")).toContainText("A3");
  const a3Box = await paper.boundingBox();
  if (!a3Box) throw new Error("layout-page bounding box is null (A3, initial)");

  // A4(未保存)へ切替: A3より小さいプレビューへ即時反映される
  await paperSelect.selectOption("A4");
  await expect(page.locator(".paper-note")).toContainText("A4");
  const a4Box = await paper.boundingBox();
  if (!a4Box) throw new Error("layout-page bounding box is null (A4, unsaved preview)");
  expect(a4Box.width).toBeLessThan(a3Box.width);
  expect(a4Box.height).toBeLessThan(a3Box.height);

  // A1(未保存)へ切替: A4より大きいプレビューへ即時反映される
  await paperSelect.selectOption("A1");
  await expect(page.locator(".paper-note")).toContainText("A1");
  const a1Box = await paper.boundingBox();
  if (!a1Box) throw new Error("layout-page bounding box is null (A1, unsaved preview)");
  expect(a1Box.width).toBeGreaterThan(a4Box.width);
  expect(a1Box.height).toBeGreaterThan(a4Box.height);
});

test("未保存のレイアウト選択はモデル/レイアウト空間切替後もプレビューに保持される", async ({ page }) => {
  await page.getByRole("button", { name: "レイアウト1", exact: true }).click();
  await page.locator("#layoutForm select[name=paper]").selectOption("A1");
  await expect(page.locator(".paper-note")).toContainText("A1");

  await page.getByRole("button", { name: "モデル", exact: true }).click();
  await page.getByRole("button", { name: "レイアウト1", exact: true }).click();

  await expect(page.locator("#layoutForm select[name=paper]")).toHaveValue("A1");
  await expect(page.locator(".paper-note")).toContainText("A1");
});

test("DXF書出しは図面をASCII DXFとしてダウンロードできる", async ({ page }) => {
  await page.getByRole("button", { name: "出力", exact: true }).click();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "DXF書出し", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.dxf$/);

  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const content = Buffer.concat(chunks).toString("utf8");
  expect(content).toContain("SECTION");
  expect(content).toContain("ENTITIES");
  expect(content).toContain("EOF");
  // デモ図面の代表図形(entity)が含まれる(フレーム線・クレーン円・注記)
  expect(content).toContain("LINE");
  expect(content).toContain("CIRCLE");
  expect(content).toContain("TEXT");
});

test("システム設定でOSnap対象モードを選択・保存・再読込できる", async ({ page }) => {
  await page.getByRole("button", { name: "システム設定" }).click();
  const dialog = page.getByRole("dialog", { name: "システム設定" });
  await expect(dialog).toBeVisible();

  // OSnap対象の既定状態: 端点/中点/中心/四分点/交点はON、垂線/近接点はOFF
  await expect(page.getByLabel("端点")).toBeChecked();
  await expect(page.getByLabel("中点")).toBeChecked();
  await expect(page.getByLabel("中心")).toBeChecked();
  await expect(page.getByLabel("四分点")).toBeChecked();
  await expect(page.getByLabel("交点")).toBeChecked();
  await expect(page.getByLabel("垂線")).not.toBeChecked();
  await expect(page.getByLabel("近接点")).not.toBeChecked();

  // OSnapを有効化し、垂線・近接点をON、交点をOFFへ変更
  await page.getByLabel("図形スナップ（OSnap）").check();
  await page.getByLabel("垂線").check();
  await page.getByLabel("近接点").check();
  await page.getByLabel("交点").uncheck();
  await page.getByRole("button", { name: "適用", exact: true }).click();
  await expect(dialog).not.toBeVisible();

  await page.reload();
  await page.getByRole("button", { name: "システム設定" }).click();
  await expect(page.getByLabel("図形スナップ（OSnap）")).toBeChecked();
  await expect(page.getByLabel("垂線")).toBeChecked();
  await expect(page.getByLabel("近接点")).toBeChecked();
  await expect(page.getByLabel("交点")).not.toBeChecked();
  await expect(page.getByLabel("端点")).toBeChecked();
});

test("精密編集コマンド(MIRROR/ARRAY/BREAK/JOIN)がコマンドラインから動作する", async ({ page }) => {
  await page.getByRole("button", { name: "新規図面" }).click();
  await page.getByLabel("図面名").fill("精密編集E2E");
  await page.getByLabel("テンプレート").selectOption("blank");
  await page.getByRole("button", { name: "作成", exact: true }).click();

  const quantity = quantityLocator(page);
  const command = page.getByLabel("コマンド入力");
  await command.fill("LINE 0,0 1000,0");
  await command.press("Enter");
  await expect(quantity).toHaveText("1");
  await expect(page.getByLabel("コマンドログ")).toContainText("CLI LINE");

  // SELECT→MIRROR: x=0の縦軸で反転(y=0線分は負側へ)
  const lineId = await page.evaluate(() => {
    const d = JSON.parse(localStorage.getItem("mirai-web-cad-mvp"));
    return d.entities[0].id;
  });
  await command.fill(`SELECT ${lineId}`);
  await command.press("Enter");
  await command.fill("MIRROR 0,0 0,100");
  await command.press("Enter");
  await expect(page.getByLabel("コマンドログ")).toContainText("MIRROR");
  const mirroredPoints = await page.evaluate(() => {
    const d = JSON.parse(localStorage.getItem("mirai-web-cad-mvp"));
    return d.entities[0].points;
  });
  expect(mirroredPoints[1].x).toBe(-1000);

  // ARRAY: 2×2、列間隔2000/行間隔1000 → +3件
  await command.fill("ARRAY 2 2 2000 1000");
  await command.press("Enter");
  await expect(quantity).toHaveText("4");
  await expect(page.getByLabel("コマンドログ")).toContainText("ARRAY");

  // BREAK: 別の線分を用意して分割
  await command.fill("LINE 0,3000 1000,3000");
  await command.press("Enter");
  await expect(quantity).toHaveText("5");
  const line2Id = await page.evaluate(() => {
    const d = JSON.parse(localStorage.getItem("mirai-web-cad-mvp"));
    const e = d.entities.find((item) => item.points?.[0]?.y === 3000);
    return e.id;
  });
  await command.fill(`BREAK ${line2Id} 500,3000`);
  await command.press("Enter");
  await expect(quantity).toHaveText("6");
  await expect(page.getByLabel("コマンドログ")).toContainText("BREAK");

  // JOIN: 分割後の2線分(同一線上)を再結合
  const ids = await page.evaluate(() => {
    const d = JSON.parse(localStorage.getItem("mirai-web-cad-mvp"));
    return d.entities.filter((item) => item.points?.[0]?.y === 3000).map((item) => item.id);
  });
  await command.fill(`JOIN ${ids[0]} ${ids[1]}`);
  await command.press("Enter");
  await expect(quantity).toHaveText("5");
  await expect(page.getByLabel("コマンドログ")).toContainText("JOIN");
});

test("TRIM/EXTENDは境界交点で線分を正確に編集する", async ({ page }) => {
  await page.getByRole("button", { name: "新規図面" }).click();
  await page.getByLabel("図面名").fill("TRIM/EXTEND E2E");
  await page.getByLabel("テンプレート").selectOption("blank");
  await page.getByRole("button", { name: "作成", exact: true }).click();

  const command = page.getByLabel("コマンド入力");
  // 対象線(0,0)-(1000,0)と、境界の縦線x=500を作成
  await command.fill("LINE 0,0 1000,0");
  await command.press("Enter");
  await command.fill("LINE 500,-100 500,100");
  await command.press("Enter");

  const entities = () => page.evaluate(() => JSON.parse(localStorage.getItem("mirai-web-cad-mvp")).entities);
  const targetId = await entities().then((list) => list.find((e) => e.type === "line" && e.points[1].x === 1000 && e.points[1].y === 0).id);

  // TRIM: クリック点(800,0)で右側を残す → 線が(500,0)-(1000,0)になる
  await command.fill(`SELECT ${targetId}`);
  await command.press("Enter");
  await command.fill("TRIM 800,0");
  await command.press("Enter");
  await expect(page.getByLabel("コマンドログ")).toContainText("TRIM");
  const afterTrim = await entities().then((list) => list.find((e) => e.id === targetId));
  expect(afterTrim.points[0].x).toBe(500);
  expect(afterTrim.points[1].x).toBe(1000);

  // EXTEND: 左端点(500,0)をx=-100の境界まで延長。クリック点(550,0)は(500,0)側に近い
  await command.fill("LINE -100,-100 -100,100");
  await command.press("Enter");
  await command.fill(`EXTEND ${targetId} 550,0`);
  await command.press("Enter");
  await expect(page.getByLabel("コマンドログ")).toContainText("EXTEND");
  const afterExtend = await entities().then((list) => list.find((e) => e.id === targetId));
  // EXTENDはクリック点に近い端点(500,0)を、その外側にある境界x=-100まで延長する
  expect(afterExtend.points.some((p) => p.x === -100)).toBe(true);
  expect(afterExtend.points.some((p) => p.x === 1000)).toBe(true);
});

test("CHAMFER/FILLET/BOUNDARY/PEDITをコマンドラインから実操作できる", async ({ page }) => {
  await page.getByRole("button", { name: "新規図面" }).click();
  await page.getByLabel("図面名").fill("精密編集Round 6 E2E");
  await page.getByLabel("テンプレート").selectOption("blank");
  await page.getByRole("button", { name: "作成", exact: true }).click();
  const command = page.getByLabel("コマンド入力");
  const entities = () => page.evaluate(() => JSON.parse(localStorage.getItem("mirai-web-cad-mvp")).entities);

  for (const value of ["LINE 0,0 1000,0", "LINE 1000,0 1000,800", "LINE 1000,800 0,800", "LINE 0,800 0,0"]) {
    await command.fill(value);
    await command.press("Enter");
  }
  const edgeIds = await entities().then((list) => list.map((entity) => entity.id));
  await command.fill(`BOUNDARY ${edgeIds.join(" ")}`);
  await command.press("Enter");
  const boundary = await entities().then((list) => list.find((entity) => entity.type === "polyline"));
  expect(boundary.closed).toBe(true);

  await command.fill(`PEDIT ${boundary.id} MOVE 2 1200,0`);
  await command.press("Enter");
  const edited = await entities().then((list) => list.find((entity) => entity.id === boundary.id));
  expect(edited.points[1]).toEqual({ x: 1200, y: 0 });

  await command.fill("LINE 2000,0 3000,0");
  await command.press("Enter");
  await command.fill("LINE 2000,0 2000,1000");
  await command.press("Enter");
  const chamferIds = await entities().then((list) => list.slice(-2).map((entity) => entity.id));
  await command.fill(`CHAMFER ${chamferIds[0]} ${chamferIds[1]} 100`);
  await command.press("Enter");
  await expect(page.getByLabel("コマンドログ")).toContainText("CHAMFER");

  await command.fill("LINE 4000,0 5000,0");
  await command.press("Enter");
  await command.fill("LINE 4000,0 4000,1000");
  await command.press("Enter");
  const filletIds = await entities().then((list) => list.slice(-2).map((entity) => entity.id));
  await command.fill(`FILLET ${filletIds[0]} ${filletIds[1]} 100`);
  await command.press("Enter");
  await expect(page.getByLabel("コマンドログ")).toContainText("FILLET");
  const arc = await entities().then((list) => list.at(-1));
  expect(arc.type).toBe("arc");
  expect(arc.radius).toBe(100);

  await command.fill("ARC 6000,1000 500 350 20");
  await command.press("Enter");
  const commandedArc = await entities().then((list) => list.at(-1));
  expect(commandedArc).toMatchObject({ type: "arc", center: { x: 6000, y: 1000 }, radius: 500, startAngle: 350, endAngle: 20 });

  await page.getByRole("button", { name: "ホーム", exact: true }).click();
  for (const label of ["円弧", "面取り", "フィレット", "境界作成", "ポリライン編集"]) {
    await expect(page.getByRole("button", { name: label, exact: true })).toBeVisible();
  }
});

test("ELLIPSE/SPLINEをネイティブ図形として作図・保存できる", async ({ page }) => {
  await page.getByRole("button", { name: "新規図面" }).click();
  await page.getByLabel("図面名").fill("曲線作図 E2E");
  await page.getByLabel("テンプレート").selectOption("blank");
  await page.getByRole("button", { name: "作成", exact: true }).click();

  const command = page.getByLabel("コマンド入力");
  await command.fill("ELLIPSE 1000,1000 500 250 30");
  await command.press("Enter");
  await command.fill("SPLINE 2000,1000 2300,1500 2700,1500 3000,1000");
  await command.press("Enter");

  const curves = await page.evaluate(() => JSON.parse(localStorage.getItem("mirai-web-cad-mvp")).entities);
  expect(curves).toHaveLength(2);
  expect(curves[0]).toMatchObject({ type: "ellipse", radiusX: 500, radiusY: 250, rotation: 30 });
  expect(curves[1]).toMatchObject({ type: "spline", degree: 3 });
  expect(curves[1].controlPoints).toHaveLength(4);
  expect(curves[1].knots).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);

  await page.getByRole("button", { name: "ホーム", exact: true }).click();
  await expect(page.getByRole("button", { name: "楕円", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "スプライン", exact: true })).toBeVisible();
  await expect(page.getByLabel("コマンドログ")).toContainText("SPLINE");
});

test("塗りつぶしHATCH(solidFill)はキャンバスで面として描画される", async ({ page }) => {
  // DXF group 70=1(solidFill)のHATCHは斜線ではなく面で塗る。斜線描画のままだと
  // 境界ボックスに対する塗りピクセル比が小さくなるため、比率で判別する。
  const imported = {
    layers: [{ id: "fill", name: "塗装", color: "#2244cc" }],
    entities: [{ type: "hatch", layerId: "fill", pattern: "SOLID", solidFill: true, spacing: 400,
      points: [{ x: 500, y: 500 }, { x: 3500, y: 500 }, { x: 3500, y: 2500 }, { x: 500, y: 2500 }] }]
  };
  const before = Number(await quantityLocator(page).textContent());
  await page.locator("#importFile").setInputFiles({
    name: "solid-hatch.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(imported))
  });
  await expect(quantityLocator(page)).toHaveText(String(before + 1));

  const coverage = await page.getByLabel("作図キャンバス").evaluate((canvas) => {
    const ctx = canvas.getContext("2d");
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const target = [0x22, 0x44, 0xcc];
    let count = 0, minX = width, minY = height, maxX = -1, maxY = -1;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4;
        if (Math.abs(data[i] - target[0]) > 10 || Math.abs(data[i + 1] - target[1]) > 10 || Math.abs(data[i + 2] - target[2]) > 10) continue;
        count += 1;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    const box = (maxX - minX + 1) * (maxY - minY + 1);
    return { count, ratio: box > 0 ? count / box : 0 };
  });
  expect(coverage.count).toBeGreaterThan(2000);
  expect(coverage.ratio).toBeGreaterThan(0.6);
});
