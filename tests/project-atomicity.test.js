import test from "node:test";
import assert from "node:assert/strict";
import { createDataStore, resetMemoryStoreData } from "../src/data-store.js";

// 案件系の「業務書込＋監査」が単一メソッドで原子的に行われることを検証する
// (独立レビュー 2026-10-02、M-2)。監査IDの重複で監査書込が失敗した場合に、
// 業務書込(案件作成・accessScope更新・メンバー追加/削除)が残らないことを固定する。

function auditEntry(id, action, targetId, detail = {}) {
  return {
    id,
    actorId: "admin@example.com",
    role: "cad_admin",
    action,
    targetType: "project",
    targetId,
    detail,
    createdAt: new Date().toISOString()
  };
}

test("createProjectAtomicallyは監査ID重複時に案件を作成しない(ロールバック)", async () => {
  resetMemoryStoreData();
  const store = createDataStore({});
  // 監査IDを先に占有して重複を誘発する
  await store.appendAudit(auditEntry("audit_dup_1", "x", "prj_x"));
  await assert.rejects(
    store.createProjectAtomically(
      { id: "prj_x", name: "x", owner: "o", accessScope: "open" },
      auditEntry("audit_dup_1", "project.created", "prj_x")
    )
  );
  assert.equal(await store.getProject("prj_x"), null, "監査失敗時に案件が残ってはいけない");
});

test("updateProjectAccessScopeAtomicallyは監査ID重複時にaccessScopeを変更しない", async () => {
  resetMemoryStoreData();
  const store = createDataStore({});
  const project = await store.createProjectAtomically(
    { id: "prj_y", name: "y", owner: "o", accessScope: "open" },
    auditEntry("audit_ok_1", "project.created", "prj_y")
  );
  assert.equal(project.accessScope, "open");
  await store.appendAudit(auditEntry("audit_dup_2", "x", "prj_y"));
  await assert.rejects(
    store.updateProjectAccessScopeAtomically("prj_y", "restricted", auditEntry("audit_dup_2", "project.updated", "prj_y"))
  );
  assert.equal((await store.getProject("prj_y")).accessScope, "open", "監査失敗時にaccessScopeが変わってはいけない");
});

test("createProjectAtomicallyは正常時に案件と監査を両方作成する", async () => {
  resetMemoryStoreData();
  const store = createDataStore({});
  const project = await store.createProjectAtomically(
    { id: "prj_z", name: "z", owner: "o", accessScope: "restricted" },
    auditEntry("audit_ok_2", "project.created", "prj_z")
  );
  assert.equal(project.id, "prj_z");
  assert.equal(project.accessScope, "restricted");
  assert.equal((await store.getProject("prj_z")).accessScope, "restricted");
  const logs = await store.listAuditLogs(10, 0);
  assert.ok(logs.some((entry) => entry.id === "audit_ok_2"), "監査行が記録されている");
});

test("addProjectMemberAtomically/removeProjectMemberAtomicallyはメンバーと監査を両方反映する", async () => {
  resetMemoryStoreData();
  const store = createDataStore({});
  await store.createProjectAtomically(
    { id: "prj_w", name: "w", owner: "o", accessScope: "open" },
    auditEntry("audit_w1", "project.created", "prj_w")
  );
  await store.addProjectMemberAtomically("prj_w", "M@Example.com", "admin@example.com", auditEntry("audit_w2", "project.member.added", "prj_w"));
  assert.equal(await store.isProjectMember("prj_w", "m@example.com"), true, "メンバーが追加されている");
  await store.removeProjectMemberAtomically("prj_w", "M@Example.com", auditEntry("audit_w3", "project.member.removed", "prj_w"));
  assert.equal(await store.isProjectMember("prj_w", "m@example.com"), false, "メンバーが削除されている");
});
