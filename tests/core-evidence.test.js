import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_RUN_STATUS_MAP,
  CORE_AI_RUN_REQUIRED_FIELDS,
  CORE_AI_RUN_SCHEMA_ID,
  SOURCE_SYSTEM,
  deriveEventId,
  sha256Hex,
  toCoreEventEnvelope,
  toCoreEvidenceFromAgentRun,
  toCoreEvidenceFromAuditLog,
  toIso8601,
  toJsonLines
} from "../src/core-evidence.js";
import {
  databaseNameFromUrl,
  parseArgs,
  runSelfTest,
  selectAgentRuns,
  selectAuditLogs
} from "../scripts/export-core-evidence.mjs";

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "scripts", "export-core-evidence.mjs");

const AUDIT_ROW = {
  id: "audit_abc123def456",
  actor_id: "taro.yamada@example.com",
  action: "agent.planned",
  target_type: "agent_run",
  target_id: "run_abc123def456",
  detail: { role: "drafter", status: "planned", engine: "llm", provider: "openai", model: "gpt-4o-mini" },
  created_at: "2026-10-23T01:02:03.456Z"
};

const RUN_ROW = {
  id: "run_abc123def456",
  status: "completed",
  skill_id: "llm-proposal",
  skill_version: "0.1.0",
  proposal: { engine: "llm", provider: "anthropic", model: "claude-3-5-sonnet", risk: "minor" },
  risk: "minor",
  drawing_id: "dwg_demo_001",
  project_id: "prj_demo_road_001",
  created_at: "2026-10-23T01:02:04.000Z"
};

test("sha256Hexはnode:cryptoのSHA-256と一致する", () => {
  // 55/56/64はパディング境界。UTF-8の多バイトも含める。
  const samples = ["", "abc", "web-cad:audit_logs:audit_abc", "あいうえお", "x".repeat(55), "y".repeat(56), "z".repeat(64), "w".repeat(1000)];
  for (const sample of samples) {
    assert.equal(sha256Hex(sample), createHash("sha256").update(sample, "utf8").digest("hex"), `input length ${sample.length}`);
  }
});

test("toIso8601はUTCミリ秒へ正規化し、曖昧な時刻はnullにする", () => {
  assert.equal(toIso8601(new Date("2026-10-23T01:02:03.456Z")), "2026-10-23T01:02:03.456Z");
  assert.equal(toIso8601("2026-10-23T01:02:03.456Z"), "2026-10-23T01:02:03.456Z");
  assert.equal(toIso8601("2026-10-23T10:02:03.456+09:00"), "2026-10-23T01:02:03.456Z");
  assert.equal(toIso8601("2026-10-23T01:02:03Z"), "2026-10-23T01:02:03.000Z");
  assert.equal(toIso8601(1729645323456), "2024-10-23T01:02:03.456Z");
  // タイムゾーンが無い文字列は実行環境のローカル時刻解釈に依存するため受け付けない。
  assert.equal(toIso8601("2026-10-23 01:02:03"), null);
  assert.equal(toIso8601("2026-10-23T01:02:03"), null);
  assert.equal(toIso8601("not-a-time"), null);
  assert.equal(toIso8601(null), null);
  assert.equal(toIso8601(undefined), null);
  assert.equal(toIso8601(""), null);
});

test("監査ログ行の正常系: source_system/schema/event_id/actor/created_at", () => {
  const evidence = toCoreEvidenceFromAuditLog(AUDIT_ROW);
  assert.equal(evidence.source_system, "web-cad");
  assert.equal(evidence.source_system, SOURCE_SYSTEM);
  // Core schemaを採用したと偽らない。対応先だけを示す。
  assert.equal(evidence.schema, null);
  assert.equal(evidence.schema_target, CORE_AI_RUN_SCHEMA_ID);
  assert.equal(evidence.schema_status, "unsupported");
  assert.match(evidence.event_id, UUID_V7_RE);
  assert.equal(evidence.event_id_status, "derived");
  assert.equal(evidence.created_at, "2026-10-23T01:02:03.456Z");
  assert.equal(evidence.created_at_status, "mapped");
  assert.equal(evidence.actor.role, "drafter");
  assert.equal(evidence.actor.status, "redacted");
  assert.equal(evidence.status, "awaiting_approval");
  assert.equal(evidence.status_source, "planned");
  assert.equal(evidence.status_mapping, "mapped");
  assert.deepEqual(evidence.source, {
    table: "audit_logs",
    kind: "audit_log",
    id: "audit_abc123def456",
    drawing_id: null,
    project_id: null,
    action: "agent.planned",
    target_type: "agent_run",
    target_id: "run_abc123def456",
    run_status: "planned",
    risk: null,
    skill: null,
    models: { engine: "llm", provider: "openai", model: "gpt-4o-mini" },
    role: "drafter"
  });
  assert.equal(evidence.ai_generated, true);
});

