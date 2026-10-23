import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  MCIP_ERROR_CODES,
  MCIP_LIMITS,
  createMcipClient,
  describeMcipConfig
} from "../src/mcip-client.js";
import { CDE_ERROR_CODES, createCdeClient, describeCdeConfig } from "../src/cde-client.js";

const MCIP_ENV = Object.freeze({
  MCIP_API_BASE_URL: "https://mcip.example.test",
  MCIP_API_TOKEN: "fake-mcip-token-for-tests"
});
const CDE_ENV = Object.freeze({
  CDE_API_BASE_URL: "https://cde.example.test",
  CDE_API_TOKEN: "fake-cde-token-for-tests"
});

function jsonResponse(status, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

function chunkedResponse(status, chunks, state = {}) {
  const encoder = new TextEncoder();
  const encoded = chunks.map((chunk) => (typeof chunk === "string" ? encoder.encode(chunk) : chunk));
  let index = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    body: {
      getReader: () => ({
        read: async () => (index < encoded.length ? { done: false, value: encoded[index++] } : { done: true }),
        cancel: async () => {
          state.cancelled = true;
        }
      })
    },
    text: async () => {
      throw new Error("text() must not be used when a body reader exists");
    }
  };
}

function makeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return handler(url, options, calls.length);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function neverCallFetch() {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    throw new Error("fetch must not be called");
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

// ---------------------------------------------------------------- MCIP: 設定

test("describeMcipConfig is disabled and exposes no secrets when configuration is missing", () => {
  const missingBoth = describeMcipConfig({});
  assert.equal(missingBoth.enabled, false);
  assert.equal(missingBoth.reason, "missing_configuration");
  assert.equal(missingBoth.baseUrlOrigin, null);

  const missingToken = describeMcipConfig({ MCIP_API_BASE_URL: MCIP_ENV.MCIP_API_BASE_URL });
  assert.equal(missingToken.enabled, false);
  assert.equal(missingToken.reason, "missing_configuration");

  const missingUrl = describeMcipConfig({ MCIP_API_TOKEN: MCIP_ENV.MCIP_API_TOKEN });
  assert.equal(missingUrl.enabled, false);

  const serialized = JSON.stringify([missingBoth, missingToken, missingUrl]);
  assert.ok(!serialized.includes(MCIP_ENV.MCIP_API_TOKEN));
});

test("describeMcipConfig rejects invalid, insecure, and query-bearing base URLs", () => {
  for (const [baseUrl, reason] of [
    ["not-a-url", "invalid_base_url"],
    ["ftp://mcip.example.test", "invalid_base_url"],
    ["https://mcip.example.test?tenant=1", "invalid_base_url"],
    ["https://mcip.example.test#fragment", "invalid_base_url"],
    ["http://mcip.example.test", "insecure_base_url"]
  ]) {
    const config = describeMcipConfig({ MCIP_API_BASE_URL: baseUrl, MCIP_API_TOKEN: MCIP_ENV.MCIP_API_TOKEN });
    assert.equal(config.enabled, false, baseUrl);
    assert.equal(config.reason, reason, baseUrl);
  }
  // ループバックのHTTPは開発用に許可する。
  const local = describeMcipConfig({ MCIP_API_BASE_URL: "http://127.0.0.1:8080", MCIP_API_TOKEN: "t" });
  assert.equal(local.enabled, true);
});

test("describeMcipConfig rejects credentials embedded in the base URL without echoing them", () => {
  const config = describeMcipConfig({
    MCIP_API_BASE_URL: "https://integration-user:super-secret-password@mcip.example.test",
    MCIP_API_TOKEN: MCIP_ENV.MCIP_API_TOKEN
  });
  assert.equal(config.enabled, false);
  assert.equal(config.reason, "credentials_in_base_url");
  const serialized = JSON.stringify(config);
  assert.ok(!serialized.includes("super-secret-password"));
  assert.ok(!serialized.includes("integration-user"));
});

test("describeMcipConfig returns only the origin, never the token", () => {
  const config = describeMcipConfig({ ...MCIP_ENV, MCIP_API_BASE_URL: "https://mcip.example.test/internal/path" });
  assert.deepEqual(config, { enabled: true, reason: null, baseUrlOrigin: "https://mcip.example.test" });
  assert.ok(!JSON.stringify(config).includes(MCIP_ENV.MCIP_API_TOKEN));
});

// ---------------------------------------------------------------- MCIP: fail-closed

test("createMcipClient never calls fetch when unconfigured", async () => {
  const fetchImpl = neverCallFetch();
  const client = createMcipClient({}, { fetchImpl });
  assert.equal(client.configured, false);

  const project = await client.getProject("PRJ-2026-0012");
  assert.equal(project.ok, false);
  assert.equal(project.error.code, MCIP_ERROR_CODES.NOT_CONFIGURED);

  const list = await client.listProjects({ limit: 10 });
  assert.equal(list.ok, false);
  assert.equal(list.error.code, MCIP_ERROR_CODES.NOT_CONFIGURED);

  assert.equal(fetchImpl.calls.length, 0);
});

test("createMcipClient reports invalid_configuration instead of calling fetch for unsafe settings", async () => {
  const fetchImpl = neverCallFetch();
  const client = createMcipClient(
    { MCIP_API_BASE_URL: "http://mcip.example.test", MCIP_API_TOKEN: "fake-token-for-tests" },
    { fetchImpl }
  );
  const project = await client.getProject("PRJ-2026-0012");
  assert.equal(project.ok, false);
  assert.equal(project.error.code, MCIP_ERROR_CODES.INVALID_CONFIGURATION);
  assert.equal(fetchImpl.calls.length, 0);
});

// ---------------------------------------------------------------- MCIP: getProject

test("getProject returns the MCIP payload unchanged and never rewrites project ids", async () => {
  const payload = {
    code: "PRJ-2026-0012",
    project_id: "PRJ-2026-0012",
    name: "外部案件",
    internal_hint: "prj_demo_road_001"
  };
  const fetchImpl = makeFetch(() => jsonResponse(200, payload));
  const client = createMcipClient(MCIP_ENV, { fetchImpl });

  const result = await client.getProject("PRJ-2026-0012");
  assert.equal(result.ok, true);
  assert.equal(result.projectId, "PRJ-2026-0012");
  assert.deepEqual(result.payload, payload);
  // Web-CADの内部案件ID(`prj_…`)への自動変換・付与をしない。
  assert.equal("internalProjectId" in result, false);
  assert.equal(fetchImpl.calls.length, 1);

  const [call] = fetchImpl.calls;
  const url = new URL(call.url);
  assert.equal(url.origin, "https://mcip.example.test");
  assert.equal(url.pathname, "/api/v1/projects/PRJ-2026-0012");
  assert.equal(call.options.method, "GET");
  assert.equal(call.options.headers.authorization, `Bearer ${MCIP_ENV.MCIP_API_TOKEN}`);
  assert.equal(call.options.headers.accept, "application/json");
  assert.equal(call.options.redirect, "error");
  assert.ok(call.options.signal instanceof AbortSignal);
});

test("getProject validates the project code before any network call", async () => {
  const fetchImpl = neverCallFetch();
  const client = createMcipClient(MCIP_ENV, { fetchImpl });
  for (const invalid of ["", " ", "PRJ 2026", "../secrets", "a/b", "x".repeat(MCIP_LIMITS.maxProjectIdChars + 1), 123]) {
    const result = await client.getProject(invalid);
    assert.equal(result.ok, false, String(invalid));
    assert.equal(result.error.code, MCIP_ERROR_CODES.INVALID_ARGUMENT);
    assert.equal(result.error.field, "projectId");
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test("getProject maps an HTTP error to a safe code and does not retry", async () => {
  const fetchImpl = makeFetch(() => jsonResponse(500, { token: MCIP_ENV.MCIP_API_TOKEN, error: "boom" }));
  const client = createMcipClient(MCIP_ENV, { fetchImpl });

  const result = await client.getProject("PRJ-2026-0012");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, MCIP_ERROR_CODES.HTTP_ERROR);
  assert.equal(result.error.status, 500);
  assert.equal(fetchImpl.calls.length, 1);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(MCIP_ENV.MCIP_API_TOKEN));
  assert.ok(!serialized.includes("mcip.example.test"));
});

test("getProject maps a TimeoutError to timeout and does not retry", async () => {
  const fetchImpl = makeFetch(() => {
    const error = new Error(`timed out for https://user:pass@mcip.example.test with ${MCIP_ENV.MCIP_API_TOKEN}`);
    error.name = "TimeoutError";
    throw error;
  });
  const client = createMcipClient(MCIP_ENV, { fetchImpl });

  const result = await client.getProject("PRJ-2026-0012");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, MCIP_ERROR_CODES.TIMEOUT);
  assert.equal(fetchImpl.calls.length, 1);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(MCIP_ENV.MCIP_API_TOKEN));
  assert.ok(!serialized.includes("user:pass"));
});

