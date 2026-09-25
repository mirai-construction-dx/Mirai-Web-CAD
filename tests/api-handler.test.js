import test from "node:test";
import assert from "node:assert/strict";
import { handleApiRequest, resetMemoryStore } from "../src/api-handler.js";

const env = { AUTH_MODE: "demo", APP_ENV: "preview" };

test("health returns auth and database preview status", async () => {
  resetMemoryStore();
  const response = await handleApiRequest(new Request("https://example.test/api/health"), env);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.auth.mode, "demo");
  assert.equal(body.db.mode, "memory-preview");
});

test("OPTIONS preflight returns an empty 204 response", async () => {
  const response = await handleApiRequest(
    new Request("https://example.test/api/health", { method: "OPTIONS" }),
    env
  );
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
});

test("drawing creation supports blank and demo templates", async () => {
  resetMemoryStore();
  const create = (template, idempotencyKey = `create-${template}`) =>
    handleApiRequest(
      new Request("https://example.test/api/drawings", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-demo-role": "drafter",
          "idempotency-key": idempotencyKey
        },
        body: JSON.stringify({ name: `${template} drawing`, unit: "m", template })
      }),
      env
    );
  const blank = await (await create("blank")).json();
  const demo = await (await create("demo")).json();
  assert.equal(blank.drawing.entities.length, 0);
  assert.equal(blank.drawing.name, "blank drawing");
  assert.equal(blank.drawing.unit, "m");
  assert.ok(demo.drawing.entities.length > 0);

  const duplicate = await create("blank", "create-blank");
  assert.equal(duplicate.status, 409);

  const invalidBody = await handleApiRequest(
    new Request("https://example.test/api/drawings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-demo-role": "drafter",
        "idempotency-key": "create-invalid"
      },
      body: "null"
    }),
    env
  );
  assert.equal(invalidBody.status, 400);
});

test("production access mode permits only public health and demo drawing reads", async () => {
  resetMemoryStore();
  const productionEnv = {
    APP_ENV: "production",
    AUTH_MODE: "access"
  };
  const health = await handleApiRequest(new Request("https://example.test/api/health"), productionEnv);
  const healthBody = await health.json();
  assert.equal(health.status, 200);
  assert.equal(healthBody.auth.role, "viewer");
  assert.equal(healthBody.auth.anonymous, true);
  assert.equal("database" in healthBody.db, false);

  const demo = await handleApiRequest(new Request("https://example.test/api/drawings/demo"), productionEnv);
  assert.equal(demo.status, 200);

  const arbitrary = await handleApiRequest(new Request("https://example.test/api/drawings/dwg_private"), productionEnv);
  assert.equal(arbitrary.status, 401);

  const mutation = await handleApiRequest(
    new Request("https://example.test/api/drawings", { method: "POST", body: "{}" }),
    productionEnv
  );
  assert.equal(mutation.status, 401);
});

test("API applies production security and CORS headers", async () => {
  const response = await handleApiRequest(new Request("https://example.test/api/health"), {
    APP_ENV: "production",
    AUTH_MODE: "access"
  });
  assert.equal(response.headers.get("access-control-allow-origin"), "https://mirai-web-cad.mirai-dx-platform.com");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.match(response.headers.get("permissions-policy"), /camera=\(\)/);
  assert.equal(response.headers.get("vary"), "Origin");
});

test("CORS_ORIGIN supports a comma-separated allowlist and reflects only known origins", async () => {
  const multiOriginEnv = {
    APP_ENV: "production",
    AUTH_MODE: "access",
    CORS_ORIGIN: "https://mirai-web-cad.mirai-dx-platform.com,https://mirai-web-cad.pages.dev"
  };

  const allowed = await handleApiRequest(
    new Request("https://example.test/api/health", { headers: { origin: "https://mirai-web-cad.pages.dev" } }),
    multiOriginEnv
  );
  assert.equal(allowed.headers.get("access-control-allow-origin"), "https://mirai-web-cad.pages.dev");

  const unknown = await handleApiRequest(
    new Request("https://example.test/api/health", { headers: { origin: "https://evil.example" } }),
    multiOriginEnv
  );
  assert.equal(unknown.headers.get("access-control-allow-origin"), "https://mirai-web-cad.mirai-dx-platform.com");

  const noOriginHeader = await handleApiRequest(new Request("https://example.test/api/health"), multiOriginEnv);
  assert.equal(noOriginHeader.headers.get("access-control-allow-origin"), "https://mirai-web-cad.mirai-dx-platform.com");
});

