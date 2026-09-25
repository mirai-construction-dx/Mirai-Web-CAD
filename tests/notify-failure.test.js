import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { issueTitle, notifyFailure, readToken } from "../scripts/notify-failure.mjs";

// scripts/notify-failure.mjs を、GitHub APIを模したローカルHTTPサーバーで検証する。
const TOKEN = "test-token-not-real";

async function withGithub(openIssues, fn) {
  const requests = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      requests.push({ method: request.method, url: request.url, auth: request.headers.authorization, body: body ? JSON.parse(body) : null });
      response.setHeader("content-type", "application/json");
      if (request.method === "GET") return response.end(JSON.stringify(openIssues));
      if (request.url.endsWith("/comments")) return response.end(JSON.stringify({ id: 1 }));
      response.end(JSON.stringify({ number: 42 }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await fn({ api: `http://127.0.0.1:${server.address().port}`, requests });
  } finally {
    server.close();
  }
}

test("a failure creates one issue with the unit, result and how to investigate", async () => {
  await withGithub([], async ({ api, requests }) => {
    const outcome = await notifyFailure({ unit: "mirai-web-cad-backup.service", repo: "o/r", token: TOKEN, api, result: "Result=exit-code\nExecMainStatus=1" });
    assert.deepEqual(outcome, { action: "created", number: 42 });
    const created = requests.find((entry) => entry.method === "POST");
    assert.equal(created.url, "/repos/o/r/issues");
    assert.equal(created.auth, `Bearer ${TOKEN}`);
    assert.equal(created.body.title, "[運用通知] mirai-web-cad-backup.service が失敗しました");
    assert.match(created.body.body, /Result=exit-code/);
    assert.match(created.body.body, /journalctl -u mirai-web-cad-backup.service/);
    assert.equal(JSON.stringify(created.body).includes(TOKEN), false);
  });
});

test("a repeated failure comments on the open issue instead of creating another", async () => {
  const open = [
    { number: 7, title: issueTitle("mirai-web-cad-backup.service"), pull_request: { url: "x" } },
    { number: 9, title: issueTitle("mirai-web-cad-backup.service") }
  ];
  await withGithub(open, async ({ api, requests }) => {
    const outcome = await notifyFailure({ unit: "mirai-web-cad-backup.service", repo: "o/r", token: TOKEN, api, result: "Result=exit-code" });
    assert.deepEqual(outcome, { action: "commented", number: 9 });
    assert.deepEqual(requests.filter((entry) => entry.method === "POST").map((entry) => entry.url), ["/repos/o/r/issues/9/comments"]);
  });
});

test("only this product's units can be notified", async () => {
  await assert.rejects(
    () => notifyFailure({ unit: "ssh.service", repo: "o/r", token: TOKEN, api: "http://127.0.0.1:9", result: "" }),
    /通知対象外/
  );
});

test("the token is read as a single variable, with outer quotes removed", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "notify-"));
  try {
    const file = path.join(dir, "bot.env");
    writeFileSync(file, `OTHER=1\nMIRAI_BOT_TOKEN="${TOKEN}"\n`);
    assert.equal(readToken(file, "MIRAI_BOT_TOKEN"), TOKEN);
    assert.throws(() => readToken(file, "MISSING"), /MISSING がありません/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the CLI reports a failure without printing the token", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "notify-cli-"));
  try {
    const file = path.join(dir, "bot.env");
    writeFileSync(file, `MIRAI_BOT_TOKEN=${TOKEN}\n`);
    const script = new URL("../scripts/notify-failure.mjs", import.meta.url).pathname;
    const error = await promisify(execFile)(process.execPath, [script, "mirai-web-cad-backup.service"], {
      env: { ...process.env, NOTIFY_TOKEN_FILE: file, NOTIFY_API_BASE: "http://127.0.0.1:9", NOTIFY_REPO: "o/r" }
    }).catch((failure) => failure);
    assert.equal(error.code, 1);
    assert.match(error.stderr, /notify-failure failed \(mirai-web-cad-backup.service\)/);
    assert.equal(`${error.stdout}${error.stderr}`.includes(TOKEN), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every backup, freshness check, restore drill and offsite unit notifies on failure", () => {
  const dir = new URL("../deploy/systemd/", import.meta.url).pathname;
  const units = readdirSync(dir).filter((name) => /(backup|backup-check|restore-drill)\.service$/.test(name));
  assert.ok(units.length >= 7, units.join(","));
  for (const name of units) {
    assert.match(readFileSync(path.join(dir, name), "utf8"), /^OnFailure=mirai-web-cad-notify-failure@%n\.service$/m, name);
  }
  const template = readFileSync(path.join(dir, "mirai-web-cad-notify-failure@.service"), "utf8");
  assert.match(template, /^ExecStart=\/usr\/bin\/env node scripts\/notify-failure\.mjs %i$/m);
  assert.doesNotMatch(template, /OnFailure=/, "the notifier must not notify about itself");
});
