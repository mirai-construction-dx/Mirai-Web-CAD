#!/usr/bin/env node
// 本番稼働中のコードがレビュー済みの origin/main と一致しているかを検査する。
//
// 事故(Issue #98): 本番ホストのローカルmainに未マージのPR #87ブランチのcommitが
// 入ったまま稼働が続き、人手で気づくまで検出できなかった。このスクリプトは
//   (a) デプロイ対象の作業ツリーが origin/main と一致しているか
//   (b) 実際に稼働しているAPIが報告するcommitと一致しているか(--url指定時)
// の2点を機械的に比較し、ずれがあれば非ゼロ終了する。
//
// 「判定できない」を「一致」と報告しないこと(fail-openにしないこと)を設計原則とする。
//
// 使い方:
//   node scripts/check-deploy-drift.mjs                        # 作業ツリーのみ判定
//   node scripts/check-deploy-drift.mjs --url http://127.0.0.1:18812
//   node scripts/check-deploy-drift.mjs --remote               # origin/mainの最新をls-remoteで確認
//   node scripts/check-deploy-drift.mjs --json
//
// 終了コード: 0=一致(またはデプロイ待ち), 1=乖離あり, 2=判定不能
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DEPLOY_PROVENANCE, evaluateDeployProvenance } from "./lib/deploy-info.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const asJson = args.includes("--json");
const useRemote = args.includes("--remote");
const url = readOption("--url") ?? null;

const evaluation = evaluateDeployProvenance({ cwd: repoRoot });
const reasons = [...evaluation.reasons];
let fatal = evaluation.status === DEPLOY_PROVENANCE.AHEAD || evaluation.status === DEPLOY_PROVENANCE.DIRTY;
let canJudge = evaluation.status !== DEPLOY_PROVENANCE.UNKNOWN;

// 稼働APIの報告値との突き合わせ。--url を指定したのに取得できない場合は
// 「稼働プロセスを検証できなかった」ことを失敗として扱う(見逃しを防ぐ)。
let runningCommit = null;
let runningDistCommit = null;
if (url) {
  const running = await readRunningCommit(url);
  if (running.ok && running.commit) {
    runningCommit = running.commit;
    runningDistCommit = running.distCommit;
    if (evaluation.info.commit && runningCommit !== evaluation.info.commit) {
      reasons.push(`稼働APIが報告するcommit(${short(runningCommit)})と作業ツリーのcommit(${short(evaluation.info.commit)})が一致しません`);
      fatal = true;
    }
    // 画面(dist/)はリクエストごとに読まれるため、サーバーと別のcommitからbuildされた配信物が
    // 混ざっていても稼働commitだけでは検出できない(独立レビュー H-1)。
    if (runningDistCommit !== runningCommit) {
      reasons.push(`配信中の画面のbuild元(${runningDistCommit ? short(runningDistCommit) : "不明"})が稼働commit(${short(runningCommit)})と一致しません`);
      fatal = true;
    }
  } else {
    reasons.push(`稼働API(${url})から稼働commitを取得できませんでした: ${running.error}`);
    canJudge = false;
  }
}

// リモートのmainが進んでいるだけの場合は「デプロイ待ち」であり乖離ではない。
// ローカルrefが古い可能性の情報提供に留める(誤検知で運用を止めない)。
let remoteMain = null;
if (useRemote) {
  remoteMain = readRemoteMain();
  if (remoteMain && evaluation.info.originMain && remoteMain !== evaluation.info.originMain) {
    reasons.push("ローカルのorigin/main参照がリモートより古い可能性があります(git fetchで更新してから再実行)");
  }
}

const ok = canJudge && !fatal;
const report = {
  checkedAt: new Date().toISOString(),
  ok,
  status: canJudge ? evaluation.status : DEPLOY_PROVENANCE.UNKNOWN,
  local: evaluation.info,
  counts: evaluation.counts,
  runningApiCommit: runningCommit,
  runningDistCommit,
  remoteMain,
  driftReasons: reasons
};

if (asJson) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  printHumanReport(report);
}

process.exitCode = ok ? 0 : fatal ? 1 : 2;

function printHumanReport(current) {
  const lines = [];
  lines.push(`デプロイ素性検査: ${current.checkedAt}`);
  lines.push(`  作業ツリー commit : ${current.local.commit ?? "不明"} (${current.local.branch ?? "detached"})`);
  lines.push(`  origin/main      : ${current.local.originMain ?? "未取得"}`);
  lines.push(`  ahead/behind     : ${current.counts ? `${current.counts.ahead} / ${current.counts.behind}` : "不明"}`);
  lines.push(`  未コミット変更    : ${current.local.dirty === null ? "不明" : current.local.dirty ? "あり" : "なし"}`);
  if (current.runningApiCommit) lines.push(`  稼働APIのcommit   : ${current.runningApiCommit}`);
  if (current.runningApiCommit) lines.push(`  配信物のbuild元   : ${current.runningDistCommit ?? "不明"}`);
  if (current.remoteMain) lines.push(`  リモート origin/main: ${current.remoteMain}`);
  lines.push(`  判定             : ${label(current.status)}`);
  for (const reason of current.driftReasons) lines.push(`   - ${reason}`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

function label(status) {
  if (status === DEPLOY_PROVENANCE.VERIFIED) return "一致(レビュー済みmainと同一)";
  if (status === DEPLOY_PROVENANCE.BEHIND) return "デプロイ待ち(本番がorigin/mainより遅れ)";
  if (status === DEPLOY_PROVENANCE.AHEAD) return "乖離(未レビューのcommitが稼働している可能性)";
  if (status === DEPLOY_PROVENANCE.DIRTY) return "乖離(未コミット変更が稼働している可能性)";
  return "判定不能";
}

function readOption(name) {
  const withEquals = args.find((arg) => arg.startsWith(`${name}=`));
  if (withEquals) return withEquals.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

// リモートのmainを読み取り専用で確認する。ローカルのrefは書き換えない(ls-remoteは
// fetchと違いrefs/remotes配下を更新しない)。
function readRemoteMain() {
  try {
    const output = execFileSync("git", ["ls-remote", "origin", "refs/heads/main"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15000
    }).trim();
    const commit = output.split(/\s+/)[0];
    return commit || null;
  } catch {
    return null;
  }
}

// 稼働中APIの /api/health が報告するcommitを読む。HTTPステータスが503(degraded)でも
// 本文にはdeployブロックが含まれるため、ステータスでは判定せず本文を解析する。
// 未対応バージョン(本機能より前にデプロイされたもの)ではdeployブロックが無い。
async function readRunningCommit(baseUrl) {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/health`, {
      signal: AbortSignal.timeout(10000)
    });
    const body = await response.json().catch(() => null);
    const commit = body?.deploy?.commit;
    const distCommit = typeof body?.deploy?.distCommit === "string" ? body.deploy.distCommit : null;
    if (typeof commit === "string" && commit.length > 0) return { ok: true, commit, distCommit };
    return { ok: false, error: `deploy.commitが応答に含まれていません(HTTP ${response.status})` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function short(commit) {
  return typeof commit === "string" ? commit.slice(0, 7) : String(commit);
}
