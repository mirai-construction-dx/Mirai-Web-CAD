#!/usr/bin/env node
/**
 * Mirai Web-CAD の監査ログ / AI実行記録を Core evidence 射影へ変換し、JSON Linesで出力する
 * 読み取り専用CLI。
 *
 * 安全側の設計:
 *   - SELECTのみ。トランザクションを `set transaction read only` で開始し、誤って書き込む
 *     クエリを足してもDBが拒否する。
 *   - migration / seed / 他システムDBへの接続はしない。接続先は DATABASE_URL の1つだけ。
 *   - 出力・ログにパスワードを出さない。表示する接続情報はデータベース名のみ。
 *   - `agent_runs.prompt` / `agent_runs.created_by` / `audit_logs.actor_id` はSELECTしない
 *     (プロンプトとメールアドレスをプロセスへ読み込まない。PII最小化)。
 *   - DATABASE_URL を読むのはプロセスの環境変数のみ。envファイルは読まない。
 *
 * 使い方:
 *   DATABASE_URL=postgres://... node scripts/export-core-evidence.mjs --limit 100
 *   DATABASE_URL=... node scripts/export-core-evidence.mjs --drawing-id dwg_demo_001 --output export.jsonl
 *   node scripts/export-core-evidence.mjs --self-test
 *   node scripts/export-core-evidence.mjs --help
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  toCoreEventEnvelope,
  toCoreEvidenceFromAgentRun,
  toCoreEvidenceFromAuditLog,
  toJsonLines
} from "../src/core-evidence.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const SOURCES = new Set(["all", "audit-logs", "agent-runs"]);
const USAGE = `使い方: DATABASE_URL=postgres://... node scripts/export-core-evidence.mjs [options]

読み取り専用で audit_logs / agent_runs をSELECTし、Core evidence射影をJSON Linesで出力する。
DBへの書き込み・migration・seed・他システムDBへの接続は行わない。

options:
  --limit <n>          最大出力件数(1-${MAX_LIMIT}、既定 ${DEFAULT_LIMIT})
  --drawing-id <id>    図面IDで絞り込む(その図面への監査行と、その図面のAI実行記録)
  --source <name>      all | audit-logs | agent-runs (既定 all)
  --output <path>      出力先ファイル(既定 stdout)。"-" は stdout
  --envelope           各行をCoreイベント封筒(core.event.envelope/1)で包む
  --force              --output の既存ファイルを上書きする
  --self-test          DBへ接続せず固定fixtureで変換を自己検査する
  -h, --help           このヘルプ

出力は標準出力(JSON Lines)、ログは標準エラーへ出す。`;

/**
 * CLI引数を検証して設定へ変換する。純粋関数(テストから直接呼ぶ)。
 * @param {string[]} argv `node script.mjs` 以降の引数
 */
export function parseArgs(argv = []) {
  const options = {
    drawingId: null,
    limit: DEFAULT_LIMIT,
    source: "all",
    output: null,
    envelope: false,
    force: false,
    selfTest: false,
    help: false
  };
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--self-test") {
      options.selfTest = true;
      continue;
    }
    if (arg === "--envelope") {
      options.envelope = true;
      continue;
    }
    if (arg === "--force") {
      options.force = true;
      continue;
    }
    if (!["--limit", "--drawing-id", "--source", "--output"].includes(arg)) {
      throw new Error(`不明な引数です: ${redactArg(arg)} (--help を参照してください)`);
    }
    if (seen.has(arg)) throw new Error(`引数が重複しています: ${arg}`);
    seen.add(arg);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`引数 ${arg} に値がありません。`);
    }
    i += 1;
    if (arg === "--limit") {
      const limit = Number(value);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        throw new Error(`--limit は1-${MAX_LIMIT}の整数で指定してください。`);
      }
      options.limit = limit;
    } else if (arg === "--drawing-id") {
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(value)) {
        throw new Error("--drawing-id は英数字・_・- の80文字以内で指定してください。");
      }
      options.drawingId = value;
    } else if (arg === "--source") {
      if (!SOURCES.has(value)) {
        throw new Error(`--source は ${[...SOURCES].join(" | ")} のいずれかです。`);
      }
      options.source = value;
    } else {
      if (value.length === 0) throw new Error("--output が空です。");
      options.output = value;
    }
  }
  if (options.envelope && options.selfTest) {
    throw new Error("--envelope と --self-test は同時に指定できません。");
  }
  return options;
}

/**
 * DATABASE_URLからデータベース名だけを取り出す。ホスト・利用者・パスワードは返さない。
 * 不正なURLでも入力値(資格情報を含み得る)をメッセージへ含めない。
 * @param {string} connectionString
 */