test("getProject maps network failures to a safe error without echoing the cause", async () => {
  const fetchImpl = makeFetch(() => {
    throw new Error(`connect ECONNREFUSED https://user:pass@mcip.example.test (${MCIP_ENV.MCIP_API_TOKEN})`);
  });
  const client = createMcipClient(MCIP_ENV, { fetchImpl });

  const result = await client.getProject("PRJ-2026-0012");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, MCIP_ERROR_CODES.NETWORK);
  assert.equal(fetchImpl.calls.length, 1);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(MCIP_ENV.MCIP_API_TOKEN));
  assert.ok(!serialized.includes("user:pass"));
  assert.ok(!serialized.includes("ECONNREFUSED"));
});

test("getProject enforces the configured timeout through AbortSignal", async () => {
  let signalSeen = false;
  const fetchImpl = makeFetch(
    (url, options) =>
      new Promise((resolve, reject) => {
        signalSeen = options.signal instanceof AbortSignal;
        // AbortSignal.timeout()のタイマーはunrefされるため、イベントループを維持する
        // 通常のタイマーを張る。abortが先に来たらそちらでrejectする。
        const fallback = setTimeout(() => {
          const error = new Error("signal was not wired to the request");
          error.name = "NoAbortSignal";
          reject(error);
        }, 500);
        options.signal.addEventListener("abort", () => {
          clearTimeout(fallback);
          const error = new Error("aborted");
          error.name = "TimeoutError";
          reject(error);
        });
      })
  );
  const client = createMcipClient(MCIP_ENV, { fetchImpl, timeoutMs: 20 });

  const result = await client.getProject("PRJ-2026-0012");
  assert.equal(signalSeen, true);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, MCIP_ERROR_CODES.TIMEOUT);
  assert.equal(fetchImpl.calls.length, 1);
});

