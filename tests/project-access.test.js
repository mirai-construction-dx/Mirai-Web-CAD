import test from "node:test";
import assert from "node:assert/strict";
import { handleApiRequest, resetMemoryStore } from "../src/api-handler.js";

const env = { AUTH_MODE: "demo", APP_ENV: "preview" };

function request(path, { method = "GET", role = "drafter", actorId = "demo@example.com", idempotencyKey, body, expectedVersion } = {}) {
  const headers = { "x-demo-role": role, "x-demo-actor": actorId };
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  if (expectedVersion !== undefined) headers["expected-version"] = String(expectedVersion);
  if (body !== undefined) headers["content-type"] = "application/json";
  return handleApiRequest(
    new Request(`https://example.test/api${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    }),
    env
  );
}

test("legacy demo project stays open: every role keeps reading the existing demo drawing", async () => {
  resetMemoryStore();
  for (const role of ["viewer", "drafter", "reviewer", "approver", "cad_admin"]) {
    const response = await request("/drawings/dwg_demo_001", { role });
    assert.equal(response.status, 200, `role=${role} should read the legacy open-project drawing`);
  }
});

test("only cad_admin can create and manage projects", async () => {
  resetMemoryStore();
  const denied = await request("/projects", {
    method: "POST",
    role: "drafter",
    idempotencyKey: "proj-1",
    body: { name: "非公開案件" }
  });
  assert.equal(denied.status, 403);

  const created = await request("/projects", {
    method: "POST",
    role: "cad_admin",
    idempotencyKey: "proj-2",
    body: { name: "非公開案件", accessScope: "restricted" }
  });
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  assert.equal(createdBody.project.accessScope, "restricted");

  const duplicate = await request("/projects", {
    method: "POST",
    role: "cad_admin",
    idempotencyKey: "proj-2",
    body: { name: "別案件" }
  });
  assert.equal(duplicate.status, 409);
});

test("restricted project blocks non-members and admits registered members", async () => {
  resetMemoryStore();
  const createProject = await request("/projects", {
    method: "POST",
    role: "cad_admin",
    idempotencyKey: "proj-restricted-1",
    body: { id: "prj_secret", name: "秘匿案件", accessScope: "restricted" }
  });
  assert.equal(createProject.status, 201);

  const blockedCreate = await request("/drawings", {
    method: "POST",
    role: "drafter",
    actorId: "outsider@example.com",
    idempotencyKey: "dwg-blocked-1",
    body: { name: "無許可作成", projectId: "prj_secret" }
  });
  assert.equal(blockedCreate.status, 404, "non-member must not learn the project exists via a different status code");

  const addMember = await request("/projects/prj_secret/members", {
    method: "POST",
    role: "cad_admin",
    idempotencyKey: "member-add-1",
    body: { member: "member@example.com" }
  });
  assert.equal(addMember.status, 201);

  const allowedCreate = await request("/drawings", {
    method: "POST",
    role: "drafter",
    actorId: "member@example.com",
    idempotencyKey: "dwg-allowed-1",
    body: { name: "許可済み作成", projectId: "prj_secret" }
  });
  assert.equal(allowedCreate.status, 201);
  const drawing = (await allowedCreate.json()).drawing;

  const memberRead = await request(`/drawings/${drawing.id}`, { role: "drafter", actorId: "member@example.com" });
  assert.equal(memberRead.status, 200);

  const outsiderRead = await request(`/drawings/${drawing.id}`, { role: "drafter", actorId: "outsider@example.com" });
  assert.equal(outsiderRead.status, 404, "outsider must get the same not-found response as a nonexistent drawing");

  const adminRead = await request(`/drawings/${drawing.id}`, { role: "cad_admin", actorId: "admin@example.com" });
  assert.equal(adminRead.status, 200, "cad_admin always bypasses project membership");

  const outsiderTransaction = await request(`/drawings/${drawing.id}/transactions`, {
    method: "POST",
    role: "drafter",
    actorId: "outsider@example.com",
    idempotencyKey: "tx-blocked-1",
    expectedVersion: drawing.revision,
    body: { commands: [] }
  });
  assert.equal(outsiderTransaction.status, 404, "mutating routes must enforce the same project access check as reads");
});

test("removing membership revokes access and PATCH toggles accessScope", async () => {
  resetMemoryStore();
  await request("/projects", {
    method: "POST",
    role: "cad_admin",
    idempotencyKey: "proj-toggle-1",
    body: { id: "prj_toggle", name: "切替案件", accessScope: "restricted" }
  });
  await request("/projects/prj_toggle/members", {
    method: "POST",
    role: "cad_admin",
    idempotencyKey: "member-toggle-1",
    body: { member: "temp@example.com" }
  });
  const created = await request("/drawings", {
    method: "POST",
    role: "drafter",
    actorId: "temp@example.com",
    idempotencyKey: "dwg-toggle-1",
    body: { name: "一時メンバー図面", projectId: "prj_toggle" }
  });
  assert.equal(created.status, 201);
  const drawingId = (await created.json()).drawing.id;

  const removed = await request("/projects/prj_toggle/members/temp%40example.com", {
    method: "DELETE",
    role: "cad_admin"
  });
  assert.equal(removed.status, 200);

  const afterRemoval = await request(`/drawings/${drawingId}`, { role: "drafter", actorId: "temp@example.com" });
  assert.equal(afterRemoval.status, 404, "revoked member must lose read access immediately");

  const openAgain = await request("/projects/prj_toggle", {
    method: "PATCH",
    role: "cad_admin",
    idempotencyKey: "patch-open-1",
    body: { accessScope: "open" }
  });
  assert.equal(openAgain.status, 200);

  const afterOpen = await request(`/drawings/${drawingId}`, { role: "drafter", actorId: "temp@example.com" });
  assert.equal(afterOpen.status, 200, "switching the project back to open restores access for every authenticated role");
});

test("GET /projects/:id requires cad_admin and returns members", async () => {
  resetMemoryStore();
  await request("/projects", {
    method: "POST",
    role: "cad_admin",
    idempotencyKey: "proj-list-1",
    body: { id: "prj_list", name: "一覧確認", accessScope: "restricted" }
  });
  await request("/projects/prj_list/members", {
    method: "POST",
    role: "cad_admin",
    idempotencyKey: "member-list-1",
    body: { member: "a@example.com" }
  });

  const forbidden = await request("/projects/prj_list", { role: "reviewer" });
  assert.equal(forbidden.status, 403);

  const ok = await request("/projects/prj_list", { role: "cad_admin" });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.deepEqual(body.members, ["a@example.com"]);
});

test("creating a drawing against an unknown project is rejected", async () => {
  resetMemoryStore();
  const response = await request("/drawings", {
    method: "POST",
    role: "cad_admin",
    idempotencyKey: "dwg-unknown-project-1",
    body: { name: "存在しない案件", projectId: "prj_does_not_exist" }
  });
  assert.equal(response.status, 404);
});

test("a non-member cannot learn whether an agent run on a restricted drawing was applied", async () => {
  resetMemoryStore();
  assert.equal((await request("/projects", {
    method: "POST",
    role: "cad_admin",
    idempotencyKey: "proj-agent-1",
    body: { id: "prj_agent", name: "秘匿案件", accessScope: "restricted" }
  })).status, 201);
  const created = await request("/drawings", {
    method: "POST",
    role: "cad_admin",
    idempotencyKey: "dwg-agent-1",
    body: { name: "秘匿図面", projectId: "prj_agent", template: "demo" }
  });
  assert.equal(created.status, 201);
  const drawing = (await created.json()).drawing;
  const plan = await request(`/drawings/${drawing.id}/agent-runs`, {
    method: "POST",
    role: "cad_admin",
    body: { prompt: "クレーンの重機範囲を追加" }
  });
  assert.equal(plan.status, 201);
  const run = (await plan.json()).run;
  const approve = (role, actorId, key, version) =>
    request(`/agent-runs/${run.id}/approve`, { method: "POST", role, actorId, idempotencyKey: key, expectedVersion: version, body: {} });
  const applied = await approve("cad_admin", "admin@example.com", "agent-apply-1", drawing.revision);
  assert.equal(applied.status, 200);

  // 適用済みでも未適用でも、権限のない利用者には同じ404を返す。
  const outsider = await approve("drafter", "outsider@example.com", "agent-apply-2", (await applied.json()).drawing.revision);
  assert.equal(outsider.status, 404);
});
