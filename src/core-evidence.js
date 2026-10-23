/**
 * Mirai Web-CAD → Mirai-Harness-Core evidence 変換アダプタ。
 *
 * Web-CADの監査ログ(audit_logs)とAI実行記録(agent_runs)の1行を、Coreの証跡
 * schema `core.evidence.ai_run/1` へ写像した「射影(projection)」に変換する純粋関数群。
 * 正本schemaはコピーせず、`/home/kensan/Projects/Mirai-Construction-DX/Mirai-Harness-Core`
 * の `schemas/evidence/ai-run.schema.json` / `schemas/event/envelope.schema.json` を
 * 読み取り専用で参照して項目名を合わせている(参照commitは
 * docs/architecture/core-evidence-export.md)。
 *
 * 重要(この出力はCore schemaに準拠しない):
 *   Coreの `core.evidence.ai_run/1` は `source_system` を `const "mcah"` に固定しており、
 *   Web-CADが `source_system: "web-cad"` で出力した時点で検証に通らない。さらに
 *   `run_id`(UUIDv7)・`usage`・`policy`・`verification`・`citations`・`deployment` は
 *   現行DBに保存が無い。したがって:
 *     - `schema` は常に `null`(Core schemaを採用したと偽らない)
 *     - `schema_target` に対応先のCore `$id` を示す
 *     - 埋められない必須項目は `null` とし、`unsupported` に列挙する
 *     - 値の生成元・加工(derived/redacted)は各 `*_status` に残す
 *   これは「送信しない・他システムDBへ接続しない」現段階の出力であり、MCIP送信時に
 *   Coreの署名済みReleaseをlockへ固定した後でschema版と適合可否を確定する。
 *
 * 秘密値・PII:
 *   - `actor_id` / `created_by` はメールアドレスであり得る。UUID形式または
 *     `system` / `anonymous` 以外は出力しない(`actor.status: "redacted"`)。
 *   - `agent_runs.prompt` は出力しない(CLIもSELECTしない)。
 *   - `audit_logs.detail` はホワイトリスト(role/status/engine/provider/model/risk)のみ読む。
 *
 * このmoduleは `src/` 配下(browserGlobalsでlint)のため、Node専用APIをimportしない。
 * UUIDv7導出に使うSHA-256は、決定的IDの生成専用として本ファイル内に実装する
 * (暗号用途ではない。正しさは tests/core-evidence.test.js で node:crypto と照合する)。
 */

export const SOURCE_SYSTEM = "web-cad";
// Core側の実$id。勝手に別名を作らない。
export const CORE_AI_RUN_SCHEMA_ID = "core.evidence.ai_run/1";
export const CORE_EVENT_ENVELOPE_SCHEMA_ID = "core.event.envelope/1";
export const CORE_EVENT_TYPE_EVIDENCE_RECORDED = "evidence.recorded";
// Core schemaを採用していないことを明示する語彙。
export const CORE_SCHEMA_STATUS = "unsupported";

// Web-CADのagent_runs.status(0001_initial.sqlのCHECK制約、10状態)から
// Core ai_run status(7列挙)への対応。意味が一致するものだけを写像し、残りは null。
//   completed   -> completed
//   failed      -> failed
//   rejected    -> rejected
//   rolled_back -> cancelled(適用後の巻き戻し)
//   planned     -> awaiting_approval(人間の承認待ち。Web-CADは提案を自動適用しない)
//   previewed   -> awaiting_approval
//   received / needs_input / user_approved / executing はCoreに対応する状態が無い
export const AGENT_RUN_STATUS_MAP = Object.freeze({
  completed: "completed",
  failed: "failed",
  rejected: "rejected",
  rolled_back: "cancelled",
  planned: "awaiting_approval",
  previewed: "awaiting_approval"
});

