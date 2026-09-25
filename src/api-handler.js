import {
  ROLE_POLICIES,
  applyTransaction,
  approveDrawing,
  buildAiProposal,
  createDrawing,
  createNewVersion,
  proposalToTransaction,
  seedDrawing,
  submitForReview,
  validateDrawing
} from "./cad-core.js";
import { createDataStore, resetMemoryStoreData, LEGACY_PROJECT_ID } from "./data-store.js";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { describeAiConfig, createAiCompletion } from "./ai-provider.js";
import { COMMAND_SCHEMA, buildSystemPrompt, buildUserMessage, normalizeLlmProposal } from "./ai-proposal.js";
import { createEntraGroupResolver } from "./entra-graph.js";

// 複数のEntra IDグループが異なるロールへマッピングされている利用者がいた場合の優先順位。
// 最も権限の強いロールを採用する(誤って過小権限になり業務が止まる方を避けるため)。
// ACCESS_ROLE_MAPによる個別メール指定は常にこれより優先される(resolveActor参照)。
const ROLE_PRECEDENCE = ["cad_admin", "approver", "reviewer", "drafter", "viewer"];

// API応答でも使うセキュリティヘッダ。Cloudflare Pages Functionsの応答には
// `_headers`のルールが適用されない(実測: pr-102の/api/healthにCSP/HSTSが付かない)ため、
// API側でも同じ値を持つ必要がある。`_headers`との値の一致はテストで検証する
// (tests/api-hardening.test.js)。
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; style-src 'self'; img-src 'self' data: blob:; connect-src 'self' https://cloudflareinsights.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
export const STRICT_TRANSPORT_SECURITY = "max-age=63072000; includeSubDomains; preload";

export const API_SECURITY_HEADERS = {
  "content-security-policy": CONTENT_SECURITY_POLICY,
  "strict-transport-security": STRICT_TRANSPORT_SECURITY,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "x-frame-options": "DENY"
};

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  ...API_SECURITY_HEADERS
};

const MAX_JSON_BYTES = 1_048_576;
// 1リクエストで適用できるコマンド数の上限。ユーザー経路にはLLM経路(MAX_LLM_COMMANDS)の
// ような上限が無く、巨大な配列を1回で送ると全利用者の描画・保存が遅くなるため設ける。
const MAX_TRANSACTION_COMMANDS = 500;
// applyTransaction(cad-core.js)が解釈するopの一覧。ここに無いopは「未知の操作として
// 黙って無視される」ため、入力境界で拒否する(200を返しつつ何も起きない状態を防ぐ)。
const ALLOWED_TRANSACTION_OPS = new Set([
  "add",
  "add_comment",
  "add_layer",
  "delete",
  "delete_layer",
  "delete_selection",
  "save_selection",
  "set_block_resources",
  "set_empty_drawing_unit",
  "update",
  "update_drawing_meta",
  "update_layer",
  "update_layout"
]);
// 1コマンドあたりの点列長の上限。全体はMAX_JSON_BYTESでも抑えているが、
// 巨大な点列による計算量増大を入力境界で止める。
const MAX_COMMAND_POINTS = 10_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
// 追跡する利用者数(バケット×利用者)の上限。超えた場合は期限切れ→最も古い順に破棄する。
const RATE_LIMIT_MAX_ENTRIES = 10_000;
const WRITE_RATE_LIMIT_PER_MINUTE = 240;
// 利用者ごとのリクエスト時刻。キーは `${bucket}:${actorId}`。
const rateLimitState = new Map();