test("mutating JSON endpoints reject unsupported media types and oversized bodies", async () => {
  resetMemoryStore();
  const unsupported = await handleApiRequest(
    new Request("https://example.test/api/drawings/dwg_demo_001/transactions", {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        "x-demo-role": "drafter",
        "idempotency-key": "media-type",
        "expected-version": "1"
      },
      body: "{}"
    }),
    env
  );
  assert.equal(unsupported.status, 415);

  const oversized = await handleApiRequest(
    new Request("https://example.test/api/drawings/dwg_demo_001/transactions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "1048577",
        "x-demo-role": "drafter",
        "idempotency-key": "oversized",
        "expected-version": "1"
      },
      body: "{}"
    }),
    env
  );
  assert.equal(oversized.status, 413);

  const chunkedBody = JSON.stringify({ value: "x".repeat(1_048_576) });
  const chunkedRequest = new Request("https://example.test/api/drawings/dwg_demo_001/transactions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-demo-role": "drafter",
        "idempotency-key": "chunked-oversized",
        "expected-version": "1"
      },
      body: chunkedBody
    });
  assert.equal(chunkedRequest.headers.has("content-length"), false);
  const chunked = await handleApiRequest(chunkedRequest, env);
  assert.equal(chunked.status, 413);
});

test("access mode ignores client role spoofing and uses server role mapping", async () => {
  resetMemoryStore();
  const response = await handleApiRequest(
    new Request("https://example.test/api/health", {
      headers: {
        "cf-access-jwt-assertion": "signed-test-token",
        "cf-access-authenticated-user-email": "attacker@example.com",
        "x-mirai-role": "cad_admin"
      }
    }),
    {
      APP_ENV: "production",
      AUTH_MODE: "access",
      ACCESS_ROLE_MAP: JSON.stringify({ "drafter@example.com": "drafter" }),
      ACCESS_JWT_VERIFIER: async (token) => {
        assert.equal(token, "signed-test-token");
        return { email: "drafter@example.com" };
      }
    }
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.auth.role, "drafter");
});

test("access mode resolves role from Entra ID group membership when ACCESS_ROLE_MAP has no match, choosing the highest-privilege matched group", async () => {
  resetMemoryStore();
  const response = await handleApiRequest(
    new Request("https://example.test/api/health", {
      headers: { "cf-access-jwt-assertion": "signed-test-token" }
    }),
    {
      APP_ENV: "production",
      AUTH_MODE: "access",
      ACCESS_ROLE_MAP: JSON.stringify({ "drafter@example.com": "drafter" }),
      ENTRA_GROUP_ROLE_MAP: JSON.stringify({ "group-reviewer": "reviewer", "group-approver": "approver" }),
      ACCESS_JWT_VERIFIER: async () => ({ email: "unmapped@example.com" }),
      ENTRA_GROUP_RESOLVER: async (email) => {
        assert.equal(email, "unmapped@example.com");
        return ["group-reviewer", "group-approver", "group-unknown"];
      }
    }
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.auth.role, "approver");
});

test("access mode prefers ACCESS_ROLE_MAP over Entra group resolution when both would match", async () => {
  resetMemoryStore();
  const response = await handleApiRequest(
    new Request("https://example.test/api/health", {
      headers: { "cf-access-jwt-assertion": "signed-test-token" }
    }),
    {
      APP_ENV: "production",
      AUTH_MODE: "access",
      ACCESS_ROLE_MAP: JSON.stringify({ "both@example.com": "reviewer" }),
      ENTRA_GROUP_ROLE_MAP: JSON.stringify({ "group-admin": "cad_admin" }),
      ACCESS_JWT_VERIFIER: async () => ({ email: "both@example.com" }),
      ENTRA_GROUP_RESOLVER: async () => {
        throw new Error("must not be called when ACCESS_ROLE_MAP already matched");
      }
    }
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.auth.role, "reviewer");
});

test("access mode falls back to ACCESS_DEFAULT_ROLE when Entra group resolution fails or has no mapped group", async () => {
  resetMemoryStore();
  const response = await handleApiRequest(
    new Request("https://example.test/api/health", {
      headers: { "cf-access-jwt-assertion": "signed-test-token" }
    }),
    {
      APP_ENV: "production",
      AUTH_MODE: "access",
      ACCESS_DEFAULT_ROLE: "viewer",
      ENTRA_GROUP_ROLE_MAP: JSON.stringify({ "group-approver": "approver" }),
      ACCESS_JWT_VERIFIER: async () => ({ email: "nogroup@example.com" }),
      ENTRA_GROUP_RESOLVER: async () => null
    }
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.auth.role, "viewer");
});