test("AI実行記録の正常系: status写像とsourceの保持", () => {
  const evidence = toCoreEvidenceFromAgentRun(RUN_ROW);
  assert.equal(evidence.source_system, "web-cad");
  assert.equal(evidence.status, "completed");
  assert.equal(evidence.status_source, "completed");
  assert.equal(evidence.status_mapping, "mapped");
  assert.equal(evidence.ai_generated, true);
  assert.equal(evidence.event_id_status, "derived");
  assert.equal(evidence.created_at, "2026-10-23T01:02:04.000Z");
  assert.deepEqual(evidence.source.skill, { id: "llm-proposal", version: "0.1.0" });
  assert.deepEqual(evidence.source.models, { engine: "llm", provider: "anthropic", model: "claude-3-5-sonnet" });
  assert.equal(evidence.source.drawing_id, "dwg_demo_001");
  assert.equal(evidence.source.project_id, "prj_demo_road_001");
  assert.equal(evidence.source.risk, "minor");
  // CoreのprojectId形式(例: MCIP-2026-0142)ではないため、Core項目へは入れない。
  assert.equal(evidence.project_id, null);
  assert.equal(evidence.project_id_status, "unsupported");
  // Core skill.id は ^r[0-3]-... のため、Web-CADのskill idは写像しない。
  assert.equal(evidence.skill, null);
  assert.equal(evidence.skill_status, "unsupported");
});

test("agent_runs.statusの全10状態を、対応が取れた6状態だけ写像する", () => {
  const rows = [
    ["completed", "completed"],
    ["failed", "failed"],
    ["rejected", "rejected"],
    ["rolled_back", "cancelled"],
    ["planned", "awaiting_approval"],
    ["previewed", "awaiting_approval"],
    ["received", null],
    ["needs_input", null],
    ["user_approved", null],
    ["executing", null]
  ];
  assert.equal(rows.length, 10);
  for (const [source, expected] of rows) {
    const evidence = toCoreEvidenceFromAgentRun({ ...RUN_ROW, status: source });
    assert.equal(evidence.status_source, source);
    assert.equal(evidence.status, expected, `status ${source}`);
    assert.equal(evidence.status_mapping, expected ? "mapped" : "unsupported");
  }
  // 写像表そのものも固定する(将来の追加漏れを検知する)。
  assert.deepEqual(Object.keys(AGENT_RUN_STATUS_MAP).sort(), ["completed", "failed", "planned", "previewed", "rejected", "rolled_back"]);
});

test("欠落列・空行でも例外を出さず、未対応をnullとunsupportedで明示する", () => {
  const fromEmpty = toCoreEvidenceFromAuditLog({});
  assert.equal(fromEmpty.event_id, null);
  assert.equal(fromEmpty.event_id_status, "unsupported");
  assert.equal(fromEmpty.created_at, null);
  assert.equal(fromEmpty.created_at_status, "unsupported");
  assert.equal(fromEmpty.source.id, null);
  assert.equal(fromEmpty.status, null);
  assert.equal(fromEmpty.status_mapping, "unsupported");
  assert.equal(fromEmpty.actor.status, "unavailable");
  assert.ok(fromEmpty.unsupported.includes("event_id"));
  assert.ok(fromEmpty.unsupported.includes("created_at"));
  assert.ok(fromEmpty.unsupported.includes("schema"));
  assert.ok(fromEmpty.unsupported.includes("requester_oid"));
  // 配列の順序と内容はCoreの必須項目順で決定的。
  assert.deepEqual(
    fromEmpty.unsupported,
    CORE_AI_RUN_REQUIRED_FIELDS.filter((field) => fromEmpty[field] === null || fromEmpty[field] === undefined)
  );

  const runEmpty = toCoreEvidenceFromAgentRun(undefined);
  assert.equal(runEmpty.source.table, "agent_runs");
  assert.equal(runEmpty.status, null);
  // 壊れたJSON文字列のproposalでも落ちない(migration 0006以前の行を想定)。
  const brokenProposal = toCoreEvidenceFromAgentRun({ ...RUN_ROW, proposal: "{not json" });
  assert.equal(brokenProposal.source.skill?.id, "llm-proposal");
});

