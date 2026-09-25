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
import { readFileSync } from "node:fs";
import { hostname } from "node:os";

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

async function github(api, token, method, path, body) {
  const response = await fetch(`${api}${path}`, {
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
  if (!response.ok) throw new Error(`GitHub API ${method} ${path}: ${response.status}`);
  return response.json();
}

export async function notifyFailure({ unit, repo, token, api = "https://api.github.com", result = unitResult(unit), at = new Date() }) {
  if (!UNIT_PATTERN.test(unit)) throw new Error(`通知対象外のユニット名です: ${unit}`);
  const title = issueTitle(unit);
  const body = issueBody(unit, result, at);
  let existing;
  // 未解決のIssueが100件を超えても重複を作らないよう、全ページを確認する。
  for (let page = 1; page <= MAX_PAGES && !existing; page += 1) {
    const open = await github(api, token, "GET", `/repos/${repo}/issues?state=open&per_page=100&page=${page}`);
    existing = open.find((issue) => !issue.pull_request && issue.title === title);
    if (open.length < 100) break;
  }
  if (existing) {
    await github(api, token, "POST", `/repos/${repo}/issues/${existing.number}/comments`, { body });
    return { action: "commented", number: existing.number };
  }
  const created = await github(api, token, "POST", `/repos/${repo}/issues`, { title, body });
  return { action: "created", number: created.number };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const unit = process.argv[2] ?? "";
  try {
    const token = readToken(
      process.env.NOTIFY_TOKEN_FILE ?? `${process.env.HOME}/.config/codip/bot.env`,
      process.env.NOTIFY_TOKEN_VARIABLE ?? "MIRAI_BOT_TOKEN"
    );
    const outcome = await notifyFailure({
      unit,
      token,
      repo: process.env.NOTIFY_REPO ?? "mirai-construction-dx/Mirai-Web-CAD",
      api: process.env.NOTIFY_API_BASE ?? "https://api.github.com"
    });
    console.log(`notify-failure ${outcome.action}: #${outcome.number} (${unit})`);
  } catch (error) {
    console.error(`notify-failure failed (${unit}): ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