test("access mode fails closed when JWT verifier configuration is absent", async () => {
  resetMemoryStore();
  const response = await handleApiRequest(
    new Request("https://example.test/api/health", {
      headers: { "cf-access-jwt-assertion": "unverified-token" }
    }),
    { APP_ENV: "production", AUTH_MODE: "access" }
  );
  const body = await response.json();
  assert.equal(response.status, 401);
  assert.match(body.error, /JWT/);
});

test("viewer cannot create transactions", async () => {
  resetMemoryStore();
  const response = await handleApiRequest(
    new Request("https://example.test/api/drawings/dwg_demo_001/transactions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-demo-role": "viewer",
        "idempotency-key": "idem-viewer",
        "expected-version": "1"
      },
      body: JSON.stringify({ label: "viewer transaction", commands: [] })
    }),
    env
  );
  const body = await response.json();
  assert.equal(response.status, 403);
  assert.match(body.error, /権限/);
});

test("transaction requires idempotency and expected version gates", async () => {
  resetMemoryStore();
  const missingIdempotency = await handleApiRequest(
    new Request("https://example.test/api/drawings/dwg_demo_001/transactions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-demo-role": "drafter", "expected-version": "1" },
      body: JSON.stringify({ commands: [] })
    }),
    env
  );
  assert.equal(missingIdempotency.status, 428);

  const wrongVersion = await handleApiRequest(
    new Request("https://example.test/api/drawings/dwg_demo_001/transactions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-demo-role": "drafter",
        "idempotency-key": "idem-wrong",
        "expected-version": "99"
      },
      body: JSON.stringify({ commands: [] })
    }),
    env
  );
  assert.equal(wrongVersion.status, 409);
});

test("duplicate idempotency key cannot execute a transaction twice", async () => {
  resetMemoryStore();
  const request = () =>
    new Request("https://example.test/api/drawings/dwg_demo_001/transactions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-demo-role": "drafter",
        "idempotency-key": "idem-duplicate",
        "expected-version": "1"
      },
      body: JSON.stringify({ label: "duplicate guard", commands: [] })
    });
  const first = await handleApiRequest(request(), env);
  const second = await handleApiRequest(request(), env);
  assert.equal(first.status, 200);
  assert.equal(second.status, 409);
  assert.match((await second.json()).error, /処理済み/);
});

test("successful mutation commits drawing and audit as one logical operation", async () => {
  resetMemoryStore();
  const response = await handleApiRequest(
    new Request("https://example.test/api/drawings/dwg_demo_001/transactions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-demo-role": "drafter",
        "idempotency-key": "atomic-audit",
        "expected-version": "1"
      },
      body: JSON.stringify({ label: "atomic audit", commands: [] })
    }),
    env
  );
  assert.equal(response.status, 200);

  const auditResponse = await handleApiRequest(
    new Request("https://example.test/api/audit-logs", { headers: { "x-demo-role": "approver" } }),
    env
  );
  const auditBody = await auditResponse.json();
  assert.equal(auditBody.auditLogs.filter((entry) => entry.action === "drawing.transaction").length, 1);
});