test("getProject rejects non-JSON, non-object, and oversized responses", async () => {
  const notJson = createMcipClient(MCIP_ENV, { fetchImpl: makeFetch(() => jsonResponse(200, "not json")) });
  assert.equal((await notJson.getProject("PRJ-1")).error.code, MCIP_ERROR_CODES.INVALID_RESPONSE);

  for (const body of ["null", '"hello"', "42"]) {
    const client = createMcipClient(MCIP_ENV, { fetchImpl: makeFetch(() => jsonResponse(200, body)) });
    const result = await client.getProject("PRJ-1");
    assert.equal(result.ok, false, body);
    assert.equal(result.error.code, MCIP_ERROR_CODES.INVALID_RESPONSE, body);
  }

  const state = {};
  const oversized = createMcipClient(MCIP_ENV, {
    fetchImpl: makeFetch(() =>
      chunkedResponse(200, [new Uint8Array(MCIP_LIMITS.maxResponseBytes), new Uint8Array(1)], state)
    )
  });
  const oversizedResult = await oversized.getProject("PRJ-1");
  assert.equal(oversizedResult.error.code, MCIP_ERROR_CODES.RESPONSE_TOO_LARGE);
  assert.equal(state.cancelled, true);

  const textOnly = createMcipClient(MCIP_ENV, {
    fetchImpl: makeFetch(() => ({ ok: true, status: 200, text: async () => "x".repeat(MCIP_LIMITS.maxResponseBytes + 1) }))
  });
  assert.equal((await textOnly.getProject("PRJ-1")).error.code, MCIP_ERROR_CODES.RESPONSE_TOO_LARGE);
});

// ---------------------------------------------------------------- MCIP: listProjects

test("listProjects sends a bounded default query", async () => {
  const fetchImpl = makeFetch(() => jsonResponse(200, { items: [] }));
  const client = createMcipClient(MCIP_ENV, { fetchImpl });

  const result = await client.listProjects();
  assert.equal(result.ok, true);
  assert.deepEqual(result.query, { limit: MCIP_LIMITS.defaultListLimit, cursor: null });
  const url = new URL(fetchImpl.calls[0].url);
  assert.equal(url.pathname, "/api/v1/projects");
  assert.equal(url.searchParams.get("limit"), String(MCIP_LIMITS.defaultListLimit));
  assert.equal(url.searchParams.has("cursor"), false);
});

test("listProjects passes an opaque cursor and limit without interpreting them", async () => {
  const fetchImpl = makeFetch(() => jsonResponse(200, { items: [], next_cursor: "next-page" }));
  const client = createMcipClient(MCIP_ENV, { fetchImpl });

  const result = await client.listProjects({ limit: 50, cursor: "abc+/=def" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.query, { limit: 50, cursor: "abc+/=def" });
  const url = new URL(fetchImpl.calls[0].url);
  assert.equal(url.searchParams.get("limit"), "50");
  assert.equal(url.searchParams.get("cursor"), "abc+/=def");
});

test("listProjects rejects invalid pagination input without calling fetch", async () => {
  const fetchImpl = neverCallFetch();
  const client = createMcipClient(MCIP_ENV, { fetchImpl });
  for (const query of [
    { limit: 0 },
    { limit: 101 },
    { limit: 2.5 },
    { limit: "10" },
    { limit: null },
    { cursor: "" },
    { cursor: "a b" },
    { cursor: "line\nbreak" },
    { cursor: "x".repeat(MCIP_LIMITS.maxCursorChars + 1) },
    { cursor: 7 }
  ]) {
    const result = await client.listProjects(query);
    assert.equal(result.ok, false, JSON.stringify(query));
    assert.equal(result.error.code, MCIP_ERROR_CODES.INVALID_ARGUMENT);
  }
  assert.equal((await client.listProjects(null)).error.code, MCIP_ERROR_CODES.INVALID_ARGUMENT);
  assert.equal(fetchImpl.calls.length, 0);
});

test("listProjects maps HTTP errors to a safe result without retrying", async () => {
  const fetchImpl = makeFetch(() => jsonResponse(429, { message: "rate limited" }));
  const client = createMcipClient(MCIP_ENV, { fetchImpl });

  const result = await client.listProjects();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, MCIP_ERROR_CODES.HTTP_ERROR);
  assert.equal(result.error.status, 429);
  assert.equal(fetchImpl.calls.length, 1);
});

