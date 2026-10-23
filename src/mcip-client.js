// MCIP(案件ID・承認・証跡の正本)の将来APIに備えた**フェイルクローズド**な読み取り専用アダプタ。
//
// 2026-10-23時点の実測では、MCIPには案件の読み取りAPI(`GET /api/v1/projects`、
// `GET /api/v1/projects/:code`)はあるが、全社共通の案件IDを発番・配布するAPIは無い
// (docs/architecture/platform-integration.md §6.3)。本モジュールは設定が無ければ
// 外部呼び出しを一切行わず、`not_configured` を返す。実API・実DBへは接続しない。
//
// src/ai-provider.js / src/entra-graph.js と同じ作法:
// - 設定の状態は `describe*Config(env)` で返し、秘密値は決して返さない
// - タイムアウトは `AbortSignal.timeout`、レスポンスはサイズ上限つきで読む
// - エラーは例外として投げず、秘密値を含まない構造化結果へ正規化する
//
// 重要: レスポンスの案件ID・コードは**そのまま返す**。Web-CADの `projects.id` /
// `drawings.project_id`(`prj_…`)への自動変換・書き換え・移行は行わない。
// 将来の移行規則が未確定のため(platform-integration.md §6.7)。
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 262_144;
const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 100;
const MAX_PROJECT_ID_CHARS = 128;
const MAX_CURSOR_CHARS = 512;
// MCIPの案件コードをパスセグメントとして安全に運ぶための許可文字。仕様ではなく
// 転送境界の制約であり、案件IDの意味・形式を確定するものではない。
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// ページネーションカーソルは不透明値として扱う。URLへ載せられる印字可能ASCIIのみ許可する。
const CURSOR_PATTERN = /^[\x21-\x7e]{1,512}$/;
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export const MCIP_ERROR_CODES = Object.freeze({
  NOT_CONFIGURED: "not_configured",
  INVALID_CONFIGURATION: "invalid_configuration",
  INVALID_ARGUMENT: "invalid_argument",
  TIMEOUT: "timeout",
  NETWORK: "network",
  HTTP_ERROR: "http_error",
  RESPONSE_TOO_LARGE: "response_too_large",
  INVALID_RESPONSE: "invalid_response"
});

export const MCIP_LIMITS = Object.freeze({
  timeoutMs: REQUEST_TIMEOUT_MS,
  maxResponseBytes: MAX_RESPONSE_BYTES,
  defaultListLimit: DEFAULT_LIST_LIMIT,
  maxListLimit: MAX_LIST_LIMIT,
  maxProjectIdChars: MAX_PROJECT_ID_CHARS,
  maxCursorChars: MAX_CURSOR_CHARS
});

class ResponseTooLargeError extends Error {
  constructor() {
    super("MCIP response exceeded the size limit");
    this.name = "ResponseTooLargeError";
  }
}

// 設定状態のみを返す。トークン・完全なURL(資格情報を含み得る)は返さない。
// reason: null / "missing_configuration" / "invalid_base_url" / "insecure_base_url" /
//         "credentials_in_base_url"
export function describeMcipConfig(env) {
  const baseUrl = normalize(env?.MCIP_API_BASE_URL);
  const token = normalize(env?.MCIP_API_TOKEN);
  if (!baseUrl || !token) return { enabled: false, reason: "missing_configuration", baseUrlOrigin: null };
  const parsed = parseBaseUrl(baseUrl);
  if (!parsed.ok) return { enabled: false, reason: parsed.reason, baseUrlOrigin: null };
  return { enabled: true, reason: null, baseUrlOrigin: parsed.url.origin };
}

// 設定が無い/不正でもクライアント自体は返す。各メソッドは外部呼び出しをせず
// `not_configured` / `invalid_configuration` を返す(fail-closed)。
export function createMcipClient(env, options = {}) {
  const config = describeMcipConfig(env);
  const baseUrl = config.enabled ? parseBaseUrl(normalize(env.MCIP_API_BASE_URL)).url : null;
  const token = config.enabled ? normalize(env.MCIP_API_TOKEN) : null;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = normalizeTimeout(options.timeoutMs);

  return {
    configured: config.enabled,

    // 秘密値を含まない設定状態。ログ・ヘルス応答へ出してよい。
    describe() {
      return { ...config };
    },

    async getProject(projectId) {
      if (!config.enabled) return notConfigured(config);
      if (typeof projectId !== "string" || !PROJECT_ID_PATTERN.test(projectId)) {
        return invalidArgument("projectId は 1〜128文字の案件コードである必要があります。", "projectId");
      }
      const url = new URL(`api/v1/projects/${encodeURIComponent(projectId)}`, baseUrl);
      const result = await requestJson({ url, token, fetchImpl, timeoutMs });
      if (!result.ok) return result;
      return { ok: true, projectId, payload: result.payload };
    },

    async listProjects(query) {
      if (!config.enabled) return notConfigured(config);
      const params = query === undefined ? {} : query;
      if (params === null || typeof params !== "object" || Array.isArray(params)) {
        return invalidArgument("listProjects の引数はオブジェクトである必要があります。", "query");
      }
      const limit = params.limit === undefined ? DEFAULT_LIST_LIMIT : params.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
        return invalidArgument(`limit は 1〜${MAX_LIST_LIMIT} の整数である必要があります。`, "limit");
      }
      const cursor = params.cursor === undefined ? null : params.cursor;
      if (cursor !== null && (typeof cursor !== "string" || !CURSOR_PATTERN.test(cursor))) {
        return invalidArgument(
          `cursor は 1〜${MAX_CURSOR_CHARS} 文字の印字可能ASCIIである必要があります。`,
          "cursor"
        );
      }
      const url = new URL("api/v1/projects", baseUrl);
      url.searchParams.set("limit", String(limit));
      if (cursor !== null) url.searchParams.set("cursor", cursor);
      const result = await requestJson({ url, token, fetchImpl, timeoutMs });
      if (!result.ok) return result;
      return { ok: true, query: { limit, cursor }, payload: result.payload };
    }
  };
}