test("project_idはCore形式のときだけCore項目へ写像する", () => {
  const mcip = toCoreEvidenceFromAgentRun({ ...RUN_ROW, project_id: "MCIP-2026-0142" });
  assert.equal(mcip.project_id, "MCIP-2026-0142");
  assert.equal(mcip.project_id_status, "mapped");
  assert.equal(mcip.source.project_id, "MCIP-2026-0142");
  const webCad = toCoreEvidenceFromAgentRun({ ...RUN_ROW, project_id: "prj_demo_road_001" });
  assert.equal(webCad.project_id, null);
  assert.equal(webCad.source.project_id, "prj_demo_road_001");
});

test("event_idは同一行で安定し、テーブル・時刻が違えば変わる", () => {
  const first = toCoreEvidenceFromAuditLog(AUDIT_ROW);
  const second = toCoreEvidenceFromAuditLog(AUDIT_ROW);
  assert.equal(first.event_id, second.event_id);
  // Dateで渡してもISO文字列で渡しても同じ(DBドライバ差を吸収する)。
  const fromDate = toCoreEvidenceFromAuditLog({ ...AUDIT_ROW, created_at: new Date(AUDIT_ROW.created_at) });
  assert.equal(fromDate.event_id, first.event_id);
  // 同じIDでもテーブルが違えば別イベント。
  assert.notEqual(deriveEventId("audit_logs", "shared_id", "2026-10-23T01:02:03.456Z"), deriveEventId("agent_runs", "shared_id", "2026-10-23T01:02:03.456Z"));
  // 同じIDでも作成時刻が違えば別イベント(時系列UUIDv7)。
  assert.notEqual(deriveEventId("audit_logs", "id", "2026-10-23T01:02:03.456Z"), deriveEventId("audit_logs", "id", "2026-10-23T01:02:04.456Z"));
  // 時刻が不正ならUUIDv7を作れない。
  assert.equal(deriveEventId("audit_logs", "id", null), null);
  assert.equal(deriveEventId("audit_logs", null, "2026-10-23T01:02:03.456Z"), null);
});

test("PII・秘密値を出力しない(メール・prompt・detailの未知キー)", () => {
  const row = {
    ...AUDIT_ROW,
    actor_id: "person@example.com",
    detail: { role: "viewer", note: "person@example.com", authorization: "Bearer fake-token" }
  };
  const audit = toCoreEvidenceFromAuditLog(row);
  const serializedAudit = JSON.stringify(audit);
  assert.equal(serializedAudit.includes("example.com"), false);
  assert.equal(serializedAudit.includes("fake-token"), false);
  assert.equal(serializedAudit.includes("Bearer"), false);
  assert.equal(audit.actor.id, null);
  assert.equal(audit.actor.status, "redacted");
  assert.equal(audit.requester_oid_status, "redacted");
  // detailの未知キーはホワイトリスト外なので出力しない。
  assert.equal(Object.hasOwn(audit.source, "note"), false);

  const run = toCoreEvidenceFromAgentRun({
    ...RUN_ROW,
    prompt: "施主の連絡先は person@example.com です",
    created_by: "person@example.com",
    proposal: { ...RUN_ROW.proposal, note: "person@example.com" }
  });
  const serializedRun = JSON.stringify(run);
  assert.equal(serializedRun.includes("example.com"), false);
  assert.equal(serializedRun.includes("施主"), false);
  assert.equal(run.actor.status, "redacted");
});