test("audit log export requires approver capability and returns CSV with injection guarding", async () => {
  resetMemoryStore();
  await handleApiRequest(
    new Request("https://example.test/api/drawings/dwg_demo_001/transactions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-demo-role": "drafter",
        "idempotency-key": "csv-export-seed",
        "expected-version": "1"
      },
      body: JSON.stringify({ label: "=cmd|'/c calc'!A1", commands: [] })
    }),
    env
  );

  const forbidden = await handleApiRequest(
    new Request("https://example.test/api/audit-logs/export", { method: "POST", headers: { "content-type": "application/json", "x-demo-role": "drafter" } }),
    env
  );
  assert.equal(forbidden.status, 403);

  const csvResponse = await handleApiRequest(
    new Request("https://example.test/api/audit-logs/export", { method: "POST", headers: { "content-type": "application/json", "x-demo-role": "approver" } }),
    env
  );
  assert.equal(csvResponse.status, 200);
  assert.equal(csvResponse.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.match(csvResponse.headers.get("content-disposition") ?? "", /attachment; filename="audit-logs-/);
  const csvText = await csvResponse.text();
  assert.match(csvText, /^id,createdAt,actorId,role,action,targetType,targetId,detail\r\n/);
  // detail に含まれる数式風文字列は "'"" でガードされ、生の "=" 始まりで出力されない。
  assert.doesNotMatch(csvText, /[^"']=cmd\|/);

  const exportAudit = await handleApiRequest(
    new Request("https://example.test/api/audit-logs", { headers: { "x-demo-role": "approver" } }),
    env
  );
  const exportAuditBody = await exportAudit.json();
  assert.ok(exportAuditBody.auditLogs.some((entry) => entry.action === "audit.exported"));
  assert.equal(typeof exportAuditBody.total, "number");
});

test("audit log listing supports limit and offset pagination", async () => {
  resetMemoryStore();
  for (let i = 0; i < 3; i += 1) {
    await handleApiRequest(
      new Request("https://example.test/api/drawings/dwg_demo_001/transactions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-demo-role": "drafter",
          "idempotency-key": `page-${i}`,
          "expected-version": String(i + 1)
        },
        body: JSON.stringify({ label: `page ${i}`, commands: [] })
      }),
      env
    );
  }
  const page1 = await handleApiRequest(
    new Request("https://example.test/api/audit-logs?limit=1&offset=0", { headers: { "x-demo-role": "approver" } }),
    env
  );
  const page1Body = await page1.json();
  assert.equal(page1Body.auditLogs.length, 1);
  assert.equal(page1Body.limit, 1);
  assert.equal(page1Body.offset, 0);

  const page2 = await handleApiRequest(
    new Request("https://example.test/api/audit-logs?limit=1&offset=1", { headers: { "x-demo-role": "approver" } }),
    env
  );
  const page2Body = await page2.json();
  assert.equal(page2Body.auditLogs.length, 1);
  assert.notEqual(page1Body.auditLogs[0].id, page2Body.auditLogs[0].id);
});

test("stale revision cannot overwrite a newer transaction", async () => {
  resetMemoryStore();
  const send = (key) =>
    handleApiRequest(
      new Request("https://example.test/api/drawings/dwg_demo_001/transactions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-demo-role": "drafter",
          "idempotency-key": key,
          "expected-version": "1"
        },
        body: JSON.stringify({ label: key, commands: [] })
      }),
      env
    );
  assert.equal((await send("revision-first")).status, 200);
  const stale = await send("revision-stale");
  assert.equal(stale.status, 409);
  assert.match((await stale.json()).error, /リビジョン/);
});

test("review updates require concurrency and idempotency gates", async () => {
  resetMemoryStore();
  const missingGates = await handleApiRequest(
    new Request("https://example.test/api/drawings/dwg_demo_001/review", {
      method: "POST",
      headers: { "content-type": "application/json", "x-demo-role": "drafter" },
      body: JSON.stringify({ action: "submit" })
    }),
    env
  );
  assert.equal(missingGates.status, 428);

  const submitted = await handleApiRequest(
    new Request("https://example.test/api/drawings/dwg_demo_001/review", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-demo-role": "drafter",
        "idempotency-key": "idem-review-submit",
        "expected-version": "1"
      },
      body: JSON.stringify({ action: "submit" })
    }),
    env
  );
  assert.equal(submitted.status, 200);
  assert.equal((await submitted.json()).drawing.state, "in_review");
});

test("review lifecycle enforces submit, approve, then new version", async () => {
  resetMemoryStore();
  const review = (action, role, revision, key) =>
    handleApiRequest(
      new Request("https://example.test/api/drawings/dwg_demo_001/review", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-demo-role": role,
          "idempotency-key": key,
          "expected-version": String(revision)
        },
        body: JSON.stringify({ action })
      }),
      env
    );

  const submitted = await (await review("submit", "drafter", 1, "lifecycle-submit")).json();
  assert.equal(submitted.drawing.state, "in_review");
  assert.equal(submitted.drawing.revision, 2);

  const approved = await (await review("approve", "approver", 2, "lifecycle-approve")).json();
  assert.equal(approved.drawing.state, "approved");
  assert.equal(approved.drawing.revision, 3);

  const next = await (await review("new_version", "cad_admin", 3, "lifecycle-new-version")).json();
  assert.equal(next.drawing.state, "draft");
  assert.equal(next.drawing.version, 2);
  assert.equal(next.drawing.revision, 4);
});