test("MCIP adapter results never contain the configured token", async () => {
  const results = [
    describeMcipConfig(MCIP_ENV),
    createMcipClient(MCIP_ENV, { fetchImpl: makeFetch(() => jsonResponse(200, { code: "PRJ-1" })) }).describe()
  ];
  results.push(await createMcipClient(MCIP_ENV, { fetchImpl: makeFetch(() => jsonResponse(200, { code: "PRJ-1" })) }).getProject("PRJ-1"));
  results.push(await createMcipClient(MCIP_ENV, { fetchImpl: makeFetch(() => jsonResponse(500, {})) }).listProjects());
  const serialized = JSON.stringify(results);
  assert.ok(!serialized.includes(MCIP_ENV.MCIP_API_TOKEN));
});

test("mcip-client.js has no direct imports or hard-coded endpoints", async () => {
  const source = await readFile(new URL("../src/mcip-client.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(source, /https?:\/\//);
});

// ---------------------------------------------------------------- CDE

test("describeCdeConfig is disabled without secrets and validates the base URL", () => {
  const disabled = describeCdeConfig({});
  assert.deepEqual(disabled, { enabled: false, reason: "missing_configuration", baseUrlOrigin: null });

  const embedded = describeCdeConfig({
    CDE_API_BASE_URL: "https://integration-user:super-secret-password@cde.example.test",
    CDE_API_TOKEN: CDE_ENV.CDE_API_TOKEN
  });
  assert.equal(embedded.reason, "credentials_in_base_url");
  assert.ok(!JSON.stringify(embedded).includes("super-secret-password"));

  const enabled = describeCdeConfig(CDE_ENV);
  assert.deepEqual(enabled, { enabled: true, reason: null, baseUrlOrigin: "https://cde.example.test" });
  assert.ok(!JSON.stringify(enabled).includes(CDE_ENV.CDE_API_TOKEN));
});

test("createCdeClient is fail-closed when unconfigured", async () => {
  const client = createCdeClient({});
  assert.equal(client.configured, false);
  const result = await client.registerApprovedVersion({ projectId: "prj_demo_road_001" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, CDE_ERROR_CODES.NOT_CONFIGURED);
});

test("createCdeClient reports invalid_configuration for an unsafe base URL", async () => {
  const client = createCdeClient({
    CDE_API_BASE_URL: "http://cde.example.test",
    CDE_API_TOKEN: "fake-token-for-tests"
  });
  const result = await client.registerApprovedVersion({});
  assert.equal(result.error.code, CDE_ERROR_CODES.INVALID_CONFIGURATION);
});

test("registerApprovedVersion always reports that the CDE registration API is not provided", async () => {
  const client = createCdeClient(CDE_ENV);
  assert.equal(client.configured, true);

  for (const input of [
    undefined,
    {},
    {
      projectId: "prj_demo_road_001",
      drawingId: "dwg_demo_001",
      versionId: "dvw_demo_001_v2",
      versionNo: 2,
      contentHash: "abc123",
      approverId: "00000000-0000-0000-0000-000000000000",
      approvalRef: "audit_abc123",
      idempotencyKey: "idem-1"
    }
  ]) {
    const result = await client.registerApprovedVersion(input);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, CDE_ERROR_CODES.NOT_SUPPORTED);
    assert.match(result.error.message, /API/);
    assert.match(result.error.message, /外部入力待ち/);
  }
  // 設定状態には秘密値を含めない。
  assert.ok(!JSON.stringify(client.describe()).includes(CDE_ENV.CDE_API_TOKEN));
});

test("cde-client.js contains no network call and no endpoint literal", async () => {
  const source = await readFile(new URL("../src/cde-client.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /XMLHttpRequest/);
  assert.doesNotMatch(source, /node:(http|https|net)/);
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(source, /https?:\/\//);
});
