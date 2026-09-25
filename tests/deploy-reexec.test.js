import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// deploy-local.shが自分自身を更新するリリースで、新しい手順を使って再実行されることを、
// 一時Gitリポジトリとnpm/sudo/curlのスタブで検証する(本番環境には触れない)。
const script = readFileSync(new URL("../scripts/deploy-local.sh", import.meta.url), "utf8");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } }).trim();
}

test("deploy re-executes the updated script once and keeps the original rollback target", () => {
  const root = mkdtempSync(path.join(tmpdir(), "deploy-reexec-"));
  try {
    const origin = path.join(root, "origin.git");
    const work = path.join(root, "work");
    const bin = path.join(root, "bin");
    git(root, "init", "-q", "--bare", "-b", "main", origin);
    git(root, "clone", "-q", origin, work);
    mkdirSync(path.join(work, "scripts"));
    writeFileSync(path.join(work, "scripts/deploy-local.sh"), script);
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "v1");
    git(work, "push", "-q", "origin", "HEAD:main");
    const v1 = git(work, "rev-parse", "HEAD");
    // 別の開発者がデプロイ手順を変更してmainへ入れた状態を作る。
    const updater = path.join(root, "updater");
    git(root, "clone", "-q", origin, updater);
    writeFileSync(path.join(updater, "scripts/deploy-local.sh"), script.replace("npm run db:check\n", "echo v2-procedure\nnpm run db:check\n"));
    git(updater, "commit", "-q", "-am", "v2");
    git(updater, "push", "-q", "origin", "HEAD:main");
    const v2 = git(updater, "rev-parse", "HEAD");

    mkdirSync(bin);
    const stub = (name, body) => {
      writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
      chmodSync(path.join(bin, name), 0o755);
    };
    stub("npm", 'echo "npm $*"');
    stub("sudo", 'echo "sudo $*"');
    stub("curl", 'printf \'{"ok":true,"deploy":{"commit":"%s"}}\' "$(git rev-parse HEAD)"');
    stub("sleep", "exit 0");

    const output = execFileSync("bash", ["scripts/deploy-local.sh"], {
      cwd: work,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DATABASE_URL: "postgresql://stub.invalid/db" }
    });
    assert.match(output, /新しい手順で再実行します/);
    assert.match(output, /v2-procedure/, "the updated procedure must run");
    assert.equal(output.match(/新しい手順で再実行します/g).length, 1, "re-execution happens only once");
    assert.match(output, new RegExp(`ロールバック先: ${v1}`), "rollback target stays the pre-update commit");
    assert.match(output, new RegExp(`デプロイ成功: ${v2}`));
    assert.equal(git(work, "rev-parse", "HEAD"), v2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