test("agent run preview then explicit approval mutates drawing", async () => {
  resetMemoryStore();
  const planResponse = await handleApiRequest(
    new Request("https://example.test/api/drawings/dwg_demo_001/agent-runs", {
      method: "POST",
      headers: { "content-type": "application/json", "x-demo-role": "drafter" },
      body: JSON.stringify({ prompt: "クレーンの重機範囲を追加" })
    }),
    env
  );
  const planBody = await planResponse.json();
  assert.equal(planResponse.status, 201);
  assert.equal(planBody.run.status, "planned");

  const before = await (await handleApiRequest(new Request("https://example.test/api/drawings/dwg_demo_001"), env)).json();
  const approveResponse = await handleApiRequest(
    new Request(`https://example.test/api/agent-runs/${planBody.run.id}/approve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-demo-role": "drafter",
        "idempotency-key": "idem-agent",
        "expected-version": "1"
      },
      body: "{}"
    }),
    env
  );
  const approveBody = await approveResponse.json();
  assert.equal(approveResponse.status, 200);
  assert.equal(approveBody.drawing.entities.length, before.drawing.entities.length + 2);
});

test("agent-runs prefers the rule-based engine and never calls the LLM stub when a rule matches", async () => {
  resetMemoryStore();
  let called = false;
  const envWithStub = { ...env, AI_COMPLETION: async () => { called = true; return { status: "planned", commands: [] }; } };
  const response = await handleApiRequest(
    new Request("https://example.test/api/drawings/dwg_demo_001/agent-runs", {
      method: "POST",
      headers: { "content-type": "application/json", "x-demo-role": "drafter" },
      body: JSON.stringify({ prompt: "クレーンの重機範囲を追加" })
    }),
    envWithStub
  );
  const body = await response.json();
  assert.equal(body.run.proposal.status, "planned");
  assert.equal(called, false);
});

test("agent-runs falls back to the LLM stub when the rule engine needs input, and normalizes commands without leaking the prompt in audit logs", async () => {
  resetMemoryStore();
  const envWithStub = {
    ...env,
    AI_COMPLETION: async () => ({
      status: "planned",
      label: "LLM提案: 仮設フェンス追加",
      commands: [
        { op: "add", entityType: "line", layerId: "layer-temporary", start: { x: 100, y: 100 }, end: { x: 500, y: 100 } },
        { op: "delete_layer", id: "layer-structure" }
      ]
    })
  };
  const response = await handleApiRequest(
    new Request("https://example.test/api/drawings/dwg_demo_001/agent-runs", {
      method: "POST",
      headers: { "content-type": "application/json", "x-demo-role": "drafter", "idempotency-key": "llm-fallback" },
      body: JSON.stringify({ prompt: "仮設フェンスをここに追加して欲しい機密パスワードsk-leak-me" })
    }),
    envWithStub
  );
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(body.run.proposal.status, "planned");
  assert.equal(body.run.proposal.engine, "llm");
  assert.equal(body.run.proposal.commands.length, 1);
  assert.equal(body.run.proposal.commands[0].op, "add");
  assert.match(body.run.proposal.warnings.join(" "), /不正または未対応の操作/);

  const auditResponse = await handleApiRequest(
    new Request("https://example.test/api/audit-logs", { headers: { "x-demo-role": "approver" } }),
    env
  );
  const auditBody = await auditResponse.json();
  const plannedAudit = auditBody.auditLogs.find((entry) => entry.action === "agent.planned" && entry.targetId === body.run.id);
  assert.ok(plannedAudit);
  assert.equal(plannedAudit.detail.engine, "llm");
  assert.equal(JSON.stringify(plannedAudit.detail).includes("機密パスワードsk-leak-me"), false);
});

test("agent-runs rejects LLM commands that add entities outside the paper bounds or reference a nonexistent layer", async () => {
  resetMemoryStore();
  const envWithStub = {
    ...env,
    AI_COMPLETION: async () => ({
      status: "planned",
      commands: [
        { op: "add", entityType: "circle", layerId: "layer-temporary", center: { x: 999999, y: 0 }, radius: 100 },
        { op: "add", entityType: "circle", layerId: "layer-does-not-exist", center: { x: 100, y: 100 }, radius: 50 }
      ]
    })
  };
  const response = await handleApiRequest(
    new Request("https://example.test/api/drawings/dwg_demo_001/agent-runs", {
      method: "POST",
      headers: { "content-type": "application/json", "x-demo-role": "drafter", "idempotency-key": "llm-bounds" },
      body: JSON.stringify({ prompt: "円をたくさん置いて" })
    }),
    envWithStub
  );
  const body = await response.json();
  assert.equal(response.status, 202);
  assert.equal(body.run.proposal.status, "needs_input");
  assert.match(body.run.proposal.warnings.join(" "), /用紙範囲外/);
});

test("agent-runs fails soft to rule-based needs_input when the LLM stub throws", async () => {
  resetMemoryStore();
  const envWithStub = { ...env, AI_COMPLETION: async () => { throw new Error("upstream exploded with a secret key sk-123"); } };
  const response = await handleApiRequest(
    new Request("https://example.test/api/drawings/dwg_demo_001/agent-runs", {
      method: "POST",
      headers: { "content-type": "application/json", "x-demo-role": "drafter", "idempotency-key": "llm-fail-soft" },
      body: JSON.stringify({ prompt: "この線を5m延長して" })
    }),
    envWithStub
  );
  const body = await response.json();
  assert.equal(response.status, 202);
  assert.equal(body.run.proposal.status, "needs_input");
  assert.equal(JSON.stringify(body).includes("sk-123"), false);
});

test("agent-runs enforces the AI rate limit only for LLM-backed requests", async () => {
  resetMemoryStore();
  const envWithStub = {
    ...env,
    AI_RATE_LIMIT_PER_MINUTE: "2",
    AI_COMPLETION: async () => ({ status: "needs_input", question: "もっと具体的に教えてください。" })
  };
  const attempt = (key) =>
    handleApiRequest(
      new Request("https://example.test/api/drawings/dwg_demo_001/agent-runs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-demo-role": "drafter",
          "x-demo-actor": "rate-limit-tester@example.com",
          "idempotency-key": key
        },
        body: JSON.stringify({ prompt: "この線を5m延長して" })
      }),
      envWithStub
    );
  const first = await attempt("rate-1");
  const second = await attempt("rate-2");
  const third = await attempt("rate-3");
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  assert.equal(third.status, 429);
});

test("reviewer can post a comment without canEdit, and it is audited without leaking the body", async () => {
  resetMemoryStore();
  const response = await handleApiRequest(
    new Request("https://example.test/api/drawings/dwg_demo_001/comments", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-demo-role": "reviewer",
        "idempotency-key": "idem-comment-reviewer",
        "expected-version": "1"
      },
      body: JSON.stringify({ body: "この寸法を確認してください", entityId: "e_box_1" })
    }),
    env
  );
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(body.drawing.comments.length, 1);
  assert.equal(body.drawing.comments[0].author, "demo@example.com");
  assert.equal(body.drawing.comments[0].entityId, "e_box_1");

  const auditResponse = await handleApiRequest(
    new Request("https://example.test/api/audit-logs", { headers: { "x-demo-role": "approver" } }),
    env
  );
  const auditBody = await auditResponse.json();
  const commentAudit = auditBody.auditLogs.find((entry) => entry.action === "comment.added");
  assert.ok(commentAudit);
  assert.equal(commentAudit.detail.commentId, body.drawing.comments[0].id);
  assert.equal(JSON.stringify(commentAudit.detail).includes("この寸法"), false);
});

test("comments endpoint rejects a null JSON body with 400 instead of a 500", async () => {
  resetMemoryStore();
  const response = await handleApiRequest(
    new Request("https://example.test/api/drawings/dwg_demo_001/comments", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-demo-role": "drafter",
        "idempotency-key": "idem-comment-null-body",
        "expected-version": "1"
      },
      body: "null"
    }),
    env
  );
  assert.equal(response.status, 400);
});

test("viewer cannot post comments", async () => {
  resetMemoryStore();
  const response = await handleApiRequest(
    new Request("https://example.test/api/drawings/dwg_demo_001/comments", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-demo-role": "viewer",
        "idempotency-key": "idem-comment-viewer",
        "expected-version": "1"
      },
      body: JSON.stringify({ body: "閲覧のみ" })
    }),
    env
  );
  const body = await response.json();
  assert.equal(response.status, 403);
  assert.match(body.error, /権限/);
});

test("ai status reports disabled when no provider is configured, without leaking keys", async () => {
  resetMemoryStore();
  const response = await handleApiRequest(
    new Request("https://example.test/api/ai/status", { headers: { "x-demo-role": "drafter" } }),
    env
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.enabled, false);
  assert.equal(body.provider, null);
  assert.equal(body.model, null);
});

test("ai status reports enabled with provider and model but never the API key", async () => {
  resetMemoryStore();
  const configuredEnv = {
    ...env,
    AI_PROVIDER: "openai",
    OPENAI_API_KEY: "sk-super-secret-value",
    AI_MODEL: "gpt-test-model"
  };
  const response = await handleApiRequest(
    new Request("https://example.test/api/ai/status", { headers: { "x-demo-role": "drafter" } }),
    configuredEnv
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.enabled, true);
  assert.equal(body.provider, "openai");
  assert.equal(body.model, "gpt-test-model");
  assert.equal(JSON.stringify(body).includes("sk-super-secret-value"), false);
});

test("ai status requires canRunAi capability", async () => {
  resetMemoryStore();
  const response = await handleApiRequest(
    new Request("https://example.test/api/ai/status", { headers: { "x-demo-role": "viewer" } }),
    env
  );
  const body = await response.json();
  assert.equal(response.status, 403);
  assert.match(body.error, /権限/);
});

test("approval rejects a proposal when its server-side run is missing", async () => {
  resetMemoryStore();
  const planResponse = await handleApiRequest(
    new Request("https://example.test/api/drawings/dwg_demo_001/agent-runs", {
      method: "POST",
      headers: { "content-type": "application/json", "x-demo-role": "drafter" },
      body: JSON.stringify({ prompt: "注記追加" })
    }),
    env
  );
  const planBody = await planResponse.json();
  resetMemoryStore();

  const approveResponse = await handleApiRequest(
    new Request(`https://example.test/api/agent-runs/${planBody.run.id}/approve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-demo-role": "drafter",
        "idempotency-key": "idem-stateless-agent",
        "expected-version": "1"
      },
      body: JSON.stringify({ drawingId: planBody.run.drawingId, proposal: planBody.run.proposal })
    }),
    env
  );
  const approveBody = await approveResponse.json();
  assert.equal(approveResponse.status, 404);
  assert.match(approveBody.error, /Agent Run/);
});

