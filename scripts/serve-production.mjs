// 本番用の常時稼働HTTPサーバー(systemd管理、Cloudflare Tunnel経由で公開)。
// scripts/serve-local.mjsとは意図的に分離している(理由はdocs/operations.mdおよび
// .claude/plans/参照)。ローカル開発サーバーは緩い既定値で動くが、本番はセキュリティ
// 上重要な環境変数(認証モード等)を必須化し、欠落時は起動そのものを拒否する。
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { handleApiRequest } from "../src/api-handler.js";
import { closeDataStorePool, createDataStore } from "../src/data-store.js";
import { ROLE_POLICIES } from "../src/cad-core.js";
import { DEPLOY_PROVENANCE, evaluateDeployProvenance } from "./lib/deploy-info.mjs";
import {
  CONTENT_TYPES,
  RequestBodyTooLargeError,
  STRICT_TRANSPORT_SECURITY,
  applyEdgeHeaders,
  loadHeaderRules,
  makeHeadersResolver,
  nodeRequestToFetchRequest,
  resolveStaticFile,
  toResolvedPathname,
  writeFetchResponse
} from "./lib/http-bridge.mjs";

const root = process.cwd();
const staticRoot = path.join(root, "dist");
const port = Number(process.env.PORT ?? 18812);
const host = "127.0.0.1"; // 0.0.0.0にしない。インバウンドはCloudflare Tunnelのみを経由させる
const shutdownTimeoutMs = Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 10000);

// 環境変数ファイルをシェルで`source`すると、bashは代入値の引用符を除去するため
// JSON値(ACCESS_ROLE_MAP/ENTRA_GROUP_ROLE_MAP)が壊れる(実測: 36文字→32文字、
// `{"a@b":"cad_viewer"}`が`{a@b:cad_viewer}`になる)。systemdのEnvironmentFileは
// 引用符を保持するため通常運用では問題ないが、手動起動時にこの失敗が起きやすい。
// 起動拒否はfail-closedとして正しいので変更せず、原因に気づけるヒントだけ添える。
const ENV_SOURCING_HINT =
  "環境変数ファイルをシェルでsourceするとJSON値の引用符が除去されます。systemdのEnvironmentFileを使うか、DATABASE_URL等の必要な変数だけを個別に取り出してください(docs/deployment-local.md参照)。";

const env = validateEnv();

// 稼働commitの素性検査(Issue #98の再発防止)。ネットワークへは出ず、ローカルの
// git情報だけを読む。既定は「重大警告をログに出して起動継続」(可用性優先)。
// DEPLOY_GUARD=strict を設定した場合のみ、未レビューのcommitが稼働している状態での
// 起動を拒否する(fail-closed)。本番のproduction.envへ設定するかは運用判断とする。
const deployInfo = evaluateDeployProvenance({ cwd: root });
env.DEPLOY_INFO = {
  // 配信物(dist/)のbuild元commit。デプロイでdistのsymlinkが切り替わるため、healthのたびに読む。
  distCommit: () => readDistCommit(staticRoot),
  commit: deployInfo.info.commit,
  commitShort: deployInfo.info.commitShort,
  branch: deployInfo.info.branch,
  dirty: deployInfo.info.dirty
};
log("info", "starting", {
  port,
  host,
  appEnv: env.APP_ENV,
  authMode: env.AUTH_MODE,
  deploy: { ...env.DEPLOY_INFO, provenance: deployInfo.status, ahead: deployInfo.counts?.ahead ?? null, behind: deployInfo.counts?.behind ?? null }
});
enforceDeployGuard(deployInfo);

await failFastProbe(env);

const headerRules = await loadHeaderRules(path.join(root, "_headers"));
const headersForPath = makeHeadersResolver(headerRules);