export async function handleApiRequest(request, env = {}) {
  const store = createDataStore(env);
  const url = new URL(request.url);
  const startedAt = Date.now();
  const route = normalizeRoute(url.pathname);
  const requestId = request.headers.get("x-request-id")?.slice(0, 100) ?? `req_${cryptoSafeId()}`;
  const cors = corsHeaders(env, requestId, request.headers.get("origin"));

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  try {
    const actor = await resolveActor(request, env, isPublicReadRoute(request.method, route));
    if (!actor.ok) return json({ ok: false, error: actor.error }, 401, cors);

    // 更新系の濫用対策。AI提案だけが制限されており、図面更新・案件操作・監査出力は
    // 無制限だった(暴走クライアントや意図的な連打で全利用者が影響を受ける)。
    // 公開読み取り(health/demo)とOPTIONSは対象外。
    if (isMutatingMethod(request.method) && !isPublicReadRoute(request.method, route)) {
      enforceRateLimit("write", actor.actor.id, writeRateLimit(env),
        "更新リクエストの回数が上限に達しました。しばらくしてから再試行してください。");
    }

    if (request.method === "GET" && route === "/health") {
      const db = await store.probe();
      const dbHealthy = (db.mode === "connected" && db.migrated === true) || db.mode === "memory-preview";
      return json(
        {
          ok: dbHealthy,
          status: dbHealthy ? "ok" : "degraded",
          service: "mirai-web-cad-api",
          version: "0.1.0",
          timestamp: new Date().toISOString(),
          auth: {
            mode: authMode(env),
            actor: actor.actor.id,
            role: actor.actor.role,
            anonymous: actor.actor.anonymous === true
          },
          db: actor.actor.anonymous ? sanitizeProbe(db) : db,
          deploy: deployProvenance(env),
          durationMs: Date.now() - startedAt
        },
        dbHealthy ? 200 : 503,
        cors
      );
    }

    if (request.method === "GET" && route === "/drawings/demo") {
      const drawing = actor.actor.anonymous
        ? await getPublicDrawing(store, "dwg_demo_001")
        : await getDrawing(store, "dwg_demo_001");
      return json({ ok: true, drawing }, 200, cors);
    }

    if (request.method === "POST" && route === "/drawings") {
      authorize(actor.actor, "canEdit");
      const idempotencyKey = requireIdempotency(request);
      await rejectClaimedIdempotency(store, idempotencyKey);
      const body = await readJson(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw httpError("JSON本文はオブジェクトである必要があります。", 400);
      }
      const projectId = typeof body.projectId === "string" && body.projectId.trim() ? body.projectId.trim() : LEGACY_PROJECT_ID;
      const project = await store.getProject(projectId);
      if (!project) throw httpError(`案件が見つかりません: ${projectId}`, 404);
      await requireProjectAccess(store, actor.actor, projectId);
      const drawing = body.template === "demo" ? seedDrawing() : createDrawing();
      drawing.id = typeof body.id === "string" && /^dwg_[a-z0-9_-]{1,60}$/i.test(body.id) ? body.id : `dwg_${cryptoSafeId()}`;
      drawing.name = typeof body.name === "string" ? body.name.trim().slice(0, 100) || "新規図面" : "新規図面";
      drawing.unit = ["mm", "m"].includes(body.unit) ? body.unit : "mm";
      drawing.currentRole = actor.actor.role;
      const created = await store.createDrawingAtomically(
        drawing,
        createAuditEntry(actor.actor, "drawing.created", "drawing", drawing.id, { name: drawing.name, projectId }),
        idempotencyKey,
        actor.actor.id,
        route,
        projectId
      );
      if (!created) throw httpError("同じIdempotency-Keyまたは図面IDは処理済みです。", 409);
      return json({ ok: true, drawing }, 201, cors);
    }

    const drawingMatch = route.match(/^\/drawings\/([^/]+)$/);
    if (request.method === "GET" && drawingMatch) {
      await requireDrawingAccess(store, actor.actor, drawingMatch[1]);
      return json({ ok: true, drawing: await getDrawing(store, drawingMatch[1]) }, 200, cors);
    }

    const transactionMatch = route.match(/^\/drawings\/([^/]+)\/transactions$/);
    if (request.method === "POST" && transactionMatch) {
      authorize(actor.actor, "canEdit");
      await requireDrawingAccess(store, actor.actor, transactionMatch[1]);
      const drawing = withActor(await getDrawing(store, transactionMatch[1]), actor.actor);
      const body = await readJson(request);
      const commands = requireTransactionCommands(body);
      const idempotencyKey = requireIdempotency(request);
      await rejectClaimedIdempotency(store, idempotencyKey);
      requireExpectedVersion(request, drawing);
      const result = applyTransaction(drawing, {
        source: "user",
        actor: actor.actor.id,
        label: body.label ?? "API transaction",
        commands
      });
      if (!result.ok) return json({ ok: false, error: result.error }, 409, cors);
      // 構造不正(invalid-geometry/critical)は「今回の更新で新たに生じたもの」を保存前に拒否する。
      // applyTransactionはcommand.entityを無検証でpushするためpointsの無いline等を保存でき、
      // その後の承認(validateDrawing)が例外→500となり、図面が削除以外で復旧不能になっていた。
      const introduced = findIntroducedGeometryIssues(drawing, result.drawing);
      if (introduced.length > 0) {
        return json({ ok: false, error: `図形が不正なため保存できません: ${introduced[0].message}`, issues: introduced }, 400, cors);
      }
      await saveMutationAtomically(store, result.drawing, actor.actor, "drawing.transaction", drawing.id, { label: body.label }, idempotencyKey, route);
      return json({ ok: true, drawing: result.drawing, warnings: result.warnings }, 200, cors);
    }

    const commentsMatch = route.match(/^\/drawings\/([^/]+)\/comments$/);
    if (request.method === "POST" && commentsMatch) {
      authorize(actor.actor, "canComment");
      await requireDrawingAccess(store, actor.actor, commentsMatch[1]);
      const drawing = withActor(await getDrawing(store, commentsMatch[1]), actor.actor);
      const body = await readJson(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw httpError("JSON本文はオブジェクトである必要があります。", 400);
      }
      const idempotencyKey = requireIdempotency(request);
      await rejectClaimedIdempotency(store, idempotencyKey);
      requireExpectedVersion(request, drawing);
      const result = applyTransaction(drawing, {
        source: "user",
        actor: actor.actor.id,
        label: "コメント追加",
        commands: [{ op: "add_comment", body: body.body, entityId: body.entityId ?? null }]
      });
      if (!result.ok) return json({ ok: false, error: result.error }, 409, cors);
      const comment = result.drawing.comments.at(-1);
      await saveMutationAtomically(
        store,
        result.drawing,
        actor.actor,
        "comment.added",
        drawing.id,
        { commentId: comment.id, entityId: comment.entityId },
        idempotencyKey,
        route
      );
      return json({ ok: true, drawing: result.drawing, warnings: result.warnings }, 201, cors);
    }

    const agentMatch = route.match(/^\/drawings\/([^/]+)\/agent-runs$/);
    if (request.method === "POST" && agentMatch) {
      authorize(actor.actor, "canRunAi");
      await requireDrawingAccess(store, actor.actor, agentMatch[1]);
      const drawing = withActor(await getDrawing(store, agentMatch[1]), actor.actor);
      const body = await readJson(request);
      const prompt = typeof body.prompt === "string" ? body.prompt : "";
      let proposal = buildAiProposal(drawing, prompt);
      let engine = "rule";
      let provider = null;
      let model = null;
      if (proposal.status === "needs_input" && prompt.trim()) {
        const complete = env.AI_COMPLETION ?? createAiCompletion(env);
        if (complete) {
          checkAiRateLimit(env, actor.actor.id);
          const config = describeAiConfig(env);
          provider = config.provider;
          model = config.model;
          try {
            const raw = await complete(buildSystemPrompt(drawing), buildUserMessage(prompt), COMMAND_SCHEMA);
            proposal = normalizeLlmProposal(drawing, raw, { provider, model });
            engine = "llm";
          } catch {
            // fail-soft: LLM障害時もルールベースのneeds_inputのまま返す
          }
        }
      }
      const run = {
        id: `run_${cryptoSafeId()}`,
        drawingId: drawing.id,
        status: proposal.status,
        prompt,
        proposal,
        createdBy: actor.actor.id,
        createdAt: new Date().toISOString()
      };
      await store.saveAgentRun(run);
      await audit(store, actor.actor, "agent.planned", "agent_run", run.id, {
        status: run.status,
        engine,
        provider,
        model,
        promptChars: prompt.length
      });
      return json({ ok: true, run }, proposal.status === "planned" ? 201 : 202, cors);
    }

    const approveAgentMatch = route.match(/^\/agent-runs\/([^/]+)\/approve$/);
    if (request.method === "POST" && approveAgentMatch) {
      authorize(actor.actor, "canEdit");
      const idempotencyKey = requireIdempotency(request);
      await rejectClaimedIdempotency(store, idempotencyKey);
      await readJson(request);
      const run = await getAgentRun(store, approveAgentMatch[1]);
      if (run.proposal.status !== "planned") {
        return json({ ok: false, error: "適用可能なAI提案ではありません。" }, 409, cors);
      }
      await requireDrawingAccess(store, actor.actor, run.drawingId);
      const drawing = withActor(await getDrawing(store, run.drawingId), actor.actor);
      requireExpectedVersion(request, drawing);
      const result = applyTransaction(drawing, proposalToTransaction(run.proposal, actor.actor.id));
      if (!result.ok) return json({ ok: false, error: result.error }, 409, cors);
      run.status = "completed";
      await saveMutationAtomically(
        store,
        result.drawing,
        actor.actor,
        "agent.approved",
        drawing.id,
        { runId: run.id },
        idempotencyKey,
        route,
        run
      );
      return json({ ok: true, drawing: result.drawing, run }, 200, cors);
    }

    const reviewMatch = route.match(/^\/drawings\/([^/]+)\/review$/);
    if (request.method === "POST" && reviewMatch) {
      await requireDrawingAccess(store, actor.actor, reviewMatch[1]);
      const drawing = withActor(await getDrawing(store, reviewMatch[1]), actor.actor);
      const body = await readJson(request);
      if (body.action === "submit") authorize(actor.actor, "canEdit");
      else if (body.action === "approve" || body.action === "new_version") authorize(actor.actor, "canApprove");
      else return json({ ok: false, error: "review actionが不正です。" }, 400, cors);
      const idempotencyKey = requireIdempotency(request);
      await rejectClaimedIdempotency(store, idempotencyKey);
      requireExpectedVersion(request, drawing);
      if (body.action === "submit") {
        if (!["draft", "rejected"].includes(drawing.state)) {
          return json({ ok: false, error: "下書きまたは差戻し図面だけをレビュー提出できます。" }, 409, cors);
        }
        const next = submitForReview(drawing, actor.actor.id);
        await saveMutationAtomically(store, next, actor.actor, "review.submitted", drawing.id, {}, idempotencyKey, route);
        return json({ ok: true, drawing: next }, 200, cors);
      }
      if (body.action === "approve") {
        const result = approveDrawing(drawing, actor.actor.id);
        if (!result.ok) return json({ ok: false, error: result.error, issues: validateDrawing(drawing) }, 409, cors);
        await saveMutationAtomically(store, result.drawing, actor.actor, "review.approved", drawing.id, {}, idempotencyKey, route);
        return json({ ok: true, drawing: result.drawing }, 200, cors);
      }
      if (body.action === "new_version") {
        if (drawing.state !== "approved") {
          return json({ ok: false, error: "承認済み図面からのみ新版を作成できます。" }, 409, cors);
        }
        const next = createNewVersion(drawing, actor.actor.id);
        await saveMutationAtomically(store, next, actor.actor, "drawing.version.created", drawing.id, {}, idempotencyKey, route);
        return json({ ok: true, drawing: next }, 200, cors);
      }
    }

    if (request.method === "GET" && route === "/audit-logs") {
      authorize(actor.actor, "canApprove");
      const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get("limit")) || 100));
      const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
      const auditLogs = await store.listAuditLogs(limit, offset);
      const total = typeof store.countAuditLogs === "function" ? await store.countAuditLogs() : null;
      return json({ ok: true, auditLogs, limit, offset, total }, 200, cors);
    }

    // 監査CSVの出力。GETで状態変更(監査行の追記)を行うと、CORSのsimple requestとして
    // 扱われるためクロスサイトの<img>/<link>から被害者の名前で`audit.exported`を追記でき、
    // 監査証跡を汚染・誤帰属させ得る。POST+application/jsonを必須にしてpreflightを発生させ、
    // ブラウザ経由のクロスサイト実行を成立させない。
    if (request.method === "POST" && route === "/audit-logs/export") {
      authorize(actor.actor, "canApprove");
      if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
        throw httpError("content-type: application/jsonが必要です。", 415);
      }
      const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get("limit")) || 100));
      const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
      const auditLogs = await store.listAuditLogs(limit, offset);
      await audit(store, actor.actor, "audit.exported", "audit_logs", "bulk", { count: auditLogs.length, limit, offset });
      return new Response(auditLogsToCsv(auditLogs), {
        status: 200,
        headers: {
          ...cors,
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="audit-logs-${new Date().toISOString().slice(0, 10)}.csv"`,
          "cache-control": "no-store"
        }
      });
    }

    if (request.method === "GET" && route === "/ai/status") {
      authorize(actor.actor, "canRunAi");
      const status = describeAiConfig(env);
      return json({ ok: true, ...status }, 200, cors);
    }

    if (request.method === "POST" && route === "/projects") {
      requireCadAdmin(actor.actor);
      const idempotencyKey = requireIdempotency(request);
      // 冪等キーの予約は本文検証の「後」に行う。先に予約すると、本文不備で400を返した
      // リクエストがキーを焼き切ってしまい、同じキーでの正しい再送が恒久的に409になる。
      await rejectClaimedIdempotency(store, idempotencyKey);
      const body = await readJson(request);
      if (!body || typeof body.name !== "string" || !body.name.trim()) {
        throw httpError("案件名(name)が必要です。", 400);
      }
      if (!(await store.claimIdempotency(idempotencyKey, actor.actor.id, route))) {
        throw httpError("同じIdempotency-Keyのリクエストは処理済みです。", 409);
      }
      try {
        const id = typeof body.id === "string" && /^prj_[a-z0-9_-]{1,60}$/i.test(body.id) ? body.id : `prj_${cryptoSafeId()}`;
        const accessScope = body.accessScope === "restricted" ? "restricted" : "open";
        const project = await store.createProject({ id, name: body.name.trim().slice(0, 100), owner: actor.actor.id, accessScope });
        if (!project) throw httpError(`案件IDは既に使用されています: ${id}`, 409);
        await audit(store, actor.actor, "project.created", "project", project.id, { name: project.name, accessScope });
        return json({ ok: true, project }, 201, cors);
      } catch (error) {
        await releaseIdempotencyQuietly(store, idempotencyKey);
        throw error;
      }
    }

    const projectMatch = route.match(/^\/projects\/([^/]+)$/);
    if (request.method === "GET" && projectMatch) {
      requireCadAdmin(actor.actor);
      const project = await store.getProject(projectMatch[1]);
      if (!project) throw httpError(`案件が見つかりません: ${projectMatch[1]}`, 404);
      const members = await store.listProjectMembers(projectMatch[1]);
      return json({ ok: true, project, members }, 200, cors);
    }
    if (request.method === "PATCH" && projectMatch) {
      requireCadAdmin(actor.actor);
      const idempotencyKey = requireIdempotency(request);
      await rejectClaimedIdempotency(store, idempotencyKey);
      const body = await readJson(request);
      if (body.accessScope !== "open" && body.accessScope !== "restricted") {
        throw httpError("accessScopeはopenまたはrestrictedである必要があります。", 400);
      }
      if (!(await store.claimIdempotency(idempotencyKey, actor.actor.id, route))) {
        throw httpError("同じIdempotency-Keyのリクエストは処理済みです。", 409);
      }
      try {
        const project = await store.updateProjectAccessScope(projectMatch[1], body.accessScope);
        if (!project) throw httpError(`案件が見つかりません: ${projectMatch[1]}`, 404);
        await audit(store, actor.actor, "project.updated", "project", project.id, { accessScope: project.accessScope });
        return json({ ok: true, project }, 200, cors);
      } catch (error) {
        await releaseIdempotencyQuietly(store, idempotencyKey);
        throw error;
      }
    }

    const projectMembersMatch = route.match(/^\/projects\/([^/]+)\/members$/);
    if (request.method === "POST" && projectMembersMatch) {
      requireCadAdmin(actor.actor);
      const idempotencyKey = requireIdempotency(request);
      await rejectClaimedIdempotency(store, idempotencyKey);
      const body = await readJson(request);
      if (typeof body.member !== "string" || !body.member.includes("@")) {
        throw httpError("member(メールアドレス)が必要です。", 400);
      }
      if (!(await store.claimIdempotency(idempotencyKey, actor.actor.id, route))) {
        throw httpError("同じIdempotency-Keyのリクエストは処理済みです。", 409);
      }
      try {
        const project = await store.getProject(projectMembersMatch[1]);
        if (!project) throw httpError(`案件が見つかりません: ${projectMembersMatch[1]}`, 404);
        await store.addProjectMember(projectMembersMatch[1], body.member, actor.actor.id);
        await audit(store, actor.actor, "project.member.added", "project", projectMembersMatch[1], { member: body.member.toLowerCase() });
        const members = await store.listProjectMembers(projectMembersMatch[1]);
        return json({ ok: true, members }, 201, cors);
      } catch (error) {
        await releaseIdempotencyQuietly(store, idempotencyKey);
        throw error;
      }
    }

    const projectMemberMatch = route.match(/^\/projects\/([^/]+)\/members\/([^/]+)$/);
    if (request.method === "DELETE" && projectMemberMatch) {
      requireCadAdmin(actor.actor);
      const project = await store.getProject(projectMemberMatch[1]);
      if (!project) throw httpError(`案件が見つかりません: ${projectMemberMatch[1]}`, 404);
      const member = decodeURIComponent(projectMemberMatch[2]);
      await store.removeProjectMember(projectMemberMatch[1], member);
      await audit(store, actor.actor, "project.member.removed", "project", projectMemberMatch[1], { member: member.toLowerCase() });
      const members = await store.listProjectMembers(projectMemberMatch[1]);
      return json({ ok: true, members }, 200, cors);
    }

    return json({ ok: false, error: "not found" }, 404, cors);
  } catch (error) {
    const status = error instanceof Error && "status" in error ? Number(error.status) : 500;
    if (status >= 500) console.error(`[${requestId}] API request failed`, error);
    // 5xx の詳細は「ローカル開発(demo認証)」以外では必ず伏せる。以前は
    // APP_ENV==="production" のときだけ伏せていたため、preview等の公開環境で
    // DB接続エラーの原文(接続先ユーザー名など)が未認証クライアントへ返っていた。
    const mayExposeInternal = authMode(env) === "demo" && env.APP_ENV !== "production";
    const message = status >= 500 && !mayExposeInternal ? "internal error" : error instanceof Error ? error.message : "internal error";

    return json({ ok: false, error: message }, status, cors);
  }
}

export function resetMemoryStore() {
  resetMemoryStoreData();
  // レート制限の状態はプロセス内メモリに残るため、テスト用リセットで必ず一緒に消す
  // (消し忘れるとテスト間で回数が積み上がり、順序依存の失敗になる)。
  rateLimitState.clear();
}

async function resolveActor(request, env, allowAnonymous = false) {
  const mode = authMode(env);
  if (mode === "demo") {
    // APP_ENV=production でdemoが有効なのは設定ミスであり、ヘッダー自己申告で
    // 任意ロールになれる状態を意味する。可用性より安全側に倒して拒否する。
    if (env.APP_ENV === "production") {
      return { ok: false, error: "本番環境ではデモ認証を利用できません。" };
    }
    const role = request.headers.get("x-demo-role") ?? "drafter";
    if (!ROLE_POLICIES[role]) return { ok: false, error: "不正なデモ権限です。" };
    return { ok: true, actor: { id: request.headers.get("x-demo-actor") ?? "demo@example.com", role } };
  }

  const accessJwt = request.headers.get("cf-access-jwt-assertion");
  if (!accessJwt) {
    if (allowAnonymous) {
      return { ok: true, actor: { id: "anonymous", role: "viewer", anonymous: true } };
    }
    return { ok: false, error: "Cloudflare Access認証情報を確認できません。" };
  }
  let claims;
  try {
    claims = env.ACCESS_JWT_VERIFIER
      ? await env.ACCESS_JWT_VERIFIER(accessJwt)
      : await verifyAccessJwt(accessJwt, env);
  } catch {
    return { ok: false, error: "Cloudflare Access JWTを検証できません。" };
  }
  const jwtEmail = claims.email;
  if (typeof jwtEmail !== "string" || !jwtEmail.includes("@")) {
    return { ok: false, error: "Cloudflare Access JWTにemail claimがありません。" };
  }
  const roleMap = parseRoleMap(env.ACCESS_ROLE_MAP);
  let role = roleMap[jwtEmail.toLowerCase()];
  if (!role) {
    role = await resolveRoleFromEntraGroups(jwtEmail, env);
  }
  role = role ?? env.ACCESS_DEFAULT_ROLE ?? "viewer";
  if (!ROLE_POLICIES[role]) return { ok: false, error: "Access権限設定が不正です。" };
  return { ok: true, actor: { id: jwtEmail, role } };
}

// ACCESS_ROLE_MAP(メール直接指定)に一致しない利用者について、Entra IDのグループ所属を
// ENTRA_GROUP_ROLE_MAP(グループGUID→ロール)で引く。Entra解決が未設定/失敗/無一致の
// 場合はundefinedを返し、呼び出し元でACCESS_DEFAULT_ROLE(既定viewer)へfail-closedに
// 縮退させる(権限を誤って昇格させない)。
async function resolveRoleFromEntraGroups(email, env) {
  const resolveGroups = env.ENTRA_GROUP_RESOLVER ?? createEntraGroupResolver(env);
  if (!resolveGroups) return undefined;
  const groupIds = await resolveGroups(email);
  if (!Array.isArray(groupIds) || groupIds.length === 0) return undefined;
  const groupRoleMap = parseRoleMap(env.ENTRA_GROUP_ROLE_MAP);
  const matchedRoles = new Set(groupIds.map((id) => groupRoleMap[id]).filter((role) => ROLE_POLICIES[role]));
  for (const role of ROLE_PRECEDENCE) {
    if (matchedRoles.has(role)) return role;
  }
  return undefined;
}

async function verifyAccessJwt(token, env) {
  if (!env.CF_ACCESS_TEAM_DOMAIN || !env.CF_ACCESS_AUD) {
    throw new Error("Access JWT verifier configuration is missing");
  }
  const issuer = `https://${env.CF_ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
  const jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  const { payload } = await jwtVerify(token, jwks, {
    issuer,
    audience: env.CF_ACCESS_AUD
  });
  return payload;
}

function parseRoleMap(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function authMode(env) {
  // fail-closed: 明示的に"access"/"demo"が設定されている場合のみその値を使う。
  // 未設定・タイポ・想定外の値は"access"(Cloudflare Access JWT必須)へ倒す。
  // 以前は未設定時にAPP_ENV!=="production"なら"demo"へ倒していたため、
  // AUTH_MODEを設定し忘れた環境(例: Pages preview)が「x-demo-roleヘッダーを
  // 自己申告するだけで最強ロールになれる」状態で公開され得た。
  if (env.AUTH_MODE === "demo" || env.AUTH_MODE === "access") return env.AUTH_MODE;
  return "access";
}

function checkAiRateLimit(env, actorId) {
  enforceRateLimit("ai", actorId, aiRateLimit(env), "AI提案のリクエスト回数が上限に達しました。しばらくしてから再試行してください。");
}

function aiRateLimit(env) {
  const configured = Number(env.AI_RATE_LIMIT_PER_MINUTE);
  return Number.isFinite(configured) && configured > 0 ? configured : 10;
}

// 更新系(POST/PATCH/DELETE)の既定上限。1リクエストで最大500コマンドを送れるため、
// 要求数としては粗い。通常操作で引っかからない値にしつつ、暴走を止められる値にする。
function writeRateLimit(env) {
  const configured = Number(env.WRITE_RATE_LIMIT_PER_MINUTE);
  return Number.isFinite(configured) && configured > 0 ? configured : WRITE_RATE_LIMIT_PER_MINUTE;
}

function isMutatingMethod(method) {
  return method === "POST" || method === "PATCH" || method === "DELETE" || method === "PUT";
}

// 利用者ごとの回数制限。状態はプロセス内メモリに持つ(単一プロセス常駐のため)。
// キー数には上限を設け、上限を超えたら「期限切れのキー」→「最も古いキー」の順に
// 破棄する。以前は利用者ごとの配列が無制限に増え続けていた。
function enforceRateLimit(bucket, actorId, limit, message) {
  if (!Number.isFinite(limit) || limit <= 0) return;
  const key = `${bucket}:${actorId}`;
  const now = Date.now();
  const timestamps = (rateLimitState.get(key) ?? []).filter((at) => now - at < RATE_LIMIT_WINDOW_MS);
  if (timestamps.length >= limit) {
    throw httpError(message, 429);
  }
  timestamps.push(now);
  // Mapは挿入順を保持するため、再挿入して「最近使ったキー」を後ろへ送る。
  rateLimitState.delete(key);
  rateLimitState.set(key, timestamps);
  pruneRateLimitState(now);
}

function pruneRateLimitState(now) {
  if (rateLimitState.size <= RATE_LIMIT_MAX_ENTRIES) return;
  for (const [key, timestamps] of rateLimitState) {
    if (rateLimitState.size <= RATE_LIMIT_MAX_ENTRIES) return;
    if (timestamps.every((at) => now - at >= RATE_LIMIT_WINDOW_MS)) rateLimitState.delete(key);
  }
  while (rateLimitState.size > RATE_LIMIT_MAX_ENTRIES) {
    rateLimitState.delete(rateLimitState.keys().next().value);
  }
}

function authorize(actor, capability) {
  const policy = ROLE_POLICIES[actor.role] ?? ROLE_POLICIES.viewer;
  if (!policy[capability]) {
    throw httpError(`${policy.label}には${capability}権限がありません。`, 403);
  }
}

// 案件・案件メンバーの管理はCAD管理者のみに限定する(少人数のIT/DX部門による一元運用を想定)。
function requireCadAdmin(actor) {
  if (actor.role !== "cad_admin") {
    throw httpError("この操作にはCAD管理者権限が必要です。", 403);
  }
}

// 案件(project)単位のアクセス制御。既存案件は既定でaccess_scope='open'のままなので、
// 単一案件運用の現行挙動(全ロールが閲覧・編集可)は一切変わらない。cad_adminは常に
// 全案件へアクセス可能(運用担当が少人数のため管理者ロールを唯一のオーバーライドとする)。
// restrictedな案件はproject_membersに登録された利用者のみ許可し、非会員には図面が
// 存在しない場合と同一の404を返して案件・図面IDの存在自体を推測されないようにする。
// 案件(project)単位のアクセス制御。fail-closedで判定する:
//  - 案件が取得できない場合は拒否(404)。「判定できないので通す」経路を作らない。
//  - accessScopeが"open"のときだけ無条件で許可し、それ以外(restricted・未知の値・未設定)は
//    メンバー登録を要求する。以前は `accessScope !== "restricted"` で許可していたため、
//    migration 0007未適用などでaccessScopeが取得できない場合に全ロールへ開放され得た。
// cad_adminは常に全案件へアクセス可能(運用担当が少人数のため管理者ロールを唯一のオーバーライドとする)。
async function requireProjectAccess(store, actor, projectId, options) {
  // 図面経由の判定では、非会員にも「図面が存在しない」場合と完全に同一の404本文を返す。
  // 本文が異なると、認証済みの任意ロールが「存在するが権限が無い」と「存在しない」を
  // 区別でき、案件・図面IDの存在オラクルになる(コード内コメントの意図を実装で満たす)。
  const deny = () => { throw httpError(options?.notFound ?? "この案件への権限がありません。", 404); };
  if (actor.role === "cad_admin") return;
  const project = await store.getProject(projectId);
  if (!project) deny();
  if (project.accessScope === "open") return;
  const isMember = await store.isProjectMember(projectId, actor.id);
  if (!isMember) deny();
}

async function requireDrawingAccess(store, actor, drawingId) {
  // 要求されたIDを本文へ含めない。含めると「存在しないID」と「権限のない案件のID」で
  // 本文が変わり、応答の差から案件・図面IDの存在を推測できてしまう。定数文言にして
  // 両経路を完全に同一の応答へ揃える。
  const notFound = "図面が見つかりません。";
  const projectId = await store.getDrawingProjectId(drawingId);
  if (projectId === null) throw httpError(notFound, 404);
  await requireProjectAccess(store, actor, projectId, { notFound });
}

async function getDrawing(store, id) {
  const drawing = await store.getDrawing(id);
  if (!drawing) {
    throw httpError(`図面が見つかりません: ${id}`, 404);
  }
  return drawing;
}

async function getPublicDrawing(store, id) {
  const drawing = await store.getPublicDrawing(id);
  if (!drawing) throw httpError("公開図面が見つかりません。", 404);
  return redactPublicDrawing(drawing);
}

// 匿名で読める公開図面から、利用者を特定できる値(Cloudflare Accessのメールアドレス等)を除く
// (独立レビュー M-1)。操作者を表す項目は変更履歴のコマンド内の図形まで含めてどの階層でも、
// 役割名・system・agent 以外なら "user" に置き換える。コメント本文や図形の文字列に書かれた
// メールアドレスも伏せる。
const PUBLIC_ACTOR_LABELS = new Set(["system", "agent", "user", ...Object.keys(ROLE_POLICIES)]);
const IDENTITY_KEYS = new Set(["actor", "author", "createdBy"]);
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const REDACTED_EMAIL = "[メールアドレス省略]";

function publicActor(value) {
  return typeof value === "string" && PUBLIC_ACTOR_LABELS.has(value) ? value : "user";
}

export function redactPublicDrawing(value) {
  if (typeof value === "string") return value.replace(EMAIL_PATTERN, REDACTED_EMAIL);
  if (Array.isArray(value)) return value.map(redactPublicDrawing);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, IDENTITY_KEYS.has(key) ? publicActor(item) : redactPublicDrawing(item)])
  );
}