test("anonymous public demo drawing does not expose who edited or commented on it", async () => {
  resetMemoryStore();
  const email = "site.engineer@company.example";
  const post = (path, idempotencyKey, version, body) =>
    handleApiRequest(
      new Request(`https://example.test/api/drawings/dwg_demo_001/${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-demo-role": "drafter",
          "x-demo-actor": email,
          "idempotency-key": idempotencyKey,
          "expected-version": String(version)
        },
        body: JSON.stringify(body)
      }),
      env
    );
  const edited = await post("transactions", "pii-edit", 1, {
    label: "線を追加",
    commands: [{ op: "add", entity: { id: "e_pii_line", type: "line", layerId: "layer-frame", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], createdBy: email } }]
  });
  assert.equal(edited.status, 200, JSON.stringify(await edited.clone().json()));
  const commented = await post("comments", "pii-comment", 2, { body: `確認お願いします(連絡先 ${email} / 太郎@example.com / taro@例子.公司)` });
  assert.equal(commented.status, 201);

  // 認証済みの利用者には、誰が操作したかが見える。
  const internal = await (await handleApiRequest(
    new Request("https://example.test/api/drawings/demo", { headers: { "x-demo-role": "viewer" } }),
    env
  )).json();
  assert.ok(JSON.stringify(internal.drawing).includes(email));

  const response = await handleApiRequest(new Request("https://example.test/api/drawings/demo"), {
    APP_ENV: "production",
    AUTH_MODE: "access"
  });
  assert.equal(response.status, 200);
  const { drawing } = await response.json();
  assert.equal(JSON.stringify(drawing).includes("company.example"), false);
  assert.equal(drawing.comments.at(-1).author, "user");
  assert.equal(drawing.comments.at(-1).body, "確認お願いします(連絡先 [メールアドレス省略] / [メールアドレス省略] / [メールアドレス省略])");
  assert.equal(drawing.auditLog.at(-1).actor, "user");
  assert.equal(drawing.auditLog[0].actor, "system");
  assert.equal(drawing.entities.find((entity) => entity.id === "e_pii_line").createdBy, "user");
});
