import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createDataStore } from "../src/data-store.js";
import {
  INTEGRATION_STATUS,
  STRICT_TRANSPORT_SECURITY,
  coreLockStatus,
  handleApiRequest,
  resetMemoryStore
} from "../src/api-handler.js";

// GET /api/integration/status の回帰テスト。既存のテストハーネス(handleApiRequestを
// 直接呼ぶ)を使い、実DB・外部API・Stagingホストには一切触れない。
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const DIST = "fedcba9876543210fedcba9876543210fedcba98";
const SECRET = "SUPERSECRET-should-not-be-returned";
const DEMO_ENV = { AUTH_MODE: "demo", APP_ENV: "staging" };
const URL_PATH = "https://example.test/api/integration/status";

function request(headers = {}, env = DEMO_ENV) {
  return handleApiRequest(new Request(URL_PATH, { headers }), env);
}

test("未認証のアクセスは401で拒否する(healthのように公開しない)", async () => {
  resetMemoryStore();
  const accessEnv = { AUTH_MODE: "access", APP_ENV: "production" };
  const response = await request({}, accessEnv);
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal("integrations" in body, false);

  // JWT検証に失敗した場合も401。内部エラーの詳細は返さない。
  const failed = await request(
    { "cf-access-jwt-assertion": "not-a-token" },
    { ...accessEnv, ACCESS_JWT_VERIFIER: async () => { throw new Error("invalid token"); } }
  );
  assert.equal(failed.status, 401);
  assert.equal((await failed.json()).error, "Cloudflare Access JWTを検証できません。");
});

test("viewer以上は200で、返却schemaは固定されている", async () => {
  resetMemoryStore();
  const response = await request({ "x-demo-role": "viewer" });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, {
    ok: true,
    system_id: "web-cad",
    environment: "staging",
    deployment: { commit: null, distCommit: null },
    integrations: {
      // core-lock/は未作成(署名付きRelease未提供)なのでabsent。core-lock/を作ったら
      // このテストとdocs/architecture/integration-status.mdを同じPRで更新する。
      core: { registered: true, lock: "absent", signed_release: "unverified" },
      mcip: { configured: false, project_id_api: "unavailable" },
      cde: { configured: false, approved_version_api: "unavailable" },
      mcp: { exposed: false, allowlisted: false }
    }
  });

  // Access(JWT)経由の既定ロールviewerでも読める。
  const accessResponse = await request(
    { "cf-access-jwt-assertion": "token" },
    {
      AUTH_MODE: "access",
      APP_ENV: "production",
      ACCESS_JWT_VERIFIER: async () => ({ email: "viewer@example.com" })
    }
  );
  assert.equal(accessResponse.status, 200);
  assert.equal((await accessResponse.json()).system_id, "web-cad");
});

test("定義済みの全ロール(viewer以上)が参照できる", async () => {
  resetMemoryStore();
  for (const role of ["viewer", "drafter", "reviewer", "approver", "cad_admin"]) {
    const response = await request({ "x-demo-role": role });
    assert.equal(response.status, 200, `${role} が参照できない`);
    assert.equal((await response.json()).ok, true);
  }
});

test("deploymentは稼働commitと配信物のbuild元だけを返す", async () => {
  resetMemoryStore();
  let distCommit = DIST;
  const env = {
    ...DEMO_ENV,
    DEPLOY_INFO: { commit: HEAD, distCommit: () => distCommit, branch: "main", dirty: true, filesystemPath: "/secret/path" }
  };
  const first = await (await request({ "x-demo-role": "viewer" }, env)).json();
  assert.deepEqual(first.deployment, { commit: HEAD, distCommit: DIST });
  assert.equal("branch" in first.deployment, false);
  assert.equal("filesystemPath" in first.deployment, false);

  // distCommitが関数ならリクエストごとに読み直す(healthと同じ挙動)。
  distCommit = HEAD;
  const second = await (await request({ "x-demo-role": "viewer" }, env)).json();
  assert.deepEqual(second.deployment, { commit: HEAD, distCommit: HEAD });

  // DEPLOY_INFOが無い場合はnullで返す。
  const missing = await (await request({ "x-demo-role": "viewer" }, DEMO_ENV)).json();
  assert.deepEqual(missing.deployment, { commit: null, distCommit: null });
});