async function getAgentRun(store, id) {
  const run = await store.getAgentRun(id);
  if (!run) {
    throw httpError(`Agent Runが見つかりません: ${id}`, 404);
  }
  return run;
}

function withActor(drawing, actor) {
  return { ...drawing, currentRole: actor.role };
}

function requireIdempotency(request) {
  const key = request.headers.get("idempotency-key");
  if (!key) {
    throw httpError("Idempotency-Keyが必要です。", 428);
  }
  return key;
}

function requireExpectedVersion(request, drawing) {
  // 楽観ロックの比較は整数の完全一致で行う。Number()は"1e0"・"0x1"・"1.0"を
  // いずれも1として通してしまい、表記ゆれで競合検知の挙動が変わるため、
  // 10進整数のリテラルだけを受理する。
  const raw = request.headers.get("expected-version");
  if (raw === null || !/^\d+$/.test(raw.trim())) {
    throw httpError("expected-versionが必要です(10進整数)。", 428);
  }
  const expected = Number.parseInt(raw.trim(), 10);
  const actual = drawing.revision ?? 1;
  if (expected !== actual) {
    throw httpError(`リビジョンが競合しています。expected=${expected}, actual=${actual}`, 409);
  }
}

// 図面更新コマンドの入力検証。配列以外を受け取るとapplyTransaction内の
// commands.every()が例外を投げて500になるため、ここで400として拒否する。
// あわせて op を許可リストで検証する: applyTransactionは未知のopを黙って無視するため、
// 綴り間違いでも200(成功)が返り「何も起きていないのに成功した」状態になっていた。
function requireTransactionCommands(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw httpError("JSON本文はオブジェクトである必要があります。", 400);
  }
  const commands = body.commands ?? [];
  if (!Array.isArray(commands)) {
    throw httpError("commandsは配列である必要があります。", 400);
  }
  if (commands.length > MAX_TRANSACTION_COMMANDS) {
    throw httpError(`1回の更新で送信できるコマンドは${MAX_TRANSACTION_COMMANDS}件までです。`, 413);
  }
  commands.forEach((command, index) => {
    if (!command || typeof command !== "object" || Array.isArray(command)) {
      throw httpError(`commands[${index}]はオブジェクトである必要があります。`, 400);
    }
    if (typeof command.op !== "string" || !ALLOWED_TRANSACTION_OPS.has(command.op)) {
      const shown = typeof command.op === "string" ? command.op.slice(0, 40) : typeof command.op;
      throw httpError(`commands[${index}]のopが不正です: ${shown}`, 400);
    }
    // 点列長の上限。`op:"add"`は`command.entity`、`op:"update"`は`command.patch`に
    // 図形本体が入るため、`command.points`だけを見ても実クライアント経路では一度も
    // 発動しない(SPAとcad-command.jsが送る形状に合わせて3箇所すべてを検査する)。
    for (const [label, value] of [["points", command.points], ["entity.points", command.entity?.points], ["patch.points", command.patch?.points]]) {
      if (Array.isArray(value) && value.length > MAX_COMMAND_POINTS) {
        throw httpError(`commands[${index}].${label}が上限(${MAX_COMMAND_POINTS})を超えています。`, 413);
      }
    }
  });
  return commands;
}