test("actorがUUIDならrequester_oidへ写像し、system/anonymousはそのまま残す", () => {
  const oid = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
  const withOid = toCoreEvidenceFromAuditLog({ ...AUDIT_ROW, actor_id: oid });
  assert.equal(withOid.requester_oid, oid);
  assert.equal(withOid.requester_oid_status, "mapped");
  assert.equal(withOid.actor.id, oid);

  const system = toCoreEvidenceFromAuditLog({ ...AUDIT_ROW, actor_id: "system" });
  assert.equal(system.actor.id, "system");
  assert.equal(system.actor.status, "mapped");
  assert.equal(system.requester_oid, null);

  const anonymous = toCoreEvidenceFromAuditLog({ ...AUDIT_ROW, actor_id: "anonymous" });
  assert.equal(anonymous.actor.id, "anonymous");
  assert.equal(anonymous.actor.status, "mapped");
});

test("危険な文字を含むID・actionは出力しない", () => {
  const evidence = toCoreEvidenceFromAuditLog({
    ...AUDIT_ROW,
    id: "audit_evil@example.com",
    action: "drawing.saved@example.com",
    target_id: "dwg_demo_001@example.com"
  });
  assert.equal(evidence.source.id, null);
  assert.equal(evidence.source.action, null);
  assert.equal(evidence.source.target_id, null);
  // 行IDは安全でないため導出イベントIDには使うが、IDそのものは出さない。
  assert.match(evidence.event_id, UUID_V7_RE);
  assert.equal(JSON.stringify(evidence).includes("example.com"), false);
});

test("JSON Linesは1行1JSON・末尾改行で、空配列は空文字", () => {
  const records = [toCoreEvidenceFromAuditLog(AUDIT_ROW), toCoreEvidenceFromAgentRun(RUN_ROW)];
  const text = toJsonLines(records);
  assert.equal(text.endsWith("\n"), true);
  assert.equal(text.endsWith("\n\n"), false);
  const lines = text.trimEnd().split("\n");
  assert.equal(lines.length, 2);
  for (const line of lines) {
    const parsed = JSON.parse(line);
    assert.equal(parsed.source_system, "web-cad");
    assert.equal(parsed.schema_target, CORE_AI_RUN_SCHEMA_ID);
  }
  assert.equal(toJsonLines([]), "");
  assert.throws(() => toJsonLines("not-array"), /配列/);
});

test("Coreイベント封筒は必須項目を満たし、欠落時は作成を拒否する", () => {
  const evidence = toCoreEvidenceFromAuditLog(AUDIT_ROW);
  const envelope = toCoreEventEnvelope(evidence);
  assert.equal(envelope.schema, "core.event.envelope/1");
  assert.equal(envelope.specversion, "1.0");
  assert.equal(envelope.id, evidence.event_id);
  assert.equal(envelope.source, "web-cad");
  assert.equal(envelope.type, "evidence.recorded");
  assert.equal(envelope.time, evidence.created_at);
  assert.equal(envelope.datacontenttype, "application/json");
  assert.equal(envelope.subject, "audit_abc123def456");
  assert.equal(envelope.actor, "drafter");
  assert.deepEqual(envelope.data, evidence);
  // 封筒は additionalProperties:false のCore schemaに合わせ、許可されたキーだけを使う。
  const allowed = new Set([
    "schema",
    "specversion",
    "id",
    "source",
    "type",
    "time",
    "subject",
    "datacontenttype",
    "data",
    "project_id",
    "correlation_id",
    "classification",
    "schema_version",
    "actor"
  ]);
  for (const key of Object.keys(envelope)) assert.ok(allowed.has(key), `unexpected envelope key: ${key}`);

  assert.throws(() => toCoreEventEnvelope({ ...evidence, event_id: null }), /event_id/);
  assert.throws(() => toCoreEventEnvelope({ ...evidence, created_at: null }), /created_at/);
  assert.throws(() => toCoreEventEnvelope(null), /オブジェクト/);
});

