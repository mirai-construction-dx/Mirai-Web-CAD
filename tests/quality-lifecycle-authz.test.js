import test from "node:test";
import assert from "node:assert/strict";
import { handleApiRequest, resetMemoryStore } from "../src/api-handler.js";

// 図面ライフサイクル・版管理・承認・権限境界の品質テスト(synthetic fixture のみ)。
//
// 既存テストとの役割分担:
//  - api-handler.test.js は「個別エンドポイントの断片」(submit/approve/new_version の各応答、
//    Idempotency-Key、expected-version、監査、AI承認)を検証している。
//  - auth-hardening.test.js / project-access.test.js は認証モードと案件スコープの境界を検証している。
// 本ファイルは上記では未カバーだった「作成→編集→提出→承認→直接変更禁止→新版」の通し筋と、
// ロール境界(viewer/reviewer/approver/drafter)を権限行列として明示的に固定し、
// 途中失敗(不正geometry)時に図面が汚れず・冪等キーを焼かずに復旧できることを検証する。
//
// 対象外(無理に含めない): 帳票・BIM/CIM・GIS・点群・工程・数量・原価・文書管理・案件工区管理。

const env = { AUTH_MODE: "demo", APP_ENV: "preview" };

function buildRequest(path, { method = "GET", role = "drafter", idempotencyKey, expectedVersion, body } = {}) {
  const headers = { "x-demo-role": role };
  if (idempotencyKey !== undefined) headers["idempotency-key"] = idempotencyKey;
  if (expectedVersion !== undefined) headers["expected-version"] = String(expectedVersion);
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(`https://example.test/api${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
}

const call = (path, opts = {}) => handleApiRequest(buildRequest(path, opts), env);

// モデル範囲内の正しい線分。geometry検査を通る合成図形。
const lineEntity = (id, x0 = 0, y0 = 0, x1 = 500, y1 = 300) => ({
  id,
  type: "line",
  layerId: "layer-frame",
  points: [
    { x: x0, y: y0 },
    { x: x1, y: y1 }
  ]
});

async function createDrawing(name = "ライフサイクル検証図面", unit = "m", key = "create-drawing", role = "drafter") {
  const response = await call("/drawings", {
    method: "POST",
    role,
    idempotencyKey: key,
    body: { name, unit }
  });
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()).drawing;
}

async function transaction(drawingId, { key, version, role = "drafter", commands }) {
  return call(`/drawings/${drawingId}/transactions`, {
    method: "POST",
    role,
    idempotencyKey: key,
    expectedVersion: version,
    body: { label: key, commands }
  });
}

async function review(drawingId, { action, key, version, role }) {
  return call(`/drawings/${drawingId}/review`, {
    method: "POST",
    role,
    idempotencyKey: key,
    expectedVersion: version,
    body: { action }
  });
}

test("正常系: 作成→transaction編集→提出→承認→承認済み版の直接変更禁止→新版", async () => {
  resetMemoryStore();

  // 1. 図面作成(空図面/単位m)
  const created = await createDrawing("道路拡幅ライフサイクル", "m", "lc-create");
  assert.equal(created.state, "draft");
  assert.equal(created.version, 1);
  assert.equal(created.revision, 1);
  assert.equal(created.entities.length, 0);
  const drawingId = created.id;

  // 2. transaction編集(楽観ロック revision 1→2)
  const edited = await transaction(drawingId, { key: "lc-edit", version: 1, commands: [{ op: "add", entity: lineEntity("e_lc_1") }] });
  assert.equal(edited.status, 200, await edited.clone().text());
  let drawing = (await edited.json()).drawing;
  assert.equal(drawing.revision, 2);
  assert.equal(drawing.entities.length, 1);

  // 3. レビュー提出(revision 2→3, in_review)
  const submitted = await review(drawingId, { action: "submit", key: "lc-submit", version: 2, role: "drafter" });
  assert.equal(submitted.status, 200, await submitted.clone().text());
  drawing = (await submitted.json()).drawing;
  assert.equal(drawing.state, "in_review");
  assert.equal(drawing.revision, 3);

  // 4. 承認(approver, revision 3→4, approved)
  const approved = await review(drawingId, { action: "approve", key: "lc-approve", version: 3, role: "approver" });
  assert.equal(approved.status, 200, await approved.clone().text());
  drawing = (await approved.json()).drawing;
  assert.equal(drawing.state, "approved");
  assert.equal(drawing.revision, 4);

  // 5. 承認済み版への transaction は直接変更できない(409)
  const blocked = await transaction(drawingId, { key: "lc-blocked", version: 4, commands: [{ op: "add", entity: lineEntity("e_lc_blocked") }] });
  assert.equal(blocked.status, 409);
  assert.match((await blocked.json()).error, /承認済み版/);

  // 6. 新版作成(approver, revision 4→5, draft, version 2)
  const next = await review(drawingId, { action: "new_version", key: "lc-new-version", version: 4, role: "approver" });
  assert.equal(next.status, 200, await next.clone().text());
  drawing = (await next.json()).drawing;
  assert.equal(drawing.state, "draft");
  assert.equal(drawing.version, 2);
  assert.equal(drawing.revision, 5);
});

test("権限境界: viewerは取得できるが書込み・承認・コメントが全てできない", async () => {
  resetMemoryStore();

  const get = await call("/drawings/dwg_demo_001", { role: "viewer" });
  assert.equal(get.status, 200);

  const tx = await transaction("dwg_demo_001", { key: "viewer-tx", version: 1, role: "viewer", commands: [{ op: "add", entity: lineEntity("e_viewer") }] });
  assert.equal(tx.status, 403);
  assert.match((await tx.json()).error, /権限/);

  const approve = await review("dwg_demo_001", { action: "approve", key: "viewer-approve", version: 1, role: "viewer" });
  assert.equal(approve.status, 403);
  assert.match((await approve.json()).error, /権限/);

  const comment = await call("/drawings/dwg_demo_001/comments", {
    method: "POST",
    role: "viewer",
    idempotencyKey: "viewer-comment",
    expectedVersion: 1,
    body: { body: "閲覧のみ" }
  });
  assert.equal(comment.status, 403);
  assert.match((await comment.json()).error, /権限/);
});

test("権限境界: reviewerはコメントできるがtransaction(図面変更)できない", async () => {
  resetMemoryStore();

  const comment = await call("/drawings/dwg_demo_001/comments", {
    method: "POST",
    role: "reviewer",
    idempotencyKey: "reviewer-comment",
    expectedVersion: 1,
    body: { body: "寸法を確認してください", entityId: "e_box_1" }
  });
  assert.equal(comment.status, 201, await comment.clone().text());
  const commented = (await comment.json()).drawing;
  assert.equal(commented.comments.length, 1);

  const tx = await transaction("dwg_demo_001", { key: "reviewer-tx", version: commented.revision, role: "reviewer", commands: [{ op: "add", entity: lineEntity("e_reviewer") }] });
  assert.equal(tx.status, 403);
  assert.match((await tx.json()).error, /権限/);
});

test("権限境界: approverは承認できるがtransactionできない", async () => {
  resetMemoryStore();

  const created = await createDrawing("承認境界", "m", "ap-create");
  const drawingId = created.id;
  await transaction(drawingId, { key: "ap-edit", version: 1, commands: [{ op: "add", entity: lineEntity("e_ap_1") }] });
  const submitted = await review(drawingId, { action: "submit", key: "ap-submit", version: 2, role: "drafter" });
  assert.equal(submitted.status, 200);

  const tx = await transaction(drawingId, { key: "ap-tx", version: 3, role: "approver", commands: [{ op: "add", entity: lineEntity("e_ap_2") }] });
  assert.equal(tx.status, 403);
  assert.match((await tx.json()).error, /権限/);

  const approved = await review(drawingId, { action: "approve", key: "ap-approve", version: 3, role: "approver" });
  assert.equal(approved.status, 200, await approved.clone().text());
  assert.equal((await approved.json()).drawing.state, "approved");
});

test("権限境界: drafterは承認できない(canApproveなし)", async () => {
  resetMemoryStore();

  const created = await createDrawing("drafter承認不可", "m", "dr-create");
  const drawingId = created.id;
  await transaction(drawingId, { key: "dr-edit", version: 1, commands: [{ op: "add", entity: lineEntity("e_dr_1") }] });
  const submitted = await review(drawingId, { action: "submit", key: "dr-submit", version: 2, role: "drafter" });
  assert.equal(submitted.status, 200);

  const approve = await review(drawingId, { action: "approve", key: "dr-approve", version: 3, role: "drafter" });
  assert.equal(approve.status, 403);
  assert.match((await approve.json()).error, /権限/);
});

test("異常・境界: expected-version不正/不一致(428/409)とIdempotency-Key重複(409)", async () => {
  resetMemoryStore();

  // expected-version 欠落 → 428
  const missing = await call("/drawings/dwg_demo_001/transactions", {
    method: "POST",
    role: "drafter",
    idempotencyKey: "ev-missing",
    body: { label: "missing", commands: [] }
  });
  assert.equal(missing.status, 428);

  // 非10進整数("1.0")→ 428
  const nonInteger = await call("/drawings/dwg_demo_001/transactions", {
    method: "POST",
    role: "drafter",
    idempotencyKey: "ev-float",
    expectedVersion: "1.0",
    body: { label: "float", commands: [] }
  });
  assert.equal(nonInteger.status, 428);

  // 不一致 → 409
  const mismatch = await call("/drawings/dwg_demo_001/transactions", {
    method: "POST",
    role: "drafter",
    idempotencyKey: "ev-mismatch",
    expectedVersion: "99",
    body: { label: "mismatch", commands: [] }
  });
  assert.equal(mismatch.status, 409);
  assert.match((await mismatch.json()).error, /リビジョン/);

  // Idempotency-Key 重複 → 409
  const key = "idem-dup-quality";
  const first = await call("/drawings/dwg_demo_001/transactions", {
    method: "POST",
    role: "drafter",
    idempotencyKey: key,
    expectedVersion: "1",
    body: { label: "first", commands: [] }
  });
  assert.equal(first.status, 200);
  const second = await call("/drawings/dwg_demo_001/transactions", {
    method: "POST",
    role: "drafter",
    idempotencyKey: key,
    expectedVersion: "2",
    body: { label: "second", commands: [] }
  });
  assert.equal(second.status, 409);
  assert.match((await second.json()).error, /処理済み/);
});

test("異常・境界: 存在しない図面→404、不正なrole→401", async () => {
  resetMemoryStore();

  const get = await call("/drawings/dwg_does_not_exist", { role: "viewer" });
  assert.equal(get.status, 404);

  const tx = await call("/drawings/dwg_does_not_exist/transactions", {
    method: "POST",
    role: "drafter",
    idempotencyKey: "nf-tx",
    expectedVersion: "1",
    body: { commands: [] }
  });
  assert.equal(tx.status, 404);

  // demo認証では ROLE_POLICIES に存在しないロールは 401 で fail-closed に拒否される
  const invalid = await call("/drawings/dwg_demo_001", { role: "superadmin" });
  assert.equal(invalid.status, 401);
  assert.match((await invalid.json()).error, /デモ権限/);
});

test("途中失敗・復旧: 不正geometry(pointsの無いline)は保存前に400で拒否され、図面は不変・冪等キーを焼かない", async () => {
  resetMemoryStore();

  const created = await createDrawing("geometry復旧", "m", "geom-create");
  const drawingId = created.id;

  const before = await call(`/drawings/${drawingId}`, { role: "viewer" });
  const beforeBody = await before.json();

  // points の無い line を含む transaction → 保存前に 400
  const bad = await transaction(drawingId, {
    key: "geom-recovery",
    version: 1,
    commands: [{ op: "add", entity: { id: "e_bad_line", type: "line", layerId: "layer-frame" } }]
  });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /図形が不正/);

  // 図面が変更されていない(再取得して一致確認)
  const after = await call(`/drawings/${drawingId}`, { role: "viewer" });
  const afterBody = await after.json();
  assert.equal(afterBody.drawing.revision, beforeBody.drawing.revision);
  assert.equal(afterBody.drawing.entities.length, 0);
  assert.equal(afterBody.drawing.state, "draft");

  // 同じ Idempotency-Key で正しい内容を再送すると 200 で適用される
  const ok = await transaction(drawingId, {
    key: "geom-recovery",
    version: 1,
    commands: [{ op: "add", entity: lineEntity("e_good_line") }]
  });
  assert.equal(ok.status, 200, await ok.clone().text());
  const okBody = await ok.json();
  assert.equal(okBody.drawing.revision, 2);
  assert.equal(okBody.drawing.entities.length, 1);
  assert.equal(okBody.drawing.entities[0].id, "e_good_line");
});