// 図形の構造不正(critical または invalid-geometry)のうち、更新前には無かったものを返す。
// 既存の不整合(修正前に保存された不正図形)は対象外とし、今回の更新で新たに生じたものだけを
// 拒否する(正常に使えている図面の編集を止めないため)。
function findIntroducedGeometryIssues(before, after) {
  const key = (issue) => `${issue.code}:${issue.entityId ?? ""}`;
  const existing = new Set(validateDrawing(before).filter(isStructuralIssue).map(key));
  return validateDrawing(after).filter(isStructuralIssue).filter((issue) => !existing.has(key(issue)));
}

function isStructuralIssue(issue) {
  return issue.severity === "critical" || issue.code === "invalid-geometry";
}

async function rejectClaimedIdempotency(store, key) {
  if (await store.hasIdempotency(key)) {
    throw httpError("同じIdempotency-Keyのリクエストは処理済みです。", 409);
  }
}

// 冪等キーの予約を取り消す。業務処理が失敗した場合に呼び、同じキーでの正しい再送を可能にする。
// 予約を残したままだと、ID衝突や一時障害のあと「一度失敗した操作を二度と再試行できない」状態になる。
// 解放に失敗しても元のエラーを優先する(予約が残るリスクはログで追跡できる)。
async function releaseIdempotencyQuietly(store, key) {
  try {
    if (typeof store.releaseIdempotency === "function") await store.releaseIdempotency(key);
  } catch {
    // 元のエラーを優先する
  }
}