export function databaseNameFromUrl(connectionString) {
  if (typeof connectionString !== "string" || connectionString.trim().length === 0) {
    throw new Error("DATABASE_URL が設定されていません。");
  }
  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error("DATABASE_URL をURLとして解釈できません(値は表示しません)。");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL は postgres:// または postgresql:// で始まる必要があります。");
  }
  const name = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  if (!name || name.includes("/")) {
    throw new Error("DATABASE_URL にデータベース名が含まれていません。");
  }
  return name;
}

/**
 * 固定fixtureだけで変換の要点を検査する。DBにもネットワークにも触れない。
 * @param {(line: string) => void} log
 * @returns {number} 実行した検査数
 */
export function runSelfTest(log = (line) => console.log(line)) {
  const checks = [];
  const check = (name, condition) => {
    if (!condition) throw new Error(`self-test 失敗: ${name}`);
    checks.push(name);
  };

  const auditRow = {
    id: "audit_self_test_001",
    actor_id: "self.test@example.invalid",
    action: "agent.planned",
    target_type: "agent_run",
    target_id: "run_self_test_001",
    detail: { role: "drafter", status: "planned", engine: "llm", provider: "openai", model: "gpt-4o-mini" },
    created_at: "2026-10-23T01:02:03.456Z"
  };
  const audit = toCoreEvidenceFromAuditLog(auditRow);
  const auditAgain = toCoreEvidenceFromAuditLog(auditRow);
  check("source_system=web-cad", audit.source_system === "web-cad");
  check("event_id is UUIDv7", /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(audit.event_id));
  check("event_id is stable", audit.event_id === auditAgain.event_id);
  check("status planned -> awaiting_approval", audit.status === "awaiting_approval");
  check("actor role mapped", audit.actor.role === "drafter" && audit.actor.status === "redacted");
  check("PII not emitted", !JSON.stringify(audit).includes("example.invalid"));
  check("schema is not claimed", audit.schema === null && audit.schema_status === "unsupported");
  check("unsupported listed", audit.unsupported.includes("run_id") && audit.unsupported.includes("usage"));

  const runRow = {
    id: "run_self_test_001",
    status: "completed",
    skill_id: "llm-proposal",
    skill_version: "0.1.0",
    proposal: { engine: "llm", provider: "anthropic", model: "claude-3-5-sonnet" },
    risk: "minor",
    drawing_id: "dwg_self_test_001",
    project_id: "prj_self_test_001",
    prompt: "この文字列は出力してはならない",
    created_by: "self.test@example.invalid",
    created_at: "2026-10-23T01:02:04.000Z"
  };
  const run = toCoreEvidenceFromAgentRun(runRow);
  check("agent run status mapped", run.status === "completed" && run.status_mapping === "mapped");
  check("source skill kept", run.source.skill?.id === "llm-proposal");
  check("source models kept", run.source.models?.engine === "llm" && run.source.models?.provider === "anthropic");
  check("Core skill not fabricated", run.skill === null && run.skill_status === "unsupported");
  check("project id format gap recorded", run.project_id === null && run.source.project_id === "prj_self_test_001");
  check("prompt/PII not emitted", !JSON.stringify(run).includes("この文字列") && !JSON.stringify(run).includes("example.invalid"));

  const lines = toJsonLines([audit, run]).trimEnd().split("\n");
  check("JSONL has one line per record", lines.length === 2 && lines.every((line) => JSON.parse(line).source_system === "web-cad"));

  const envelope = toCoreEventEnvelope(audit);
  check(
    "envelope matches core.event.envelope/1",
    envelope.schema === "core.event.envelope/1" &&
      envelope.specversion === "1.0" &&
      envelope.id === audit.event_id &&
      envelope.source === "web-cad" &&
      envelope.type === "evidence.recorded" &&
      envelope.time === audit.created_at
  );

  check("database name extracted", databaseNameFromUrl("postgresql://user:pw@db.example:5432/mirai_web_cad?sslmode=require") === "mirai_web_cad");
  let databaseError = "";
  try {
    databaseNameFromUrl("not a url with secret");
  } catch (error) {
    databaseError = String(error.message);
  }
  check("database name error hides secret", databaseError.length > 0 && !databaseError.includes("secret"));

  log(`self-test ok (${checks.length} checks)`);
  return checks.length;
}

