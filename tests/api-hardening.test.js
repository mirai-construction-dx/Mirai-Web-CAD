import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  API_SECURITY_HEADERS,
  CONTENT_SECURITY_POLICY,
  STRICT_TRANSPORT_SECURITY as API_HSTS,
  csvEscape,
  handleApiRequest,
  resetMemoryStore
} from "../src/api-handler.js";
import { STRICT_TRANSPORT_SECURITY as BRIDGE_HSTS, loadHeaderRules, makeHeadersResolver } from "../scripts/lib/http-bridge.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pagesFunction = await import("../functions/api/[[path]].js");

// 2026-09-18の追加セキュリティ精査で検出した、API入力検証・冪等キー・CSV出力の
// 弱点に対する回帰テスト。いずれも「機能が動く」ことではなく「不正入力で
// 誤った成功や恒久的な操作不能に陥らない」ことを固定する。

const env = { AUTH_MODE: "demo", APP_ENV: "preview" };

async function createBlankDrawing(id) {
  const response = await handleApiRequest(
    new Request("https://example.test/api/drawings", {
      method: "POST",
      headers: { "content-type": "application/json", "x-demo-role": "drafter", "idempotency-key": `create-${id}` },
      body: JSON.stringify({ id, name: "検証用図面", unit: "mm" })
    }),
    env
  );
  assert.equal(response.status, 201, await response.clone().text());
}