async function readJson(request) {
  if (!request.body) return {};
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw httpError("Content-Type: application/jsonが必要です。", 415);
  }
  const declaredSize = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_JSON_BYTES) {
    throw httpError("JSON本文が1 MiBを超えています。", 413);
  }
  const reader = request.body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_JSON_BYTES) {
      await reader.cancel();
      throw httpError("JSON本文が1 MiBを超えています。", 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw httpError("JSON本文が不正です。", 400);
  }
}

function normalizeRoute(pathname) {
  return pathname.replace(/^\/api\/v1/, "").replace(/^\/api/, "") || "/";
}

function isPublicReadRoute(method, route) {
  return method === "GET" && (route === "/health" || route === "/drawings/demo");
}

function sanitizeProbe(db) {
  return {
    provider: db.provider,
    mode: db.mode,
    migrated: db.migrated ?? db.mode === "memory-preview"
  };
}

// 稼働中APIがどのコミットに由来するかを応答へ含める(Issue #98の再発防止)。
// 本番は「本番ホストのローカルmainがGitHub mainから分岐したまま稼働していた」事故を
// 起こしているため、外部から`GET /api/health`だけで稼働commitを確認できるようにする。
// ここに含めるのは公開リポジトリのcommit/branchのみで、パス・資格情報・環境変数の値は
// 一切含めない。値が未設定(開発サーバー等)の場合はnullを返す。
function deployProvenance(env) {
  const info = env.DEPLOY_INFO;
  if (!info || typeof info !== "object") {
    return { commit: null, distCommit: null, branch: null, dirty: null };
  }
  const distCommit = typeof info.distCommit === "function" ? info.distCommit() : info.distCommit;
  return {
    commit: typeof info.commit === "string" ? info.commit : null,
    // 配信中の画面(dist/)のbuild元commit。commitと異なる場合、サーバーと画面の版がずれている。
    distCommit: typeof distCommit === "string" ? distCommit : null,
    branch: typeof info.branch === "string" ? info.branch : null,
    dirty: typeof info.dirty === "boolean" ? info.dirty : null
  };
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...JSON_HEADERS, ...headers }
  });
}