async function run(options) {
  const connectionString = process.env.DATABASE_URL;
  const databaseName = databaseNameFromUrl(connectionString);
  // 接続情報はDB名のみ。ホスト・利用者・パスワードは表示しない。
  console.error(`export-core-evidence: 接続先DB=${databaseName} (読み取り専用)`);

  const { default: postgres } = await import("postgres");
  const sql = postgres(connectionString, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
    onnotice: () => {}
  });

  try {
    const { auditRows, agentRows, drawing } = await sql.begin(async (tx) => {
      // このトランザクションでは書き込みを一切許可しない(多層防御)。
      await tx.unsafe("set transaction read only");
      const drawingRow = options.drawingId
        ? (await tx`select id, project_id from drawings where id = ${options.drawingId} limit 1`)[0]
        : null;
      if (options.drawingId && !drawingRow) {
        throw new Error(`指定された図面が見つかりません: ${options.drawingId}`);
      }
      const audits = await selectAuditLogs(tx, options);
      const runs = await selectAgentRuns(tx, options);
      return { auditRows: audits, agentRows: runs, drawing: drawingRow ?? null };
    });

    const context = { projectId: drawing?.project_id ?? null, drawingId: options.drawingId };
    const records = [];
    if (options.source !== "agent-runs") {
      records.push(...auditRows.map((row) => toCoreEvidenceFromAuditLog(row, context)));
    }
    if (options.source !== "audit-logs") {
      records.push(...agentRows.map((row) => toCoreEvidenceFromAgentRun(row, context)));
    }
    records.sort(compareEvidence);
    const selected = records.slice(0, options.limit);
    const payload = options.envelope ? selected.map((record) => toCoreEventEnvelope(record)) : selected;
    const text = toJsonLines(payload);

    if (options.output && options.output !== "-") {
      const target = path.resolve(options.output);
      try {
        await writeFile(target, text, { encoding: "utf8", flag: options.force ? "w" : "wx" });
      } catch (error) {
        if (error && error.code === "EEXIST") {
          throw new Error(`出力先が既に存在します(--force で上書き): ${target}`);
        }
        throw error;
      }
      console.error(`export-core-evidence: 出力先=${target}`);
    } else if (options.output === "-" || options.output === null) {
      process.stdout.write(text);
    }

    console.error(
      `export-core-evidence: 監査ログ ${auditRows.length}件 / AI実行 ${agentRows.length}件 / 出力 ${selected.length}件` +
        (options.envelope ? " / 形式=event envelope" : "")
    );
    return selected.length;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function selectAuditLogs(tx, options) {
  if (options.source === "agent-runs") return [];
  if (options.drawingId) {
    // 図面自身への監査行と、その図面のAI実行記録への監査行。
    // actor_id(メールアドレス)はSELECTしない。
    return tx`
      select id, action, target_type, target_id, detail, created_at
      from audit_logs
      where (target_type = 'drawing' and target_id = ${options.drawingId})
         or (target_type = 'agent_run' and target_id in (
              select ar.id
              from agent_runs ar
              join drawing_versions dv on dv.id = ar.drawing_version_id
              where dv.drawing_id = ${options.drawingId}
            ))
      order by created_at asc, id asc
      limit ${options.limit}
    `;
  }
  return tx`
    select id, action, target_type, target_id, detail, created_at
    from audit_logs
    order by created_at asc, id asc
    limit ${options.limit}
  `;
}

export async function selectAgentRuns(tx, options) {
  if (options.source === "audit-logs") return [];
  // prompt(利用者の入力)とcreated_by(メールアドレス)はSELECTしない。
  if (options.drawingId) {
    return tx`
      select a.id, a.status, a.skill_id, a.skill_version, a.proposal, a.risk, a.created_at,
             dv.drawing_id, d.project_id
      from agent_runs a
      join drawing_versions dv on dv.id = a.drawing_version_id
      join drawings d on d.id = dv.drawing_id
      where dv.drawing_id = ${options.drawingId}
      order by a.created_at asc, a.id asc
      limit ${options.limit}
    `;
  }
  return tx`
    select a.id, a.status, a.skill_id, a.skill_version, a.proposal, a.risk, a.created_at,
           dv.drawing_id, d.project_id
    from agent_runs a
    join drawing_versions dv on dv.id = a.drawing_version_id
    join drawings d on d.id = dv.drawing_id
    order by a.created_at asc, a.id asc
    limit ${options.limit}
  `;
}

function compareEvidence(left, right) {
  const leftTime = left.created_at ?? "";
  const rightTime = right.created_at ?? "";
  if (leftTime !== rightTime) return leftTime < rightTime ? -1 : 1;
  const leftKey = `${left.source.table}:${left.source.id ?? ""}`;
  const rightKey = `${right.source.table}:${right.source.id ?? ""}`;
  if (leftKey === rightKey) return 0;
  return leftKey < rightKey ? -1 : 1;
}

// エラーメッセージに引数(資格情報を含み得る)をそのまま出さないための簡易マスク。
function redactArg(value) {
  return String(value).length > 40 ? `${String(value).slice(0, 8)}…` : String(value);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  if (options.selfTest) {
    runSelfTest();
    return 0;
  }
  return run(options);
}

const isMain =
  typeof process.argv[1] === "string" && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`export-core-evidence: ${message}`);
    process.exitCode = 1;
  });
}
