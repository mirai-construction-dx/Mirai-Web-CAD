import test from "node:test";
import assert from "node:assert/strict";
import { createDataStore, closeDataStorePool } from "../src/data-store.js";
import { createDrawing } from "../src/cad-core.js";
import { nativeBlockDrawing } from "./fixtures/native-block.js";
import { createDxfSourceDocument } from "../src/dxf-source-document.js";
import { exportDxf } from "../src/dxf-export.js";

// 本番用DATABASE_URLを設定したシェルでうっかりnpm testを実行しても本番DBへ
// 書き込まないよう、専用の環境変数TEST_DATABASE_URLのみを見る(DATABASE_URLは
// 意図的に無視する)。加えて、接続先のDB名が"test"を含むことを要求し、命名を
// 誤った検証用DBへの書き込みも防ぐ。いずれかを満たさない場合はこのファイル
// 全体をskipする(通常のnpm test実行では未設定なので常にskipされる)。
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const databaseNameLooksLikeTest = isTestDatabaseUrl(testDatabaseUrl);
const skipReason = !testDatabaseUrl
  ? "TEST_DATABASE_URLが未設定のためskip"
  : !databaseNameLooksLikeTest
    ? 'TEST_DATABASE_URLのDB名に"test"が含まれないためskip(本番DBへの誤書き込み防止)'
    : false;