function corsHeaders(env, requestId, requestOrigin) {
  const origin = resolveCorsOrigin(env, requestOrigin);
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,idempotency-key,expected-version,x-demo-role,x-demo-actor,x-request-id",
    vary: "Origin",
    "x-request-id": requestId
  };
}

function resolveCorsOrigin(env, requestOrigin) {
  const configured =
    env.CORS_ORIGIN ?? (env.APP_ENV === "production" ? "https://mirai-web-cad.mirai-dx-platform.com" : "*");
  if (configured === "*") return "*";
  const allowList = configured
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (allowList.length === 0) return "null";
  if (requestOrigin && allowList.includes(requestOrigin)) return requestOrigin;
  return allowList[0];
}

async function saveMutationAtomically(store, drawing, actor, action, targetId, detail, idempotencyKey, route, agentRun = null) {
  const saved = await store.saveDrawingAtomically(
    drawing,
    createAuditEntry(actor, action, "drawing", targetId, detail),
    idempotencyKey,
    actor.id,
    route,
    agentRun
  );
  if (!saved) throw httpError("同じIdempotency-Keyのリクエストは処理済みです。", 409);
}

async function audit(store, actor, action, targetType, targetId, detail) {
  await store.appendAudit(createAuditEntry(actor, action, targetType, targetId, detail));
}

