import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// AI提案フロー・監査証跡・機密区分/PII masking に限定した品質テスト(合成fixtureのみ)。
// 対象外(最終判断の緩和検証等)は含めない。外部LLM(OpenAI/Anthropic)・DB・deployへは接続しない。
// ルールベース/normalize/CSV/redact の純粋な単体検証のみ行う。
import {
  MAX_LLM_COMMANDS,
  MAX_PROMPT_CHARS,
  buildSystemPrompt,
  buildUserMessage,
  normalizeLlmProposal
} from "../src/ai-proposal.js";
import { seedDrawing } from "../src/cad-core.js";
import { csvEscape, handleApiRequest, redactPublicDrawing, resetMemoryStore } from "../src/api-handler.js";
import { createDataStore } from "../src/data-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const env = { AUTH_MODE: "demo", APP_ENV: "preview" };

function apiRequest(pathname, { method = "GET", role = "drafter", actorId, idempotencyKey, expectedVersion, body, contentType } = {}) {
  const headers = { "x-demo-role": role };
  if (actorId) headers["x-demo-actor"] = actorId;
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  if (expectedVersion !== undefined) headers["expected-version"] = String(expectedVersion);
  if (body !== undefined) headers["content-type"] = contentType ?? "application/json";
  return handleApiRequest(
    new Request(`https://example.test/api${pathname}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }),
    env
  );
}

// ---------------------------------------------------------------------------
// 1. 機密区分・PII masking
// ---------------------------------------------------------------------------

test("buildSystemPrompt はレイヤー名・図形IDに埋め込んだメール/個人識別子を <drawing_context> に漏らさない", () => {
  const drawing = seedDrawing();
  drawing.layers[0].name = "担当者 taro@example.com / 内線1234";
  drawing.entities[0].id = "e_mail_hanako@example.com";
  const prompt = buildSystemPrompt(drawing);
  assert.doesNotMatch(prompt, /taro@example\.com/, "レイヤー名のメールがプロンプトに漏れる");
  assert.doesNotMatch(prompt, /hanako@example\.com/, "図形IDのメールがプロンプトに漏れる");
  assert.doesNotMatch(prompt, /内線\d+/, "個人識別子(内線番号)がプロンプトに漏れる");
});

test("buildSystemPrompt は任意文字列を保持するテキスト図形の値を図形要約に含めない", () => {
  const drawing = seedDrawing();
  drawing.entities.push({
    id: "e_note_pii",
    type: "text",
    layerId: "layer-annotation",
    at: { x: 100, y: 100 },
    value: "現場担当 hanako@example.com / 内線9999",
    size: 180
  });
  const prompt = buildSystemPrompt(drawing);
  assert.doesNotMatch(prompt, /hanako@example\.com/, "テキスト図形の値が要約に漏れる");
  assert.doesNotMatch(prompt, /内線9999/);
  assert.doesNotMatch(prompt, /e_note_pii/, "テキスト図形は図形要約から除外される");
});

test("buildUserMessage は prompt を MAX_PROMPT_CHARS に切り詰める", () => {
  const long = "x".repeat(MAX_PROMPT_CHARS + 1000);
  const message = buildUserMessage(long);
  assert.ok(message.startsWith("<user_request>"));
  assert.ok(message.endsWith("</user_request>"));
  assert.equal(
    message.length,
    MAX_PROMPT_CHARS + "<user_request>".length + "</user_request>".length,
    "切り詰め後の本文が MAX_PROMPT_CHARS を超えている"
  );
  const inner = message.slice("<user_request>".length, -"</user_request>".length);
  assert.equal(inner.length, MAX_PROMPT_CHARS);
});

test("redactPublicDrawing は公開応答からメールを伏せ、操作者を 'user' へ置換し、system/agent は保持する", () => {
  const value = {
    name: "道路拡幅",
    comments: [{ author: "site.engineer@company.example", body: "連絡先 taro@example.com / 太郎@例子.公司" }],
    entities: [{ id: "e_1", type: "line", createdBy: "site.engineer@company.example" }],
    auditLog: [
      { actor: "system", action: "drawing.seeded" },
      { actor: "agent", action: "drawing.transaction" },
      { actor: "cad_admin", action: "review.approved" },
      { actor: "site.engineer@company.example", action: "drawing.transaction" }
    ]
  };
  const redacted = redactPublicDrawing(value);
  assert.equal(JSON.stringify(redacted).includes("company.example"), false, "メールが残っている");
  assert.equal(redacted.comments[0].author, "user");
  assert.equal(redacted.comments[0].body, "連絡先 [メールアドレス省略] / [メールアドレス省略]");
  assert.equal(redacted.entities[0].createdBy, "user");
  assert.equal(redacted.auditLog[0].actor, "system");
  assert.equal(redacted.auditLog[1].actor, "agent");
  assert.equal(redacted.auditLog[2].actor, "cad_admin");
  assert.equal(redacted.auditLog[3].actor, "user");
});

// ---------------------------------------------------------------------------
// 2. AI入力境界 (normalizeLlmProposal)
// ---------------------------------------------------------------------------

test("normalizeLlmProposal は用紙外座標の追加を除外して警告する", () => {
  const drawing = seedDrawing();
  const proposal = normalizeLlmProposal(drawing, {
    status: "planned",
    commands: [
      { op: "add", entityType: "circle", layerId: "layer-temporary", center: { x: 50000, y: 0 }, radius: 10 },
      { op: "add", entityType: "line", layerId: "layer-temporary", start: { x: -5, y: 0 }, end: { x: 100, y: 100 } }
    ]
  });
  assert.equal(proposal.status, "needs_input");
  assert.match(proposal.warnings.join(" "), /用紙範囲外/);
});

test("normalizeLlmProposal はロック中レイヤーへの追加を除外して警告する", () => {
  const drawing = seedDrawing();
  drawing.layers.find((layer) => layer.id === "layer-structure").locked = true;
  const proposal = normalizeLlmProposal(drawing, {
    status: "planned",
    commands: [{ op: "add", entityType: "circle", layerId: "layer-structure", center: { x: 100, y: 100 }, radius: 10 }]
  });
  assert.equal(proposal.status, "needs_input");
  assert.match(proposal.warnings.join(" "), /ロック中レイヤー/);
});

test("normalizeLlmProposal は不正な op を除外して警告する", () => {
  const drawing = seedDrawing();
  const proposal = normalizeLlmProposal(drawing, {
    status: "planned",
    commands: [{ op: "delete_layer", id: "layer-structure" }]
  });
  assert.equal(proposal.status, "needs_input");
  assert.match(proposal.warnings.join(" "), /不正または未対応の操作/);
});

test("normalizeLlmProposal は MAX_LLM_COMMANDS を超える命令を先頭のみ処理し警告する", () => {
  const drawing = seedDrawing();
  const commands = Array.from({ length: MAX_LLM_COMMANDS + 5 }, () => ({
    op: "add",
    entityType: "circle",
    layerId: "layer-temporary",
    center: { x: 100, y: 100 },
    radius: 10
  }));
  const proposal = normalizeLlmProposal(drawing, { status: "planned", commands });
  assert.equal(proposal.commands.length, MAX_LLM_COMMANDS);
  assert.match(proposal.warnings.join(" "), new RegExp(`${MAX_LLM_COMMANDS}件を超えた`));
});

test("normalizeLlmProposal はテキスト値の制御文字を除去する", () => {
  const drawing = seedDrawing();
  const proposal = normalizeLlmProposal(drawing, {
    status: "planned",
    commands: [
      { op: "add", entityType: "text", layerId: "layer-annotation", at: { x: 500, y: 500 }, value: "安全\u0000確認\u0007済み\n改行", size: 200 }
    ]
  });
  assert.equal(proposal.status, "planned");
  const entity = proposal.commands[0].entity;
  assert.equal(entity.value, "安全確認済み改行");
  assert.equal(/[\u0000-\u001f\u007f-\u009f]/.test(entity.value), false, "制御文字が残っている");
});

test("normalizeLlmProposal は LLM 由来の id/style を引き継がずサーバー側で再生成する", () => {
  const drawing = seedDrawing();
  const proposal = normalizeLlmProposal(drawing, {
    status: "planned",
    commands: [
      {
        op: "add",
        entityType: "line",
        layerId: "layer-temporary",
        start: { x: 0, y: 0 },
        end: { x: 100, y: 100 },
        id: "e_frame_1",
        style: { strokeWidth: 999, fill: "red", lineDash: [1, 1] },
        meta: { createdBy: "attacker@example.com" }
      }
    ]
  });
  const entity = proposal.commands[0].entity;
  assert.notEqual(entity.id, "e_frame_1", "LLM由来のIDを引き継いでいる");
  assert.equal(entity.style.strokeWidth, 2, "LLM由来のstyle.strokeWidthを引き継いでいる");
  assert.equal(entity.style.fill, "transparent");
  assert.deepEqual(entity.style.lineDash, []);
  assert.equal(entity.meta.createdBy, "agent", "createdBy はサーバー側で 'agent' に固定される");
});

// ---------------------------------------------------------------------------
// 3. 監査証跡
// ---------------------------------------------------------------------------

test("監査ログは追記専用で、重複IDは黙って落とさず例外にする", async () => {
  resetMemoryStore();
  const store = createDataStore({});
  const entry = {
    id: "audit_quality_dup_probe",
    actorId: "tester@example.com",
    role: "drafter",
    action: "test.probe",
    targetType: "test",
    targetId: "x",
    detail: {},
    createdAt: new Date().toISOString()
  };
  await store.appendAudit(entry);
  await assert.rejects(() => store.appendAudit(entry), /監査ログを記録できませんでした/);
  const logs = await store.listAuditLogs(100, 0);
  assert.equal(logs.filter((item) => item.id === "audit_quality_dup_probe").length, 1);
});

test("csvEscape は数式注入(=,+,-,@,先頭空白)を無害化し、引用符・区切り・改行をエスケープする", () => {
  assert.equal(csvEscape("=cmd|calc"), "'=cmd|calc");
  assert.equal(csvEscape("+1+1"), "'+1+1");
  assert.equal(csvEscape("-2+3"), "'-2+3");
  assert.equal(csvEscape("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(csvEscape("  =1+1"), "'  =1+1", "先頭空白を読み飛ばした数式判定が抜けている");
  assert.equal(csvEscape("\t-1+1"), "'\t-1+1");
  assert.equal(csvEscape(" =CMD()"), "' =CMD()");
  assert.equal(csvEscape("a,b"), '"a,b"');
  assert.equal(csvEscape('say "hi"'), '"say ""hi"""');
  assert.equal(csvEscape("line1\nline2"), '"line1\nline2"');
  assert.equal(csvEscape("plain"), "plain");
});

test("AI提案の人間確認経路は agent.planned / agent.approved を監査に残し、prompt本文を監査へ漏らさない", async () => {
  resetMemoryStore();
  const secret = "連絡先 taro@example.com";
  const planResponse = await apiRequest("/drawings/dwg_demo_001/agent-runs", {
    method: "POST",
    role: "drafter",
    idempotencyKey: "q-plan",
    body: { prompt: `クレーンの重機範囲を追加（${secret}）` }
  });
  assert.equal(planResponse.status, 201, await planResponse.clone().text());
  const plan = await planResponse.json();
  assert.equal(plan.run.status, "planned");

  const approveResponse = await apiRequest(`/agent-runs/${plan.run.id}/approve`, {
    method: "POST",
    role: "drafter",
    idempotencyKey: "q-approve",
    expectedVersion: 1,
    body: {}
  });
  assert.equal(approveResponse.status, 200, await approveResponse.clone().text());

  const auditResponse = await apiRequest("/audit-logs", { role: "approver" });
  const { auditLogs } = await auditResponse.json();

  const planned = auditLogs.find((entry) => entry.action === "agent.planned" && entry.targetId === plan.run.id);
  assert.ok(planned, "agent.planned が監査に残っていない");
  assert.equal(planned.detail.engine, "rule");
  assert.equal(JSON.stringify(planned.detail).includes(secret), false, "prompt本文が監査 detail に漏れている");

  const approved = auditLogs.find((entry) => entry.action === "agent.approved" && entry.detail?.runId === plan.run.id);
  assert.ok(approved, "agent.approved が監査に残っていない");
});

// ---------------------------------------------------------------------------
// 4. 人間確認の境界
// ---------------------------------------------------------------------------

test("プレビュー(agent-runs)は図面を変更せず、approve エンドポイント経由のみ適用する", async () => {
  resetMemoryStore();
  const before = await (await apiRequest("/drawings/dwg_demo_001")).json();

  const planResponse = await apiRequest("/drawings/dwg_demo_001/agent-runs", {
    method: "POST",
    role: "drafter",
    idempotencyKey: "q-boundary-plan",
    body: { prompt: "クレーンの重機範囲を追加" }
  });
  const plan = await planResponse.json();
  assert.equal(planResponse.status, 201);
  assert.equal(plan.run.status, "planned");

  const afterPreview = await (await apiRequest("/drawings/dwg_demo_001")).json();
  assert.equal(afterPreview.drawing.revision, before.drawing.revision, "プレビューで revision が進んでいる");
  assert.equal(afterPreview.drawing.entities.length, before.drawing.entities.length, "プレビューで図形が追加されている");

  const approveResponse = await apiRequest(`/agent-runs/${plan.run.id}/approve`, {
    method: "POST",
    role: "drafter",
    idempotencyKey: "q-boundary-approve",
    expectedVersion: before.drawing.revision,
    body: {}
  });
  assert.equal(approveResponse.status, 200, await approveResponse.clone().text());
  const applied = await approveResponse.json();
  assert.equal(applied.drawing.revision, before.drawing.revision + 1);
  assert.ok(applied.drawing.entities.length > before.drawing.entities.length, "approve で図形が適用されていない");
});

test("提案をトランザクション化して適用する経路は approve エンドポイントの1箇所のみ", async () => {
  const source = await readFile(path.join(repoRoot, "src", "api-handler.js"), "utf8");
  const callSites = source.match(/proposalToTransaction\(/g) ?? [];
  assert.equal(callSites.length, 1, "提案を直接適用する経路が複数存在する(または消失している)");
  // 唯一の呼び出しが approve ハンドラ内であること(プレビュー経路で直接適用しない)。
  const agentRoute = source.slice(source.indexOf("/drawings/"), source.indexOf("const approveAgentMatch"));
  assert.equal(/proposalToTransaction\(/.test(agentRoute), false, "agent-runs(プレビュー)経路で提案を直接適用している");
});