const server = createServer(async (req, res) => {
  const startedAt = Date.now();
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  try {
    if (url.pathname.startsWith("/api")) {
      const request = await nodeRequestToFetchRequest(req, url);
      const response = await handleApiRequest(request, env);
      // `_headers`の`/*`ルール(CSP等)はこれまで静的応答にしか適用されておらず、
      // API応答はCSP/HSTSが付いていなかった。APIが自前で設定したヘッダを優先し、
      // 不足分だけエッジ相当のヘッダで補う。
      applyEdgeHeaders(response.headers, headersForPath(url.pathname));
      await writeFetchResponse(res, response);
      logRequest(req, url, response.status, startedAt);
      return;
    }

    const file = await resolveStaticFile(staticRoot, url.pathname);
    if (!file) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "strict-transport-security": STRICT_TRANSPORT_SECURITY });
      res.end("not found");
      logRequest(req, url, 404, startedAt);
      return;
    }
    const ext = path.extname(file);
    const resolvedPathname = toResolvedPathname(staticRoot, file);
    res.writeHead(200, {
      "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
      "x-content-type-options": "nosniff",
      "strict-transport-security": STRICT_TRANSPORT_SECURITY,
      ...headersForPath(resolvedPathname)
    });
    res.end(await readFile(file));
    logRequest(req, url, 200, startedAt);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      if (!res.headersSent) res.writeHead(413, { "content-type": "text/plain; charset=utf-8", "strict-transport-security": STRICT_TRANSPORT_SECURITY });
      res.end("payload too large");
      logRequest(req, url, 413, startedAt);
      return;
    }
    log("error", "unhandled request error", { path: url.pathname, error: errorMessage(error) });
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8", "strict-transport-security": STRICT_TRANSPORT_SECURITY });
    res.end("internal error");
  }
});

server.listen(port, host, () => {
  log("info", "listening", { url: `http://${host}:${port}/` });
});

let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => shutdown(signal));
}
process.on("unhandledRejection", (reason) => {
  log("error", "unhandledRejection", { error: errorMessage(reason) });
  shutdown("unhandledRejection", 1);
});
process.on("uncaughtException", (error) => {
  log("error", "uncaughtException", { error: errorMessage(error) });
  shutdown("uncaughtException", 1);
});

async function shutdown(reason, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", "shutting down", { reason });
  const timer = setTimeout(() => {
    log("warn", "shutdown timeout exceeded, forcing exit", { shutdownTimeoutMs });
    process.exit(exitCode || 1);
  }, shutdownTimeoutMs);
  timer.unref();
  server.close(async () => {
    try {
      await closeDataStorePool();
    } catch (error) {
      log("error", "error closing data store pool", { error: errorMessage(error) });
    } finally {
      clearTimeout(timer);
      process.exit(exitCode);
    }
  });
  if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();
}