test("unsupportedはCore必須項目のうちnullのものだけを列挙する", () => {
  for (const evidence of [toCoreEvidenceFromAuditLog(AUDIT_ROW), toCoreEvidenceFromAgentRun(RUN_ROW)]) {
    const expected = CORE_AI_RUN_REQUIRED_FIELDS.filter((field) => evidence[field] === null || evidence[field] === undefined);
    assert.deepEqual(evidence.unsupported, expected);
    for (const field of evidence.unsupported) assert.ok(CORE_AI_RUN_REQUIRED_FIELDS.includes(field));
    // 常に出力できる項目は未対応に含めない。
    assert.equal(evidence.unsupported.includes("source_system"), false);
    assert.equal(evidence.unsupported.includes("event_id"), false);
  }
});

test("CLI引数: 既定値・各オプション・不正値", () => {
  assert.deepEqual(parseArgs([]), {
    drawingId: null,
    limit: 100,
    source: "all",
    output: null,
    envelope: false,
    force: false,
    selfTest: false,
    help: false
  });
  const parsed = parseArgs(["--limit", "5", "--drawing-id", "dwg_demo_001", "--source", "agent-runs", "--output", "-", "--envelope", "--force"]);
  assert.equal(parsed.limit, 5);
  assert.equal(parsed.drawingId, "dwg_demo_001");
  assert.equal(parsed.source, "agent-runs");
  assert.equal(parsed.output, "-");
  assert.equal(parsed.envelope, true);
  assert.equal(parsed.force, true);
  assert.equal(parseArgs(["--help"]).help, true);
  assert.equal(parseArgs(["--self-test"]).selfTest, true);

  assert.throws(() => parseArgs(["--limit", "0"]), /--limit/);
  assert.throws(() => parseArgs(["--limit", "1001"]), /--limit/);
  assert.throws(() => parseArgs(["--limit", "abc"]), /--limit/);
  assert.throws(() => parseArgs(["--limit"]), /値がありません/);
  assert.throws(() => parseArgs(["--source", "other"]), /--source/);
  assert.throws(() => parseArgs(["--drawing-id", "dwg demo"]), /--drawing-id/);
  assert.throws(() => parseArgs(["--unknown"]), /不明な引数/);
  assert.throws(() => parseArgs(["--limit", "1", "--limit", "2"]), /重複/);
  assert.throws(() => parseArgs(["--envelope", "--self-test"]), /同時/);
});

test("DATABASE_URLからDB名だけを取り出し、資格情報をエラーへ漏らさない", () => {
  assert.equal(databaseNameFromUrl("postgres://user:pw@db.example:5432/mirai_web_cad"), "mirai_web_cad");
  assert.equal(databaseNameFromUrl("postgresql://user:pw@db.example/mirai_web_cad?sslmode=require"), "mirai_web_cad");
  assert.equal(databaseNameFromUrl("postgresql://user:pw@db.example/mirai_web_cad%20staging"), "mirai_web_cad staging");
  assert.throws(() => databaseNameFromUrl(""), /DATABASE_URL/);
  assert.throws(() => databaseNameFromUrl(undefined), /DATABASE_URL/);
  assert.throws(() => databaseNameFromUrl("mysql://user:pw@db.example/x"), /postgres/);
  // 不正URLでも、入力(資格情報を含み得る)をメッセージへ出さない。
  try {
    databaseNameFromUrl("postgres://user:dummy-value@[broken/mirai_web_cad");
    assert.fail("例外にならなかった");
  } catch (error) {
    assert.equal(error.message.includes("dummy-value"), false);
  }
  try {
    databaseNameFromUrl("postgres://user:dummy-value@db.example");
    assert.fail("例外にならなかった");
  } catch (error) {
    assert.equal(error.message.includes("dummy-value"), false);
    assert.match(error.message, /データベース名/);
  }
});

test("runSelfTestはDBなしで全検査を通す", () => {
  const lines = [];
  const count = runSelfTest((line) => lines.push(line));
  assert.ok(count >= 15, `checks: ${count}`);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^self-test ok \(\d+ checks\)$/);
});