test("秘密値・環境変数の値・利用者情報を返さない", async () => {
  resetMemoryStore();
  const env = {
    ...DEMO_ENV,
    DATABASE_URL: `postgresql://mirai_web_cad_app:${SECRET}@stub.invalid:5432/mirai_web_cad_staging`,
    ENTRA_CLIENT_SECRET: SECRET,
    OPENAI_API_KEY: SECRET,
    ACCESS_ROLE_MAP: JSON.stringify({ "admin@example.com": "cad_admin" }),
    CORE_LOCK_PATH: `/secret/${SECRET}`,
    DEPLOY_INFO: { commit: HEAD, distCommit: DIST }
  };
  const response = await request({ "x-demo-role": "viewer", "x-demo-actor": "viewer@example.com" }, env);
  assert.equal(response.status, 200);
  const raw = await response.text();
  assert.ok(!raw.includes(SECRET));
  assert.ok(!raw.includes("postgresql://"));
  assert.ok(!raw.includes("admin@example.com"));
  assert.ok(!raw.includes("viewer@example.com"));
  assert.ok(!raw.includes("ENTRA_CLIENT_SECRET"));
  assert.ok(!raw.includes("/secret/"));
});

test("外部呼び出しをせず、監査ログ・DBへ書き込まない(GETで状態を変えない)", async () => {
  resetMemoryStore();
  const store = createDataStore({});
  assert.equal(await store.countAuditLogs(), 0);

  const originalFetch = globalThis.fetch;
  let externalCalls = 0;
  globalThis.fetch = async () => {
    externalCalls += 1;
    throw new Error("external fetch must not be called");
  };
  try {
    const response = await request({ "x-demo-role": "viewer" });
    assert.equal(response.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(externalCalls, 0, "外部APIを呼び出してはならない");
  assert.equal(await store.countAuditLogs(), 0, "GETで監査ログを追記してはならない");

  // 監査一覧APIから見ても0件のまま(統合ステータスの取得では監査を書かない)。
  const audit = await handleApiRequest(
    new Request("https://example.test/api/audit-logs", { headers: { "x-demo-role": "cad_admin" } }),
    DEMO_ENV
  );
  assert.equal(audit.status, 200);
  assert.deepEqual((await audit.json()).auditLogs, []);
});

test("GETのみで、他のメソッドでは状態を返さない", async () => {
  resetMemoryStore();
  for (const method of ["POST", "PATCH", "DELETE", "PUT"]) {
    const response = await handleApiRequest(new Request(URL_PATH, { method, headers: { "x-demo-role": "viewer" } }), DEMO_ENV);
    assert.equal(response.status, 404, `${method} が統合ステータスを返している`);
    assert.equal(response.ok, false);
  }
});

test("既存のCORS・セキュリティヘッダ・no-storeを適用する", async () => {
  resetMemoryStore();
  const response = await request({ "x-demo-role": "viewer", origin: "https://example.test" });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("strict-transport-security"), STRICT_TRANSPORT_SECURITY);
  assert.match(response.headers.get("content-security-policy"), /default-src 'self'/);
  assert.match(response.headers.get("content-type"), /application\/json/);
  assert.equal(response.headers.get("vary"), "Origin");
});

test("core-lock/contracts.lock.json の有無からlock状態を判定する", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "core-lock-"));
  try {
    const lockFile = path.join(dir, "contracts.lock.json");
    assert.equal(coreLockStatus(pathToFileURL(lockFile)), "absent");
    writeFileSync(lockFile, "{}\n");
    assert.equal(coreLockStatus(pathToFileURL(lockFile)), "present");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // 定義済みの状態は凍結されており、リクエスト処理中の変更で応答が変わらない。
  assert.ok(Object.isFrozen(INTEGRATION_STATUS));
  assert.ok(Object.isFrozen(INTEGRATION_STATUS.core));
});