function transactionRequest(drawingId, { commands, expectedVersion, key }) {
  const headers = {
    "content-type": "application/json",
    "x-demo-role": "drafter",
    "idempotency-key": key
  };
  if (expectedVersion !== undefined) headers["expected-version"] = expectedVersion;
  return new Request(`https://example.test/api/drawings/${drawingId}/transactions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ label: "検証", commands })
  });
}

test("commandsが配列でない場合は500ではなく400で拒否する", async () => {
  resetMemoryStore();
  await createBlankDrawing("dwg_h1");
  const response = await handleApiRequest(
    transactionRequest("dwg_h1", { commands: "not-an-array", expectedVersion: "1", key: "tx-h1" }),
    env
  );
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.match(body.error, /配列/);
});

test("1回の更新で送信できるコマンド数の上限を超えたら413で拒否する", async () => {
  resetMemoryStore();
  await createBlankDrawing("dwg_h2");
  const commands = Array.from({ length: 501 }, (_, index) => ({ op: "noop", index }));
  const response = await handleApiRequest(
    transactionRequest("dwg_h2", { commands, expectedVersion: "1", key: "tx-h2" }),
    env
  );
  const body = await response.json();
  assert.equal(response.status, 413);
  assert.match(body.error, /500件/);
});

test("上限以内のコマンドは従来どおり適用できる", async () => {
  resetMemoryStore();
  await createBlankDrawing("dwg_h3");
  const response = await handleApiRequest(
    transactionRequest("dwg_h3", { commands: [{ op: "set_empty_drawing_unit", unit: "m" }], expectedVersion: "1", key: "tx-h3" }),
    env
  );
  assert.equal(response.status, 200);
});

test("expected-versionは10進整数リテラルのみ受理する", async () => {
  resetMemoryStore();
  await createBlankDrawing("dwg_h4");
  for (const [index, value] of ["1e0", "0x1", "1.0", "-1", "1_0"].entries()) {
    const response = await handleApiRequest(
      transactionRequest("dwg_h4", { commands: [], expectedVersion: value, key: `tx-h4-${index}` }),
      env
    );
    assert.equal(response.status, 428, `expected-version=${value} は拒否されるべき`);
  }
  const accepted = await handleApiRequest(
    transactionRequest("dwg_h4", { commands: [], expectedVersion: "1", key: "tx-h4-ok" }),
    env
  );
  assert.equal(accepted.status, 200);
});

test("expected-versionが欠落している場合は428で拒否する", async () => {
  resetMemoryStore();
  await createBlankDrawing("dwg_h5");
  const response = await handleApiRequest(transactionRequest("dwg_h5", { commands: [], key: "tx-h5" }), env);
  assert.equal(response.status, 428);
});

test("本文不備で400を返したリクエストは冪等キーを消費せず、同じキーで再送できる", async () => {
  resetMemoryStore();
  const post = (body) =>
    handleApiRequest(
      new Request("https://example.test/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json", "x-demo-role": "cad_admin", "idempotency-key": "project-retry" },
        body: JSON.stringify(body)
      }),
      env
    );

  const invalid = await post({});
  assert.equal(invalid.status, 400);

  const retry = await post({ name: "再送で作成できる案件" });
  assert.equal(retry.status, 201, await retry.clone().text());

  // 成功した後の同一キー再送は、従来どおり二重実行として拒否される。
  const duplicate = await post({ name: "再送で作成できる案件" });
  assert.equal(duplicate.status, 409);
});

test("accessScope不正で400を返したPATCHも冪等キーを消費しない", async () => {
  resetMemoryStore();
  const created = await handleApiRequest(
    new Request("https://example.test/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json", "x-demo-role": "cad_admin", "idempotency-key": "patch-create" },
      body: JSON.stringify({ id: "prj_patch_check", name: "PATCH検証" })
    }),
    env
  );
  assert.equal(created.status, 201);

  const patch = (body) =>
    handleApiRequest(
      new Request("https://example.test/api/projects/prj_patch_check", {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-demo-role": "cad_admin", "idempotency-key": "project-patch-retry" },
        body: JSON.stringify(body)
      }),
      env
    );

  assert.equal((await patch({ accessScope: "invalid" })).status, 400);
  assert.equal((await patch({ accessScope: "restricted" })).status, 200);
});

test("監査CSVは先頭に空白・制御文字がある数式も無害化する", () => {
  // 到達経路(HTTPヘッダ/JWT)ではトリムされることが多いが、汎用エスケープとして
  // 先頭空白を読み飛ばす表計算ソフトの挙動まで塞いでおく。
  assert.equal(csvEscape(" =1+1@example.com"), "' =1+1@example.com");
  assert.equal(csvEscape("\t=cmd"), "'\t=cmd");
  assert.equal(csvEscape("\r@SUM(1)"), "\"'\r@SUM(1)\"");
  assert.equal(csvEscape("通常の値"), "通常の値");
  assert.equal(csvEscape('=a,"b"'), '"\'=a,""b"""');
});

test("監査CSVは数式で始まる値を無害化する(到達経路)", async () => {
  resetMemoryStore();
  const created = await handleApiRequest(
    new Request("https://example.test/api/projects", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-demo-role": "cad_admin",
        "x-demo-actor": "=1+1@example.com",
        "idempotency-key": "csv-proj"
      },
      body: JSON.stringify({ name: "CSV検証" })
    }),
    env
  );
  assert.equal(created.status, 201);

  const csv = await handleApiRequest(
    new Request("https://example.test/api/audit-logs/export", { method: "POST", headers: { "content-type": "application/json", "x-demo-role": "approver" } }),
    env
  );
  assert.equal(csv.status, 200);
  const body = await csv.text();
  assert.ok(body.includes("'=1+1@example.com"), `数式が無害化されていない:\n${body}`);
});

test("監査CSVの通常の値は従来どおり素通しする", async () => {
  resetMemoryStore();
  const created = await handleApiRequest(
    new Request("https://example.test/api/projects", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-demo-role": "cad_admin",
        "x-demo-actor": "cad-admin@example.com",
        "idempotency-key": "csv-proj-2"
      },
      body: JSON.stringify({ name: "CSV通常検証" })
    }),
    env
  );
  assert.equal(created.status, 201);
  const csv = await handleApiRequest(
    new Request("https://example.test/api/audit-logs/export", { method: "POST", headers: { "content-type": "application/json", "x-demo-role": "approver" } }),
    env
  );
  const body = await csv.text();
  assert.ok(body.includes("cad-admin@example.com"));
  assert.equal(body.includes("'cad-admin@example.com"), false);
});

// Cloudflare Pages Functionsの応答には`_headers`が適用されないため、API側でも
// 同じセキュリティヘッダを持つ必要がある。3箇所(_headers / API / http-bridge)の
// 値がずれると片方だけ無防備になるので、一致をテストで固定する。
test("_headersとAPIのCSP/HSTSは一致する(ドリフト防止)", async () => {
  const rules = await loadHeaderRules(path.join(__dirname, "..", "_headers"));
  const headersForPath = makeHeadersResolver(rules);
  assert.equal(headersForPath("/")["Content-Security-Policy"], CONTENT_SECURITY_POLICY);
  assert.equal(headersForPath("/")["Strict-Transport-Security"], API_HSTS);
  assert.equal(API_SECURITY_HEADERS["content-security-policy"], CONTENT_SECURITY_POLICY);
  assert.equal(API_SECURITY_HEADERS["strict-transport-security"], API_HSTS);
  assert.equal(BRIDGE_HSTS, API_HSTS);
});

test("_headersとAPIで共通のセキュリティヘッダは値が一致する(全項目)", async () => {
  // CSP/HSTSだけを比較していると、Permissions-Policyのような他項目が片方だけ
  // 古いまま残るドリフトを検出できない(2026-09-18の独立レビューで実際に発生)。
  const rules = await loadHeaderRules(path.join(__dirname, "..", "_headers"));
  const headersForPath = makeHeadersResolver(rules);
  const edge = headersForPath("/");
  for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) {
    const edgeValue = Object.entries(edge).find(([key]) => key.toLowerCase() === name)?.[1];
    assert.equal(edgeValue, value, `${name} が_headersとAPIで不一致`);
  }
});

test("API応答(JSON)にセキュリティヘッダが付く", async () => {
  resetMemoryStore();
  const response = await handleApiRequest(new Request("https://example.test/api/health"), env);
  for (const name of Object.keys(API_SECURITY_HEADERS)) {
    assert.equal(response.headers.get(name), API_SECURITY_HEADERS[name], `${name} が欠落`);
  }
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
});

test("Pages Functionsの503応答にもセキュリティヘッダが付く", async () => {
  const response = await pagesFunction.onRequest({
    request: new Request("https://mirai-web-cad.pages.dev/api/health"),
    env: { AUTH_MODE: "demo" }
  });
  assert.equal(response.status, 503);
  for (const name of Object.keys(API_SECURITY_HEADERS)) {
    assert.equal(response.headers.get(name), API_SECURITY_HEADERS[name], `${name} が欠落`);
  }
});

// applyTransactionは未知のopを黙って無視するため、綴り間違いでも200が返り
// 「何も起きていないのに成功した」状態になっていた。入力境界で拒否する。
test("未知のopは400で拒否する(黙って無視して成功を返さない)", async () => {
  resetMemoryStore();
  await createBlankDrawing("dwg_op1");
  const response = await handleApiRequest(
    transactionRequest("dwg_op1", { commands: [{ op: "add_line", type: "line" }], expectedVersion: "1", key: "tx-op1" }),
    env
  );
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.match(body.error, /opが不正です: add_line/);
});

test("コマンドがオブジェクトでない場合は400で拒否する", async () => {
  resetMemoryStore();
  await createBlankDrawing("dwg_op2");
  const cases = ["delete", null, ["add"]];
  for (const [index, command] of cases.entries()) {
    const response = await handleApiRequest(
      transactionRequest("dwg_op2", { commands: [command], expectedVersion: "1", key: `tx-op2-${index}` }),
      env
    );
    assert.equal(response.status, 400, `${JSON.stringify(command)} は拒否されるべき`);
  }
});

test("opが文字列でない場合も400で拒否する", async () => {
  resetMemoryStore();
  await createBlankDrawing("dwg_op3");
  const response = await handleApiRequest(
    transactionRequest("dwg_op3", { commands: [{ op: { nested: "add" } }], expectedVersion: "1", key: "tx-op3" }),
    env
  );
  assert.equal(response.status, 400);
});

test("pointsが上限を超えるコマンドは413で拒否する", async () => {
  resetMemoryStore();
  await createBlankDrawing("dwg_op4");
  const points = Array.from({ length: 10_001 }, (_, index) => ({ x: index, y: 0 }));
  const response = await handleApiRequest(
    transactionRequest("dwg_op4", {
      commands: [{ op: "add", type: "polyline", layerId: "layer-structure", points }],
      expectedVersion: "1",
      key: "tx-op4"
    }),
    env
  );
  assert.equal(response.status, 413);
});

test("許可されたop(SPAが送る13種)は引き続き適用できる", async () => {
  resetMemoryStore();
  await createBlankDrawing("dwg_op5");
  const response = await handleApiRequest(
    transactionRequest("dwg_op5", {
      commands: [
        { op: "add_layer", layer: { id: "layer-op-check", name: "検証", color: "#123456", visible: true, locked: false, printable: true } },
        { op: "update_layout", layout: { paper: "A4", orientation: "landscape" } },
        { op: "update_drawing_meta", name: "検証図面" }
      ],
      expectedVersion: "1",
      key: "tx-op5"
    }),
    env
  );
  assert.equal(response.status, 200, await response.clone().text());
});

// 業務処理が失敗したときに予約を残したままだと、「一度失敗した操作を二度と再試行できない」
// 状態になる(独立レビュー2026-09-18の指摘)。
test("業務処理が失敗した場合は冪等キーを解放し、同じキーで再送できる", async () => {
  resetMemoryStore();
  const create = await handleApiRequest(
    new Request("https://example.test/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json", "x-demo-role": "cad_admin", "idempotency-key": "release-create" },
      body: JSON.stringify({ id: "prj_release_target", name: "解放検証" })
    }),
    env
  );
  assert.equal(create.status, 201);

  const patch = (projectId) =>
    handleApiRequest(
      new Request(`https://example.test/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-demo-role": "cad_admin", "idempotency-key": "release-patch" },
        body: JSON.stringify({ accessScope: "restricted" })
      }),
      env
    );

  // 存在しない案件への更新は404で失敗する → 予約が解放される
  assert.equal((await patch("prj_does_not_exist")).status, 404);
  // 同じキーで正しい対象へ再送 → 409にならず成功する
  assert.equal((await patch("prj_release_target")).status, 200, "冪等キーが解放されていない");
});