test("PostgreSQL統合テスト", { skip: skipReason }, async (t) => {
  const store = createDataStore({ DATABASE_URL: testDatabaseUrl });

  await t.test("probeが接続済み・migration適用済みを返す", async () => {
    const probe = await store.probe();
    assert.equal(probe.provider, "postgres");
    assert.equal(probe.mode, "connected");
    assert.equal(probe.migrated, true);
  });

  await t.test("createDrawingAtomicallyが成功し、同一Idempotency-Keyの再送は23505経由でfalseになる", async () => {
    const drawing = nativeBlockDrawing();
    drawing.dxfSources = [createDxfSourceDocument(exportDxf(drawing).content)];
    drawing.id = `dwg_it_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    drawing.currentRole = "drafter";
    const auditEntry = {
      id: `audit_it_${Date.now()}`,
      actorId: "it@test",
      role: "drafter",
      action: "drawing.created",
      targetType: "drawing",
      targetId: drawing.id,
      detail: { name: drawing.name },
      createdAt: new Date().toISOString()
    };
    const idempotencyKey = `idem_it_create_${Date.now()}`;

    const created = await store.createDrawingAtomically(drawing, auditEntry, idempotencyKey, "it@test", "/api/drawings");
    assert.equal(created, true);

    const reloaded = await store.getDrawing(drawing.id, false);
    assert.deepEqual(reloaded.entities, drawing.entities, "JSONBから図面配列をそのまま復元する");
    assert.deepEqual(reloaded.layers, drawing.layers, "JSONBからレイヤー配列をそのまま復元する");
    assert.deepEqual(reloaded.blockDefinitions, drawing.blockDefinitions);
    assert.deepEqual(reloaded.dxfSources, drawing.dxfSources);

    const duplicate = await store.createDrawingAtomically(drawing, auditEntry, idempotencyKey, "it@test", "/api/drawings");
    assert.equal(duplicate, false, "同一Idempotency-Keyの再送はfalseを返す(トランザクション書き換え後も冪等性を維持)");
  });

  await t.test("getDrawingのpublicOnly boolean引数が正しく型付けされる", async () => {
    const drawing = createDrawing();
    drawing.id = `dwg_it_pub_${Date.now()}`;
    drawing.currentRole = "drafter";
    const auditEntry = {
      id: `audit_it_pub_${Date.now()}`,
      actorId: "it@test",
      role: "drafter",
      action: "drawing.created",
      targetType: "drawing",
      targetId: drawing.id,
      detail: {},
      createdAt: new Date().toISOString()
    };
    await store.createDrawingAtomically(drawing, auditEntry, `idem_it_pub_${Date.now()}`, "it@test", "/api/drawings");

    const privateVisible = await store.getDrawing(drawing.id, false);
    assert.ok(privateVisible, "publicOnly=falseでは非公開図面も取得できる");

    const publicOnlyHidden = await store.getDrawing(drawing.id, true);
    assert.equal(publicOnlyHidden, null, "publicOnly=trueでは非公開図面(visibility=private既定)は取得できない");
  });

  await t.test("saveDrawingAtomicallyがcommandEvent=nullのケース(裸booleanのWHERE句)を処理できる", async () => {
    const drawing = createDrawing();
    drawing.id = `dwg_it_save_${Date.now()}`;
    drawing.currentRole = "drafter";
    const createAudit = {
      id: `audit_it_save_c_${Date.now()}`,
      actorId: "it@test",
      role: "drafter",
      action: "drawing.created",
      targetType: "drawing",
      targetId: drawing.id,
      detail: {},
      createdAt: new Date().toISOString()
    };
    await store.createDrawingAtomically(drawing, createAudit, `idem_it_save_c_${Date.now()}`, "it@test", "/api/drawings");
    const current = await store.getDrawing(drawing.id, false);

    const next = { ...current, revision: (current.revision ?? 1) + 1, name: "統合テスト更新" };
    const updateAudit = {
      id: `audit_it_save_u_${Date.now()}`,
      actorId: "it@test",
      role: "approver",
      action: "review.submitted",
      targetType: "drawing",
      targetId: drawing.id,
      detail: {},
      createdAt: new Date().toISOString()
    };
    const saved = await store.saveDrawingAtomically(next, updateAudit, `idem_it_save_u_${Date.now()}`, "it@test", "/api/drawings/x/review");
    assert.equal(saved, true);

    const reloaded = await store.getDrawing(drawing.id, false);
    assert.equal(reloaded.name, "統合テスト更新");
    assert.equal(reloaded.revision, next.revision);
  });

  await t.test("saveDrawingAtomicallyがrevision競合を409相当で検出する", async () => {
    const drawing = createDrawing();
    drawing.id = `dwg_it_conflict_${Date.now()}`;
    drawing.currentRole = "drafter";
    const createAudit = {
      id: `audit_it_conflict_c_${Date.now()}`,
      actorId: "it@test",
      role: "drafter",
      action: "drawing.created",
      targetType: "drawing",
      targetId: drawing.id,
      detail: {},
      createdAt: new Date().toISOString()
    };
    await store.createDrawingAtomically(drawing, createAudit, `idem_it_conflict_c_${Date.now()}`, "it@test", "/api/drawings");

    const staleNext = { ...drawing, revision: 999, name: "古いrevisionからの更新" };
    const updateAudit = {
      id: `audit_it_conflict_u_${Date.now()}`,
      actorId: "it@test",
      role: "drafter",
      action: "drawing.transaction",
      targetType: "drawing",
      targetId: drawing.id,
      detail: {},
      createdAt: new Date().toISOString()
    };
    await assert.rejects(
      () => store.saveDrawingAtomically(staleNext, updateAudit, `idem_it_conflict_u_${Date.now()}`, "it@test", "/api/drawings/x/transactions"),
      (error) => {
        assert.equal(error.status, 409);
        return true;
      }
    );
  });

  await t.test("適用済みのAI提案は、別のIdempotency-Keyと最新revisionでも再適用できない(M-2)", async () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const drawing = createDrawing();
    drawing.id = `dwg_it_agent_${suffix}`;
    drawing.currentRole = "drafter";
    const audit = (id, action) => ({
      id: `audit_it_agent_${id}_${suffix}`,
      actorId: "it@test",
      role: "drafter",
      action,
      targetType: "drawing",
      targetId: drawing.id,
      detail: {},
      createdAt: new Date().toISOString()
    });
    await store.createDrawingAtomically(drawing, audit("c", "drawing.created"), `idem_it_agent_c_${suffix}`, "it@test", "/api/drawings");
    const run = {
      id: `run_it_${suffix}`,
      drawingId: drawing.id,
      status: "planned",
      prompt: "統合テスト",
      proposal: { status: "planned", commands: [] },
      createdBy: "it@test",
      createdAt: new Date().toISOString()
    };
    await store.saveAgentRun(run);

    const current = await store.getDrawing(drawing.id, false);
    const first = { ...current, revision: current.revision + 1 };
    assert.equal(
      await store.saveDrawingAtomically(first, audit("a1", "agent.approved"), `idem_it_agent_a1_${suffix}`, "it@test", "/api/agent-runs/x/approve", { ...run, status: "completed" }),
      true
    );
    assert.equal((await store.getAgentRun(run.id)).status, "completed");

    const second = { ...first, revision: first.revision + 1 };
    await assert.rejects(
      () => store.saveDrawingAtomically(second, audit("a2", "agent.approved"), `idem_it_agent_a2_${suffix}`, "it@test", "/api/agent-runs/x/approve", { ...run, status: "completed" }),
      (error) => {
        assert.equal(error.status, 409);
        assert.match(error.message, /適用済み/);
        return true;
      }
    );
    assert.equal((await store.getDrawing(drawing.id, false)).revision, first.revision);
  });

  await t.test("appendAudit・listAuditLogs・countAuditLogsが一貫して動作する", async () => {
    const before = await store.countAuditLogs();
    await store.appendAudit({
      id: `audit_it_append_${Date.now()}`,
      actorId: "it@test",
      role: "viewer",
      action: "audit.exported",
      targetType: "audit_logs",
      targetId: "bulk",
      detail: { count: 1 },
      createdAt: new Date().toISOString()
    });
    const after = await store.countAuditLogs();
    assert.equal(after, before + 1);

    const logs = await store.listAuditLogs(5, 0);
    assert.ok(Array.isArray(logs));
    assert.ok(logs.length > 0);
    assert.equal(logs[0].role, "viewer");
    assert.equal(logs[0].detail.count, 1);
  });

  await t.test("案件アクセス制御(project_members)がPostgreSQL上で一貫して動作する", async () => {
    const projectId = `prj_it_${Date.now()}`;
    const created = await store.createProject({ id: projectId, name: "統合テスト案件", owner: "it@test", accessScope: "restricted" });
    assert.equal(created.accessScope, "restricted");

    const duplicate = await store.createProject({ id: projectId, name: "重複", owner: "it@test", accessScope: "open" });
    assert.equal(duplicate, null, "同一IDの案件は再作成できない");

    const fetched = await store.getProject(projectId);
    assert.equal(fetched.accessScope, "restricted");

    const member = `member-${Date.now()}@example.com`;
    assert.equal(await store.isProjectMember(projectId, member), false);
    await store.addProjectMember(projectId, member, "it@test");
    assert.equal(await store.isProjectMember(projectId, member.toUpperCase()), true, "member判定は大文字小文字を無視する");
    assert.deepEqual(await store.listProjectMembers(projectId), [member.toLowerCase()]);

    await store.removeProjectMember(projectId, member);
    assert.equal(await store.isProjectMember(projectId, member), false);

    const reopened = await store.updateProjectAccessScope(projectId, "open");
    assert.equal(reopened.accessScope, "open");

    const drawing = createDrawing();
    drawing.id = `dwg_it_project_${Date.now()}`;
    drawing.currentRole = "drafter";
    const auditEntry = {
      id: `audit_it_project_${Date.now()}`,
      actorId: "it@test",
      role: "drafter",
      action: "drawing.created",
      targetType: "drawing",
      targetId: drawing.id,
      detail: {},
      createdAt: new Date().toISOString()
    };
    await store.createDrawingAtomically(drawing, auditEntry, `idem_it_project_${Date.now()}`, "it@test", "/api/drawings", projectId);
    assert.equal(await store.getDrawingProjectId(drawing.id), projectId);
    assert.equal(await store.getDrawingProjectId("dwg_does_not_exist"), null);
  });

  await t.test("保存済みcontentが解釈できない場合はデモ図面で代替せず明示的に失敗する", async () => {
    // 以前はseedDrawing()へ差し替えて「デモ図面」を返していた。その挙動は利用者に誤った
    // 図面を見せ、そのまま保存させると同一版を上書きして実データを失う(改善台帳P0-76)。
    const store = createDataStore({ DATABASE_URL: testDatabaseUrl });
    const drawingId = `dwg_corrupt_${Date.now()}`;
    const projectId = "prj_demo_road_001";
    await store.createProject({ id: projectId, name: "道路拡幅デモ案件", owner: "mirai-demo", accessScope: "open" });
    const drawing = createDrawing({ id: drawingId, name: "破損検証" });
    drawing.currentRole = "drafter";
    await store.createDrawingAtomically(drawing, {
      id: `audit_corrupt_${Date.now()}`, actorId: "it@test", role: "drafter", action: "drawing.created",
      targetType: "drawing", targetId: drawingId, detail: {}, createdAt: new Date().toISOString()
    }, `idem_corrupt_${Date.now()}`, "it@test", "/api/drawings", projectId);

    // layersを配列でない値へ差し替え、CAD図面として解釈できない状態を作る。
    await store.sql`update drawing_versions set content = ${store.sql.json({ broken: true })} where drawing_id = ${drawingId}`;
    await assert.rejects(() => store.getDrawing(drawingId), /解釈できません/);
  });

  t.after(async () => {
    await closeDataStorePool();
  });
});

function isTestDatabaseUrl(connectionString) {
  if (!connectionString) return false;
  try {
    const url = new URL(connectionString);
    const databaseName = url.pathname.replace(/^\//, "");
    return databaseName.toLowerCase().includes("test");
  } catch {
    return false;
  }
}