test("CLI: --self-test と --help はDBなしで成功し、DATABASE_URL欠落は明確に失敗する", () => {
  const envWithoutDatabase = { ...process.env };
  delete envWithoutDatabase.DATABASE_URL;

  const selfTest = spawnSync(process.execPath, [CLI, "--self-test"], { cwd: ROOT, encoding: "utf8", env: envWithoutDatabase });
  assert.equal(selfTest.status, 0, selfTest.stderr);
  assert.match(selfTest.stdout, /self-test ok/);

  const help = spawnSync(process.execPath, [CLI, "--help"], { cwd: ROOT, encoding: "utf8", env: envWithoutDatabase });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /読み取り専用/);

  const missing = spawnSync(process.execPath, [CLI, "--limit", "1"], { cwd: ROOT, encoding: "utf8", env: envWithoutDatabase });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /DATABASE_URL/);
  // 標準出力(JSON Lines)にログを混ぜない。
  assert.equal(missing.stdout, "");
});

test("CLIは接続前に引数を検証する(不正引数ではDBへ接続しない)", () => {
  const envWithoutDatabase = { ...process.env };
  delete envWithoutDatabase.DATABASE_URL;
  const result = spawnSync(process.execPath, [CLI, "--limit", "9999"], { cwd: ROOT, encoding: "utf8", env: envWithoutDatabase });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--limit/);
  assert.equal(result.stderr.includes("接続先DB"), false);
});

test("CLIのSELECTはPII列を読まず、書き込みSQLを含まない(偽トランザクションで検証)", async () => {
  const recorded = [];
  // postgres.jsのタグ付きテンプレートと同じ呼び出し形を持つ偽tx。
  const fakeTx = (strings, ...values) => {
    recorded.push({ text: strings.join("$"), values });
    return Promise.resolve([]);
  };
  await selectAuditLogs(fakeTx, { source: "all", drawingId: null, limit: 10 });
  await selectAuditLogs(fakeTx, { source: "all", drawingId: "dwg_x", limit: 10 });
  await selectAgentRuns(fakeTx, { source: "all", drawingId: null, limit: 10 });
  await selectAgentRuns(fakeTx, { source: "all", drawingId: "dwg_x", limit: 10 });
  assert.equal(recorded.length, 4);
  for (const query of recorded) {
    const text = query.text.toLowerCase();
    assert.match(text.trimStart(), /^select /);
    assert.equal(/\b(insert|update|delete|truncate|alter|drop|create|grant|revoke)\b/.test(text), false);
    // プロンプト・メールアドレスをDBから読み込まない(PII最小化)。
    assert.equal(text.includes("prompt"), false);
    assert.equal(text.includes("created_by"), false);
    assert.equal(text.includes("actor_id"), false);
    // limitは文字列連結ではなくパラメータで渡す。
    assert.equal(query.values.includes(10), true);
  }
  // 全件クエリは図面で絞らない。--drawing-idでは図面条件とAI実行記録のサブクエリが入る。
  assert.equal(recorded[0].text.includes("drawing"), false);
  assert.equal(recorded[1].text.includes("drawing_id ="), true);
  assert.equal(recorded[1].values.includes("dwg_x"), true);
  assert.equal(recorded[2].text.includes("drawing_versions"), true);
  assert.equal(recorded[3].text.includes("where dv.drawing_id ="), true);

  // sourceで片方を選ぶとクエリを発行しない。
  const skipped = [];
  const recordingTx = (strings, ...values) => {
    skipped.push({ text: strings.join("$"), values });
    return Promise.resolve([]);
  };
  assert.deepEqual(await selectAuditLogs(recordingTx, { source: "agent-runs", drawingId: null, limit: 10 }), []);
  assert.deepEqual(await selectAgentRuns(recordingTx, { source: "audit-logs", drawingId: null, limit: 10 }), []);
  assert.equal(skipped.length, 0);
});

test("CLIは読み取り専用トランザクションを使い、読む環境変数はDATABASE_URLだけ", async () => {
  const source = await readFile(CLI, "utf8");
  assert.match(source, /set transaction read only/);
  const envKeys = [...source.matchAll(/process\.env\.([A-Za-z0-9_]+)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(envKeys)], ["DATABASE_URL"]);
  assert.equal(source.includes("dotenv"), false);
  assert.equal(source.includes("readFileSync"), false);
});