test("成功した操作の予約は解放されない(二重実行は409のまま)", async () => {
  resetMemoryStore();
  const create = await handleApiRequest(
    new Request("https://example.test/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json", "x-demo-role": "cad_admin", "idempotency-key": "keep-create" },
      body: JSON.stringify({ id: "prj_release_target2", name: "保持検証" })
    }),
    env
  );
  assert.equal(create.status, 201);
  const patch = () =>
    handleApiRequest(
      new Request("https://example.test/api/projects/prj_release_target2", {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-demo-role": "cad_admin", "idempotency-key": "keep-patch" },
        body: JSON.stringify({ accessScope: "restricted" })
      }),
      env
    );
  assert.equal((await patch()).status, 200);
  assert.equal((await patch()).status, 409);
});

// op:"add"はcommand.entityが必須。欠落/null/空オブジェクトだとcad-core.jsの
// command.entity.layerId参照がTypeError→500になるため、入力境界で400に倒す
// (独立レビュー 2026-10-02)。
test("op:addでentityが欠落・null・空の場合は500ではなく400で拒否する", async () => {
  resetMemoryStore();
  await createBlankDrawing("dwg_add_entity");
  for (const [index, command] of [{ op: "add" }, { op: "add", entity: null }, { op: "add", entity: {} }].entries()) {
    const response = await handleApiRequest(
      transactionRequest("dwg_add_entity", { commands: [command], expectedVersion: "1", key: `tx-add-entity-${index}` }),
      env
    );
    assert.equal(response.status, 400, `${JSON.stringify(command)} は400で拒否されるべき`);
  }
});

