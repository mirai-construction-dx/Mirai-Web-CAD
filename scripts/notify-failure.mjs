#!/usr/bin/env node
// systemdユニットの失敗をGitHub Issueで通知する(独立レビュー H-3)。
// deploy/systemd/mirai-web-cad-notify-failure@.service から、失敗したユニット名を引数に起動される
// (各ユニットの OnFailure=mirai-web-cad-notify-failure@%n.service)。
//
// - 同じユニットの未解決の通知Issueがあればコメントを追記し、なければIssueを作る(重複させない)。
// - 本文はユニット名・時刻・systemdの結果だけにする。ログには接続先等が含まれ得るため載せず、
//   確認用のコマンドを示す。
// - トークンは環境ファイルから1変数だけ読み、コマンドライン引数やログへ出さない。
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";

const UNIT_PATTERN = /^mirai-web-cad-[a-z0-9-]+\.(service|timer)$/;
export const TITLE_PREFIX = "[運用通知]";
const MAX_PAGES = 20;

export function readToken(file, variable) {
  const line = readFileSync(file, "utf8")
    .split("\n")
    .find((entry) => entry.startsWith(`${variable}=`));
  const value = line?.slice(variable.length + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
  if (!value) throw new Error(`${file} に ${variable} がありません`);
  return value;
}

export function unitResult(unit) {
  try {
    const output = execFileSync(
      "systemctl",
      ["show", "--property=Result,ExecMainStatus,ActiveEnterTimestamp,InactiveEnterTimestamp", unit],
      { encoding: "utf8", timeout: 10_000 }
    );
    return output.trim();
  } catch {
    return "(systemctl show で取得できませんでした)";
  }
}

export function issueTitle(unit) {
  return `${TITLE_PREFIX} ${unit} が失敗しました`;
}

export function issueBody(unit, result, at = new Date()) {
  const time = at.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  return [
    `\`${unit}\` が失敗しました(${time} JST、ホスト \`${hostname()}\`)。`,
    "",
    "```",
    result,
    "```",
    "",
    "確認と対応:",
    "",
    "```bash",
    `journalctl -u ${unit} -n 100 --no-pager`,
    `sudo systemctl start ${unit}   # 原因を解消してから再実行`,
    "```",
    "",
    "手順は docs/deployment-local.md の「バックアップ」を参照してください。解消したらこのIssueを閉じてください(未解決の間は同じIssueへ追記します)。",
    "",
    "_この通知は systemd の OnFailure から自動送信されました。_"
  ].join("\n");
}

// 一時的な失敗（ネットワーク・429・5xx）は再試行する。認証/検証エラー（4xx）は
// 何度送っても同じなので再試行しない。2026-10-16 の `fetch failed` は一時障害だった
// 可能性が高く、1回の失敗で通知を失わないことが目的（Issue #168）。
export const RETRY_DELAYS_MS = [1000, 4000];
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function github(api, token, method, requestPath, body, retryDelays = RETRY_DELAYS_MS) {
  const attempts = retryDelays.length + 1;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`${api}${requestPath}`, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "user-agent": "mirai-web-cad-notify-failure",
          "x-github-api-version": "2022-11-28"
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000)
      });
      if (response.ok) return await response.json();
      const error = new Error(`GitHub API ${method} ${requestPath}: ${response.status}`);
      error.status = response.status;
      lastError = error;
      if (!RETRYABLE_STATUS.has(response.status)) throw error;
    } catch (error) {
      lastError = error;
      // ネットワーク例外は status を持たない。再試行対象として扱う。
      if (error.status !== undefined && !RETRYABLE_STATUS.has(error.status)) throw error;
    }
    if (attempt === attempts - 1) break;
    await sleep(retryDelays[attempt] ?? retryDelays[retryDelays.length - 1]);
  }
  if (lastError?.status === undefined) {
    throw new Error(`fetch failed after ${attempts} attempt(s): ${lastError?.message ?? "unknown"}`);
  }
  throw lastError;
}

/**
 * 送れなかった通知を残す（再起動や次回実行で再送するため）。
 * StateDirectory（NOTIFY_STATE_DIR）が設定されている時だけ書く。
 */