// Core ai_run/1 の required のうち、本アダプタが出力時に充足を判定するもの。
// (source_systemは常に出力するため対象外)
export const CORE_AI_RUN_REQUIRED_FIELDS = Object.freeze([
  "schema",
  "event_id",
  "run_id",
  "request_id",
  "project_id",
  "requester_oid",
  "skill",
  "status",
  "citations",
  "verification",
  "policy",
  "models",
  "usage",
  "deployment",
  "created_at"
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Web-CADの内部ID・action・target種別に許す文字。メールアドレス(@)や空白は通さない。
const SAFE_TOKEN_RE = /^[A-Za-z0-9_.-]{1,120}$/;
const SAFE_MODEL_RE = /^[A-Za-z0-9._:/-]{1,120}$/;
const SAFE_VERSION_RE = /^[0-9A-Za-z.+_-]{1,64}$/;
// Core projectId の形式(identity/identifiers/1#/$defs/projectId)。
const CORE_PROJECT_ID_RE = /^[A-Z][A-Z0-9]{1,7}-[0-9]{4}-[0-9]{4,8}$/;
// RFC 3339(秒必須・小数秒任意・Zまたは±hh:mm)。ローカル時刻の曖昧解釈を避ける。
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const KNOWN_ROLES = new Set(["viewer", "drafter", "reviewer", "approver", "cad_admin"]);

/**
 * Core evidence射影(監査ログ行)を生成する。
 * @param {Record<string, any>} row audit_logs の行(snake_case)。
 *   想定列: id, action, target_type, target_id, detail, created_at, project_id(任意)
 * @param {Record<string, any>} context 任意。`{ projectId, drawingId }` を渡すと、
 *   DBに列が無い監査行でも分かっている案件・図面を補える(CLIの--drawing-id用)。
 */
export function toCoreEvidenceFromAuditLog(row = {}, context = {}) {
  const detail = parseJsonObject(row.detail);
  const action = safeString(row.action, SAFE_TOKEN_RE);
  const targetType = safeString(row.target_type, SAFE_TOKEN_RE);
  const targetId = safeString(row.target_id, SAFE_TOKEN_RE);
  const role = safeRole(detail.role);
  const rawActor = row.actor_id;
  const actor = describeActor(rawActor, role);
  const createdAt = toIso8601(row.created_at);
  const projectId = safeString(row.project_id, SAFE_TOKEN_RE) ?? safeString(context.projectId, SAFE_TOKEN_RE);

  // 監査行のstatusは、AI提案の作成(agent.planned)だけが提案状態を持つ。
  const statusRaw = isAgentAuditAction(action) ? safeString(detail.status, SAFE_TOKEN_RE) : null;
  const status = statusRaw ? AGENT_RUN_STATUS_MAP[statusRaw] ?? null : null;

  const source = {
    table: "audit_logs",
    kind: "audit_log",
    id: safeString(row.id, SAFE_TOKEN_RE),
    drawing_id:
      safeString(context.drawingId, SAFE_TOKEN_RE) ??
      (targetType === "drawing" ? targetId : null),
    project_id: projectId,
    action,
    target_type: targetType,
    target_id: targetId,
    run_status: statusRaw,
    risk: safeString(detail.risk, SAFE_TOKEN_RE),
    skill: null,
    models: buildModels(detail.engine, detail.provider, detail.model),
    role
  };

  return buildEvidence({
    rowId: row.id,
    kind: "audit_log",
    actor,
    status,
    statusSource: statusRaw,
    createdAt,
    projectId,
    aiGenerated: source.models?.engine === "llm" ? true : null,
    source
  });
}

/**
 * Core evidence射影(AI実行記録行)を生成する。
 * @param {Record<string, any>} row agent_runs の行(snake_case)。`prompt` / `created_by` は読まない。
 *   想定列: id, status, skill_id, skill_version, proposal, risk, created_at,
 *           drawing_id, project_id(SQLでdrawing_versions/drawingsから結合)
 * @param {Record<string, any>} context 任意。`{ projectId }`(案件IDを引けない経路の補完)
 */
export function toCoreEvidenceFromAgentRun(row = {}, context = {}) {
  const proposal = parseJsonObject(row.proposal);
  const skillId = safeString(row.skill_id, SAFE_TOKEN_RE) ?? safeString(proposal.skill?.id, SAFE_TOKEN_RE);
  const skillVersion =
    safeString(row.skill_version, SAFE_VERSION_RE) ?? safeString(proposal.skill?.version, SAFE_VERSION_RE);
  const statusRaw = safeString(row.status, SAFE_TOKEN_RE);
  const status = statusRaw ? AGENT_RUN_STATUS_MAP[statusRaw] ?? null : null;
  const createdAt = toIso8601(row.created_at);
  const projectId = safeString(row.project_id, SAFE_TOKEN_RE) ?? safeString(context.projectId, SAFE_TOKEN_RE);
  const models = buildModels(proposal.engine, proposal.provider, proposal.model);
  const actor = describeActor(row.created_by, null);

  const source = {
    table: "agent_runs",
    kind: "agent_run",
    id: safeString(row.id, SAFE_TOKEN_RE),
    drawing_id: safeString(row.drawing_id, SAFE_TOKEN_RE) ?? safeString(context.drawingId, SAFE_TOKEN_RE),
    project_id: projectId,
    action: null,
    target_type: null,
    target_id: null,
    run_status: statusRaw,
    risk: safeString(row.risk, SAFE_TOKEN_RE) ?? safeString(proposal.risk, SAFE_TOKEN_RE),
    skill: skillId || skillVersion ? { id: skillId, version: skillVersion } : null,
    models,
    role: null
  };

  return buildEvidence({
    rowId: row.id,
    kind: "agent_run",
    actor,
    status,
    statusSource: statusRaw,
    createdAt,
    projectId,
    aiGenerated: models?.engine === "llm" ? true : null,
    source
  });
}

/**
 * JSON Lines(1行1JSON、末尾改行あり)へ変換する。CLIとテストの共通出口。
 * @param {Record<string, any>[]} records
 * @returns {string}
 */
export function toJsonLines(records) {
  if (!Array.isArray(records)) throw new TypeError("records は配列である必要があります。");
  if (records.length === 0) return "";
  return `${records.map((record) => JSON.stringify(record, jsonReplacer)).join("\n")}\n`;
}

/**
 * evidence射影をCoreのイベント封筒 `core.event.envelope/1` で包む。
 * 封筒自体はCore schemaの必須項目を満たす(id は導出UUIDv7、time は作成時刻)。
 * data は準拠しない射影のまま(この事実は data.schema_status に残る)。
 * @param {Record<string, any>} evidence
 */
export function toCoreEventEnvelope(evidence) {
  if (!isPlainObject(evidence)) throw new TypeError("evidence はオブジェクトである必要があります。");
  if (typeof evidence.event_id !== "string" || !UUID_V7_RE.test(evidence.event_id)) {
    throw new TypeError("event_id(UUIDv7)が無いためイベント封筒を作成できません。");
  }
  if (typeof evidence.created_at !== "string" || !RFC3339_RE.test(evidence.created_at)) {
    throw new TypeError("created_at(RFC 3339)が無いためイベント封筒を作成できません。");
  }
  const envelope = {
    schema: CORE_EVENT_ENVELOPE_SCHEMA_ID,
    specversion: "1.0",
    id: evidence.event_id,
    source: SOURCE_SYSTEM,
    type: CORE_EVENT_TYPE_EVIDENCE_RECORDED,
    time: evidence.created_at,
    datacontenttype: "application/json",
    data: evidence
  };
  if (typeof evidence.source?.id === "string") envelope.subject = evidence.source.id;
  if (typeof evidence.actor?.role === "string") envelope.actor = evidence.actor.role;
  return envelope;
}

/**
 * Web-CADの行IDと作成時刻から、決定的なUUIDv7を導出する。
 * 同じ(source, id, created_at)は常に同じIDになるため、再送時の重複排除に使える。
 * tableを名前空間に含めるので、同一IDでもaudit_logsとagent_runsは別IDになる。
 * 作成時刻が不正な場合は時系列UUIDv7を作れないため null。
 * @param {"audit_logs"|"agent_runs"} table
 * @param {unknown} id
 * @param {string|null} isoCreatedAt toIso8601() の結果
 */
export function deriveEventId(table, id, isoCreatedAt) {
  if (typeof id !== "string" || id.length === 0 || id.length > 200) return null;
  if (typeof isoCreatedAt !== "string" || !RFC3339_RE.test(isoCreatedAt)) return null;
  const ms = Date.parse(isoCreatedAt);
  if (!Number.isFinite(ms) || ms < 0 || ms > 0xffffffffffff) return null;
  const hashHex = sha256Hex(`${SOURCE_SYSTEM}:${table}:${id}`);
  const bytes = new Uint8Array(16);

  // 48bit ミリ秒タイムスタンプ(big-endian)。
  let rest = ms;
  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  // version=7、variant=10xx。残りはSHA-256由来(74bit)。
  const hashBytes = new Uint8Array(20);
  for (let i = 0; i < 20; i += 1) hashBytes[i] = Number.parseInt(hashHex.slice(i * 2, i * 2 + 2), 16);
  bytes[6] = 0x70 | (hashBytes[0] & 0x0f);
  bytes[7] = hashBytes[1];
  bytes[8] = 0x80 | (hashBytes[2] & 0x3f);
  for (let i = 0; i < 7; i += 1) bytes[9 + i] = hashBytes[3 + i];

  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * DBのtimestamptz(Date)やISO 8601文字列を、UTC・ミリ秒・ZのRFC 3339へ正規化する。
 * RFC 3339に一致しない文字列は、実行環境のローカル時刻解釈に依存しないよう null にする。
 * @param {unknown} value
 * @returns {string|null}
 */
export function toIso8601(value) {
  if (value === null || value === undefined) return null;
  let ms;
  if (value instanceof Date) {
    ms = value.getTime();
  } else if (typeof value === "number") {
    ms = value;
  } else if (typeof value === "string" && RFC3339_RE.test(value.trim())) {
    ms = Date.parse(value.trim());
  } else {
    return null;
  }
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function buildEvidence({ rowId, kind, actor, status, statusSource, createdAt, projectId, aiGenerated, source }) {
  const eventId = deriveEventId(kind === "audit_log" ? "audit_logs" : "agent_runs", rowId, createdAt);
  const coreProjectId = projectId && CORE_PROJECT_ID_RE.test(projectId) ? projectId : null;
  const evidence = {
    // Core schemaは未採用。採用したと偽らない。
    schema: null,
    schema_target: CORE_AI_RUN_SCHEMA_ID,
    schema_status: CORE_SCHEMA_STATUS,
    source_system: SOURCE_SYSTEM,
    event_id: eventId,
    event_id_status: eventId ? "derived" : "unsupported",
    run_id: null,
    run_id_status: "unsupported",
    request_id: null,
    request_id_status: "unsupported",
    correlation_id: null,
    correlation_id_status: "unsupported",
    project_id: coreProjectId,
    project_id_status: coreProjectId ? "mapped" : "unsupported",
    organization_id: null,
    requester_oid: actor.requesterOid,
    requester_oid_status: actor.requesterOid ? "mapped" : actor.status === "redacted" ? "redacted" : "unsupported",
    actor: { id: actor.id, role: actor.role, status: actor.status },
    status,
    status_source: statusSource,
    status_mapping: status ? "mapped" : "unsupported",
    created_at: createdAt,
    created_at_status: createdAt ? "mapped" : "unsupported",
    finished_at: null,
    finished_at_status: "unsupported",
    ai_generated: aiGenerated,
    // Core必須だが、現行DBに保存が無い/形式が合わない項目。値はnullのまま残す。
    skill: null,
    skill_status: "unsupported",
    models: null,
    models_status: "unsupported",
    usage: null,
    usage_status: "unsupported",
    policy: null,
    policy_status: "unsupported",
    verification: null,
    verification_status: "unsupported",
    citations: null,
    citations_status: "unsupported",
    deployment: null,
    deployment_status: "unsupported",
    source
  };
  evidence.unsupported = collectUnsupported(evidence);
  return evidence;
}

function collectUnsupported(evidence) {
  const unsupported = [];
  for (const field of CORE_AI_RUN_REQUIRED_FIELDS) {
    if (field === "source_system") continue;
    if (evidence[field] === null || evidence[field] === undefined) unsupported.push(field);
  }
  return unsupported;
}

function describeActor(raw, role) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { id: null, role, status: "unavailable", requesterOid: null };
  // 非PIIの運用主体。デモの匿名閲覧もここに含める。
  if (text === "system" || text === "anonymous") {
    return { id: text, role, status: "mapped", requesterOid: null };
  }
  const uuid = text.toLowerCase();
  if (UUID_RE.test(uuid)) {
    // Entra IDのoid等、UUID形式の主体IDはCore requester_oidへ写像できる。
    return { id: uuid, role, status: "mapped", requesterOid: uuid };
  }
  // メールアドレス・ロール名等はそのままではPII/非IDのため出力しない。
  return { id: null, role, status: "redacted", requesterOid: null };
}

function safeRole(value) {
  return typeof value === "string" && KNOWN_ROLES.has(value) ? value : null;
}

function safeString(value, pattern) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length === 0 || text.length > 120) return null;
  return pattern.test(text) ? text : null;
}

function buildModels(engine, provider, model) {
  const safeEngine = safeString(engine, SAFE_MODEL_RE);
  const safeProvider = safeString(provider, SAFE_MODEL_RE);
  const safeModel = safeString(model, SAFE_MODEL_RE);
  if (!safeEngine && !safeProvider && !safeModel) return null;
  return { engine: safeEngine, provider: safeProvider, model: safeModel };
}

function isAgentAuditAction(action) {
  return typeof action === "string" && action.startsWith("agent.");
}

function parseJsonObject(value) {
  if (isPlainObject(value)) return value;
  // migration 0006 以前の二重保存行(JSON文字列)も読めるようにする。壊れていれば空扱い。
  if (typeof value === "string" && value.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(value);
      return isPlainObject(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// JSON.stringifyでundefinedを落とし、BigInt等の例外値を出さないための最終防波堤。
// (このmoduleが作る値にundefined/BigIntは入らないが、CLIの自己検査で使う。)
function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

// ---- SHA-256(決定的ID導出専用) ------------------------------------------------

const SHA256_K = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

const SHA256_INITIAL = Object.freeze([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
]);

/**
 * UTF-8文字列のSHA-256を16進64文字で返す。暗号用途ではなく、決定的IDの生成にのみ使う。
 * @param {string} input
 * @returns {string}
 */
export function sha256Hex(input) {
  const message = new TextEncoder().encode(String(input));
  const paddedLength = Math.ceil((message.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(message);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  // メッセージ長(bit)。上限2^53-1で、この用途の入力長では常に安全。
  view.setUint32(paddedLength - 8, Math.floor((message.length * 8) / 0x100000000));
  view.setUint32(paddedLength - 4, (message.length * 8) >>> 0);

  const state = [...SHA256_INITIAL];
  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }
  return state.map((value) => value.toString(16).padStart(8, "0")).join("");
}

function rotr(value, bits) {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}