// 不正なパーセント符号でdecodeURIComponentがURIError→500になっていた(独立レビュー 2026-10-02)。
test("DELETEメンバーの不正なパーセント符号は500ではなく400で拒否する", async () => {
  resetMemoryStore();
  const created = await handleApiRequest(
    new Request("https://example.test/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json", "x-demo-role": "cad_admin", "idempotency-key": "del-member-proj" },
      body: JSON.stringify({ id: "prj_del_member", name: "メンバー削除検証" })
    }),
    env
  );
  assert.equal(created.status, 201);
  const response = await handleApiRequest(
    new Request("https://example.test/api/projects/prj_del_member/members/%E0%A", {
      method: "DELETE",
      headers: { "x-demo-role": "cad_admin" }
    }),
    env
  );
  assert.equal(response.status, 400);
});

// labelに長さ上限が無くcommand_events.label(text)と監査detailが肥大化し得た(独立レビュー 2026-10-02)。
// 200文字へ切り詰めて保存する。長大なlabelでもエラーにならず適用できることを確認する。
test("長大なlabelでも200で適用でき、エラーにならない", async () => {
  resetMemoryStore();
  await createBlankDrawing("dwg_label_cap");
  const response = await handleApiRequest(
    new Request("https://example.test/api/drawings/dwg_label_cap/transactions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-demo-role": "drafter",
        "idempotency-key": "tx-label-cap",
        "expected-version": "1"
      },
      body: JSON.stringify({ label: "x".repeat(5000), commands: [{ op: "set_empty_drawing_unit", unit: "m" }] })
    }),
    env
  );
  assert.equal(response.status, 200);
});
