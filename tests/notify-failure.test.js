import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { flushUndelivered, issueTitle, notifyFailure, readToken, recordUndelivered } from "../scripts/notify-failure.mjs";

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
      if (request.method === "GET") {
        const page = Number(new URL(request.url, "http://x").searchParams.get("page") ?? "1");
        const issues = typeof openIssues === "function" ? openIssues(page) : page === 1 ? openIssues : [];
        return response.end(JSON.stringify(issues));
      }
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
      env: { ...process.env, NOTIFY_TOKEN_FILE: file, NOTIFY_API_BASE: "http://127.0.0.1:9", NOTIFY_REPO: "o/r", NOTIFY_RETRY_DELAY_MS: "0" }
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

test("an open notification issue on a later page is found instead of creating a duplicate", async () => {
  const filler = Array.from({ length: 100 }, (_, i) => ({ number: 1000 + i, title: `other ${i}` }));
  const pages = (page) => (page === 1 ? filler : page === 2 ? [{ number: 5, title: issueTitle("mirai-web-cad-backup.service") }] : []);
  await withGithub(pages, async ({ api, requests }) => {
    const outcome = await notifyFailure({ unit: "mirai-web-cad-backup.service", repo: "o/r", token: TOKEN, api, result: "Result=exit-code" });
    assert.deepEqual(outcome, { action: "commented", number: 5 });
    assert.deepEqual(requests.filter((entry) => entry.method === "POST").map((entry) => entry.url), ["/repos/o/r/issues/5/comments"]);
  });
});

// --- 再試行と未送信の永続化（Issue #168） -----------------------------------

async function withFlakyGithub(statuses, fn) {
  let calls = 0;
  const server = createServer((request, response) => {
    const status = statuses[Math.min(calls, statuses.length - 1)];
    calls += 1;
    if (request.method === "GET") {
      response.writeHead(status, { "content-type": "application/json" });
      return response.end(status === 200 ? JSON.stringify([]) : JSON.stringify({ message: "synthetic" }));
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ number: 77 }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await fn({ api: `http://127.0.0.1:${server.address().port}`, calls: () => calls });
  } finally {
    server.close();
  }
}

test("a transient 502 is retried and the notification is delivered", async () => {
  await withFlakyGithub([502, 200], async ({ api, calls }) => {
    const outcome = await notifyFailure({ unit: "mirai-web-cad-backup.service", repo: "o/r", token: TOKEN, api, result: "Result=exit-code", retryDelaysMs: [0, 0] });
    assert.deepEqual(outcome, { action: "created", number: 77 });
    assert.ok(calls() >= 2, `expected a retry, calls=${calls()}`);
  });
});

test("retries are bounded and the last error is reported", async () => {
  await withFlakyGithub([502], async ({ api, calls }) => {
    await assert.rejects(
      () => notifyFailure({ unit: "mirai-web-cad-backup.service", repo: "o/r", token: TOKEN, api, result: "", retryDelaysMs: [0, 0] }),
      /GitHub API GET .*: 502/
    );
    assert.equal(calls(), 3, "expected 1 attempt + 2 retries");
  });
});

test("a 401 is not retried", async () => {
  await withFlakyGithub([401], async ({ api, calls }) => {
    await assert.rejects(
      () => notifyFailure({ unit: "mirai-web-cad-backup.service", repo: "o/r", token: TOKEN, api, result: "", retryDelaysMs: [0, 0] }),
      /: 401/
    );
    assert.equal(calls(), 1);
  });
});

test("an undelivered notification is recorded and re-sent on the next run", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "notify-state-"));
  try {
    const marker = recordUndelivered("mirai-web-cad-backup.service", new Error("fetch failed"), dir);
    assert.ok(marker && existsSync(marker));
    assert.match(readFileSync(marker, "utf8"), /mirai-web-cad-backup\.service/);

    await withGithub([], async ({ api, requests }) => {
      const result = await flushUndelivered({ repo: "o/r", token: TOKEN, api, dir });
      assert.equal(result.sent.length, 1);
      assert.equal(result.failed.length, 0);
    });
    assert.equal(existsSync(marker), false, "a delivered notification must not be retried again");
    assert.equal(readdirSync(dir).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the CLI leaves a durable marker when delivery fails", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "notify-cli-state-"));
  try {
    const file = path.join(dir, "bot.env");
    writeFileSync(file, `MIRAI_BOT_TOKEN=${TOKEN}\n`);
    const state = path.join(dir, "state");
    const script = new URL("../scripts/notify-failure.mjs", import.meta.url).pathname;
    const error = await promisify(execFile)(process.execPath, [script, "mirai-web-cad-backup.service"], {
      env: { ...process.env, NOTIFY_TOKEN_FILE: file, NOTIFY_API_BASE: "http://127.0.0.1:9", NOTIFY_REPO: "o/r", NOTIFY_RETRY_DELAY_MS: "0", NOTIFY_STATE_DIR: state }
    }).catch((failure) => failure);
    assert.equal(error.code, 1);
    assert.match(error.stderr, /NOTIFY_UNDELIVERED: mirai-web-cad-backup\.service/);
    assert.equal(readdirSync(state).filter((name) => name.startsWith("undelivered-")).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