function validateEnv() {
  const missing = [];
  const databaseUrl = requireEnv("DATABASE_URL", missing);
  const appEnv = process.env.APP_ENV;
  if (appEnv !== "production") missing.push("APP_ENV(must be 'production')");
  const authMode = process.env.AUTH_MODE;
  if (authMode !== "access") missing.push("AUTH_MODE(must be 'access', not 'demo')");
  const cfAccessTeamDomain = requireEnv("CF_ACCESS_TEAM_DOMAIN", missing);
  const cfAccessAud = requireEnv("CF_ACCESS_AUD", missing);
  const corsOrigin = requireEnv("CORS_ORIGIN", missing);
  const accessRoleMapRaw = requireEnv("ACCESS_ROLE_MAP", missing);

  const aiProvider = process.env.AI_PROVIDER;
  if (aiProvider !== undefined && aiProvider !== "openai" && aiProvider !== "anthropic") {
    missing.push("AI_PROVIDER(must be 'openai' or 'anthropic' if set)");
  }
  if (aiProvider === "openai" && !process.env.OPENAI_API_KEY) missing.push("OPENAI_API_KEY(required when AI_PROVIDER=openai)");
  if (aiProvider === "anthropic" && !process.env.ANTHROPIC_API_KEY) missing.push("ANTHROPIC_API_KEY(required when AI_PROVIDER=anthropic)");
  if (aiProvider && !process.env.AI_MODEL) missing.push("AI_MODEL(required when AI_PROVIDER is set)");

  // Entra IDグループ同期(任意、Issue #5)。3変数のうち1つでも設定されていれば全て必須にする
  // (中途半端な設定のまま起動し、グループ解決だけ静かに無効なままになるのを防ぐ)。
  const entraVars = ["ENTRA_TENANT_ID", "ENTRA_CLIENT_ID", "ENTRA_CLIENT_SECRET"];
  const entraSet = entraVars.filter((name) => process.env[name]);
  if (entraSet.length > 0 && entraSet.length < entraVars.length) {
    missing.push(`${entraVars.filter((name) => !process.env[name]).join(", ")}(ENTRA_*を使う場合は${entraVars.join("/")}が全て必須)`);
  }

  if (missing.length > 0) {
    log("error", "missing or invalid required environment variables, refusing to start", { missing });
    process.exit(78); // EX_CONFIG
  }

  let accessRoleMap;
  try {
    accessRoleMap = JSON.parse(accessRoleMapRaw);
  } catch (error) {
    log("error", "ACCESS_ROLE_MAP is not valid JSON, refusing to start", { error: errorMessage(error), hint: ENV_SOURCING_HINT });
    process.exit(78);
  }
  if (!accessRoleMap || typeof accessRoleMap !== "object" || Array.isArray(accessRoleMap)) {
    log("error", "ACCESS_ROLE_MAP must be a JSON object, refusing to start");
    process.exit(78);
  }
  const unknownRoles = Object.entries(accessRoleMap).filter(([, role]) => !ROLE_POLICIES[role]);
  if (unknownRoles.length > 0) {
    // メールアドレス(個人識別子)はログへ残さない。件数と不正なロール名のみ出力する。
    log("error", "ACCESS_ROLE_MAP contains unknown roles, refusing to start", {
      unknownCount: unknownRoles.length,
      unknownRoleValues: [...new Set(unknownRoles.map(([, role]) => role))]
    });
    process.exit(78);
  }

  const entraGroupRoleMapRaw = process.env.ENTRA_GROUP_ROLE_MAP;
  if (entraGroupRoleMapRaw) {
    let entraGroupRoleMap;
    try {
      entraGroupRoleMap = JSON.parse(entraGroupRoleMapRaw);
    } catch (error) {
      log("error", "ENTRA_GROUP_ROLE_MAP is not valid JSON, refusing to start", { error: errorMessage(error), hint: ENV_SOURCING_HINT });
      process.exit(78);
    }
    if (!entraGroupRoleMap || typeof entraGroupRoleMap !== "object" || Array.isArray(entraGroupRoleMap)) {
      log("error", "ENTRA_GROUP_ROLE_MAP must be a JSON object, refusing to start");
      process.exit(78);
    }
    // グループGUIDは個人識別子ではないため、不正な値はログへ含めてよい。
    const unknownGroupRoles = Object.entries(entraGroupRoleMap).filter(([, role]) => !ROLE_POLICIES[role]);
    if (unknownGroupRoles.length > 0) {
      log("error", "ENTRA_GROUP_ROLE_MAP contains unknown roles, refusing to start", {
        unknownEntries: unknownGroupRoles
      });
      process.exit(78);
    }
  }

  // ACCESS_DEFAULT_ROLEは、メール個別指定にもEntraグループにも一致しない全利用者へ
  // 適用されるロール。ACCESS_ROLE_MAP/ENTRA_GROUP_ROLE_MAPと同じ検証を掛けないと、
  // 「有効だが強すぎるロール」(例: cad_admin)が1行の設定ミスで全社員へ静かに適用される。
  const accessDefaultRole = process.env.ACCESS_DEFAULT_ROLE;
  if (accessDefaultRole && !ROLE_POLICIES[accessDefaultRole]) {
    log("error", "ACCESS_DEFAULT_ROLE is not a known role, refusing to start", { unknownRole: accessDefaultRole });
    process.exit(78);
  }
  if (accessDefaultRole && accessDefaultRole !== "viewer") {
    log("warn", "ACCESS_DEFAULT_ROLE grants a role above viewer to every unmapped user", { role: accessDefaultRole });
  }

  return {
    AUTH_MODE: authMode,
    APP_ENV: appEnv,
    DATABASE_URL: databaseUrl,
    ACCESS_ROLE_MAP: accessRoleMapRaw,
    ACCESS_DEFAULT_ROLE: accessDefaultRole,
    CF_ACCESS_TEAM_DOMAIN: cfAccessTeamDomain,
    CF_ACCESS_AUD: cfAccessAud,
    CORS_ORIGIN: corsOrigin,
    AI_PROVIDER: aiProvider,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    AI_MODEL: process.env.AI_MODEL,
    AI_RATE_LIMIT_PER_MINUTE: process.env.AI_RATE_LIMIT_PER_MINUTE,
    // api-handlerはenv.WRITE_RATE_LIMIT_PER_MINUTEを読む実装済みだが、ここで転送して
    // いなかったため production.env に書いても反映されなかった(docsの記載と不一致)。
    WRITE_RATE_LIMIT_PER_MINUTE: process.env.WRITE_RATE_LIMIT_PER_MINUTE,
    ENTRA_TENANT_ID: process.env.ENTRA_TENANT_ID,
    ENTRA_CLIENT_ID: process.env.ENTRA_CLIENT_ID,
    ENTRA_CLIENT_SECRET: process.env.ENTRA_CLIENT_SECRET,
    ENTRA_GROUP_ROLE_MAP: entraGroupRoleMapRaw,
    ENTRA_GROUP_CACHE_TTL_MINUTES: process.env.ENTRA_GROUP_CACHE_TTL_MINUTES
  };
}