export function recordUndelivered(unit, error, dir = process.env.NOTIFY_STATE_DIR) {
  if (!dir) return null;
  try {
    mkdirSync(dir, { recursive: true });
    const safe = unit.replace(/[^A-Za-z0-9@._-]/g, "_");
    const file = path.join(dir, `undelivered-${safe}.json`);
    writeFileSync(file, `${JSON.stringify({ unit, at: new Date().toISOString(), error: String(error?.message ?? error) }, null, 2)}\n`);
    return file;
  } catch {
    return null;
  }
}

/**
 * 残っている未送信の通知を再送する。成功したものだけ消す。
 * これが無いと「通知の失敗」は次の実行で上書きされて消える。
 */
export async function flushUndelivered({ repo, token, api = "https://api.github.com", retryDelaysMs = RETRY_DELAYS_MS, dir = process.env.NOTIFY_STATE_DIR } = {}) {
  if (!dir) return { sent: [], failed: [] };
  let names = [];
  try {
    names = readdirSync(dir).filter((name) => /^undelivered-.*\.json$/.test(name));
  } catch {
    return { sent: [], failed: [] };
  }
  const sent = [];
  const failed = [];
  for (const name of names) {
    const file = path.join(dir, name);
    let unit;
    try {
      unit = JSON.parse(readFileSync(file, "utf8")).unit;
    } catch {
      continue;
    }
    try {
      await notifyFailure({ unit, repo, token, api, retryDelaysMs });
      unlinkSync(file);
      sent.push({ unit, file });
    } catch {
      failed.push({ unit, file });
    }
  }
  return { sent, failed };
}

export async function notifyFailure({ unit, repo, token, api = "https://api.github.com", result = unitResult(unit), at = new Date(), retryDelaysMs = RETRY_DELAYS_MS }) {
  if (!UNIT_PATTERN.test(unit)) throw new Error(`通知対象外のユニット名です: ${unit}`);
  const title = issueTitle(unit);
  const body = issueBody(unit, result, at);
  let existing;
  // 未解決のIssueが100件を超えても重複を作らないよう、全ページを確認する。
  for (let page = 1; page <= MAX_PAGES && !existing; page += 1) {
    const open = await github(api, token, "GET", `/repos/${repo}/issues?state=open&per_page=100&page=${page}`, undefined, retryDelaysMs);
    existing = open.find((issue) => !issue.pull_request && issue.title === title);
    if (open.length < 100) break;
  }
  if (existing) {
    await github(api, token, "POST", `/repos/${repo}/issues/${existing.number}/comments`, { body }, retryDelaysMs);
    return { action: "commented", number: existing.number };
  }
  const created = await github(api, token, "POST", `/repos/${repo}/issues`, { title, body }, retryDelaysMs);
  return { action: "created", number: created.number };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const unit = process.argv[2] ?? "";
  try {
    const token = readToken(
      process.env.NOTIFY_TOKEN_FILE ?? `${process.env.HOME}/.config/codip/bot.env`,
      process.env.NOTIFY_TOKEN_VARIABLE ?? "MIRAI_BOT_TOKEN"
    );
    const repo = process.env.NOTIFY_REPO ?? "mirai-construction-dx/Mirai-Web-CAD";
    const api = process.env.NOTIFY_API_BASE ?? "https://api.github.com";
    const delay = Number(process.env.NOTIFY_RETRY_DELAY_MS ?? Number.NaN);
    const retryDelaysMs = Number.isFinite(delay) ? [delay, delay] : undefined;
    // 前回送れなかった通知を先に再送する（成功したものだけ消える）。
    const flushed = await flushUndelivered({ repo, token, api, retryDelaysMs });
    if (flushed.sent.length) console.log(`notify-failure retried: ${flushed.sent.map((entry) => entry.unit).join(", ")}`);
    const outcome = await notifyFailure({ unit, token, repo, api, retryDelaysMs });
    console.log(`notify-failure ${outcome.action}: #${outcome.number} (${unit})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const marker = recordUndelivered(unit, error);
    console.error(`notify-failure failed (${unit}): ${message}`);
    // 監視側（Mirai-Platform-Infra の collect_stg_state）が拾える明示的な印。
    console.error(`NOTIFY_UNDELIVERED: ${unit}${marker ? ` (${marker})` : ""}`);
    process.exit(1);
  }
}