function createAuditEntry(actor, action, targetType, targetId, detail) {
  return {
    id: `audit_${cryptoSafeId()}`,
    actorId: actor.id,
    role: actor.role,
    action,
    targetType,
    targetId,
    detail,
    createdAt: new Date().toISOString()
  };
}

function httpError(message, status) {
  return Object.assign(new Error(message), { status });
}

function auditLogsToCsv(entries) {
  const header = ["id", "createdAt", "actorId", "role", "action", "targetType", "targetId", "detail"];
  const rows = entries.map((entry) => [
    entry.id,
    entry.createdAt,
    entry.actorId,
    entry.role ?? "",
    entry.action,
    entry.targetType,
    entry.targetId,
    JSON.stringify(entry.detail ?? {})
  ]);
  return [header, ...rows].map((row) => row.map(csvEscape).join(",")).join("\r\n") + "\r\n";
}

// 監査CSVのセル無害化。純関数として単体テストから直接検証するためexportする
// (現行の到達経路ではHTTPヘッダはトリムされ、detailはJSON文字列化されるため
// 先頭空白のケースは届きにくいが、汎用のエスケープ関数として正しく保つ)。
export function csvEscape(value) {
  const text = String(value ?? "");
  // 表計算ソフトは先頭の空白・タブ・改行を読み飛ばしてから数式として解釈するため、
  // 「先頭の制御文字・空白を除いた最初の文字」が =,+,-,@ の場合に無害化する。
  // 先頭一致だけで判定すると " =cmd|..." が素通りしてしまう。
  const firstMeaningful = text.replace(/^[\s\u0000-\u001f]*/, "");
  const guarded = /^[=+\-@]/.test(firstMeaningful) ? `'${text}` : text;
  if (/[",\r\n]/.test(guarded)) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }
  return guarded;
}

function cryptoSafeId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().slice(0, 12);
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