function requireEnv(name, missing) {
  const value = process.env[name];
  if (!value) {
    missing.push(name);
    return undefined;
  }
  return value;
}

// 稼働素性がorigin/mainと乖離している場合の扱いを決める。
// - 既定(warn): 重大警告をログへ残し、起動は継続する。可用性を落とさないため。
// - strict: 未レビューのcommitが稼働している状態での起動を拒否する(EX_CONFIG=78)。
// 「本番で何が動いているか分からない」状態を検知可能にするのが目的であり、
// 検知そのものが業務を止めないよう既定は継続とする(docs/operations.md参照)。
function readDistCommit(distRoot) {
  try {
    const info = JSON.parse(readFileSync(path.join(distRoot, "build-info.json"), "utf8"));
    return typeof info.commit === "string" ? info.commit : null;
  } catch {
    return null;
  }
}

function enforceDeployGuard(deploy) {
  const detail = {
    provenance: deploy.status,
    commit: deploy.info.commit,
    branch: deploy.info.branch,
    dirty: deploy.info.dirty,
    ahead: deploy.counts?.ahead ?? null,
    reasons: deploy.reasons
  };
  if (deploy.status === DEPLOY_PROVENANCE.UNKNOWN) {
    // 判定できないこと自体は起動を止めないが、「一致」と誤解されないよう必ず記録する。
    log("warn", "deploy provenance guard: cannot determine provenance (origin/main ref may be missing)", detail);
    return;
  }
  const drifted = deploy.status === DEPLOY_PROVENANCE.AHEAD || deploy.status === DEPLOY_PROVENANCE.DIRTY;
  if (!drifted) return;
  if (process.env.DEPLOY_GUARD === "strict") {
    log("error", "deploy provenance guard: refusing to start with unreviewed code", detail);
    process.exit(78); // EX_CONFIG
  }
  log("error", "deploy provenance guard: running code is not origin/main (set DEPLOY_GUARD=strict to refuse startup)", detail);
}

async function failFastProbe(currentEnv) {
  const store = createDataStore(currentEnv);
  try {
    const probe = await store.probe();
    if (probe.mode !== "connected" || probe.migrated !== true) {
      log("error", "database probe failed at startup, refusing to start", { probe });
      process.exit(1);
    }
    log("info", "database probe ok", { database: probe.database, migrated: probe.migrated });
  } catch (error) {
    log("error", "database probe threw at startup, refusing to start", { error: errorMessage(error) });
    process.exit(1);
  }
}

function logRequest(req, url, status, startedAt) {
  log("info", "request", {
    method: req.method,
    path: url.pathname,
    status,
    durationMs: Date.now() - startedAt
  });
}

function log(level, msg, fields = {}) {
  // 接続文字列・JWT・Cookie・リクエストボディは絶対にログしない。呼び出し側で
  // そうしたフィールドを渡さないこと。
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