async function requestJson({ url, token, fetchImpl, timeoutMs }) {
  let response;
  try {
    response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
      // リダイレクトを追うと、Authorizationヘッダを別オリジンへ送る可能性がある。
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    return transportFailure(error);
  }

  let text;
  try {
    text = await readLimitedText(response);
  } catch (error) {
    if (error instanceof ResponseTooLargeError) {
      return failure(MCIP_ERROR_CODES.RESPONSE_TOO_LARGE, "MCIP APIの応答がサイズ上限を超えました。");
    }
    return transportFailure(error);
  }

  if (!response.ok) {
    const status = normalizeStatus(response.status);
    return failure(MCIP_ERROR_CODES.HTTP_ERROR, `MCIP APIがエラーを返しました (HTTP ${status ?? "unknown"})。`, status);
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return failure(MCIP_ERROR_CODES.INVALID_RESPONSE, "MCIP APIの応答をJSONとして解析できませんでした。");
  }
  // 形(項目名)の検証は行わない。応答schemaが未提供のため、推測した項目名で
  // 案件IDを解釈・変換しない。呼び出し側が受入時に検証する。
  if (payload === null || typeof payload !== "object") {
    return failure(MCIP_ERROR_CODES.INVALID_RESPONSE, "MCIP APIの応答形式が不正です。");
  }
  return { ok: true, payload };
}

async function readLimitedText(response) {
  const reader = response?.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw new ResponseTooLargeError();
    return text;
  }
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new ResponseTooLargeError();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function transportFailure(error) {
  if (isTimeoutError(error)) {
    return failure(MCIP_ERROR_CODES.TIMEOUT, "MCIP APIへの接続がタイムアウトしました。");
  }
  // 例外のmessage・stack・URLは外へ出さない(トークンやURL資格情報を含み得るため)。
  return failure(MCIP_ERROR_CODES.NETWORK, "MCIP APIへの接続に失敗しました。");
}

function isTimeoutError(error) {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function notConfigured(config) {
  return failure(
    config.reason === "missing_configuration" ? MCIP_ERROR_CODES.NOT_CONFIGURED : MCIP_ERROR_CODES.INVALID_CONFIGURATION,
    config.reason === "missing_configuration"
      ? "MCIPのAPI設定が無いため、外部呼び出しを行いません。"
      : "MCIPのAPI設定が不正なため、外部呼び出しを行いません。"
  );
}

function invalidArgument(message, field) {
  return { ok: false, error: { code: MCIP_ERROR_CODES.INVALID_ARGUMENT, message, field } };
}

function failure(code, message, status) {
  const error = { code, message };
  if (status !== undefined) error.status = status;
  return { ok: false, error };
}

function normalizeStatus(status) {
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

function normalizeTimeout(value) {
  const timeout = Number(value);
  return Number.isFinite(timeout) && timeout > 0 ? timeout : REQUEST_TIMEOUT_MS;
}

function normalize(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// 設定値のURLを検証する。資格情報入りURL・平文HTTP(ループバック以外)・
// クエリ/ハッシュ付きのbase URLは受け付けない(fail-closed)。
function parseBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "invalid_base_url" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, reason: "invalid_base_url" };
  if (!url.hostname) return { ok: false, reason: "invalid_base_url" };
  if (url.username || url.password) return { ok: false, reason: "credentials_in_base_url" };
  if (url.search || url.hash) return { ok: false, reason: "invalid_base_url" };
  if (url.protocol === "http:" && !LOOPBACK_HOSTNAMES.has(url.hostname)) {
    return { ok: false, reason: "insecure_base_url" };
  }
  // 相対パス解決の基準を固定するため、パス末尾を "/" にそろえる。
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return { ok: true, url };
}
