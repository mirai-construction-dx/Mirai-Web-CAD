import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// deploy-local.sh の手順(別ディレクトリでのbuild、DB検証、symlinkの一括切替、本番とMVPの確認、
// ロールバック、手順自体の更新)を、一時Gitリポジトリとnpm/sudo/systemctl/curlのスタブで検証する。
// 本番環境・DB・ネットワークには一切触れない。
const script = readFileSync(new URL("../scripts/deploy-local.sh", import.meta.url), "utf8");
const gitignore = "/dist\n/node_modules\n/.releases/\n/.swap-*\n";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } }).trim();
}

function stub(bin, name, body) {
  writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path.join(bin, name), 0o755);
}

// v1を稼働中(実体のdist/とnode_modules/あり)として置き、v2をmainへpushした状態を作る。
function setup(root, { updateScript = (current) => current, legacyBuildInfo = true } = {}) {
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const bin = path.join(root, "bin");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, work);
  mkdirSync(path.join(work, "scripts"));
  writeFileSync(path.join(work, "scripts/deploy-local.sh"), script);
  writeFileSync(path.join(work, ".gitignore"), gitignore);
  writeFileSync(path.join(work, "app.txt"), "v1\n");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "v1");
  git(work, "push", "-q", "origin", "HEAD:main");
  const v1 = git(work, "rev-parse", "HEAD");
  // 稼働中のv1: 以前の方式で作業ツリーに直接作られたdistとnode_modules。
  mkdirSync(path.join(work, "dist"));
  if (legacyBuildInfo) writeFileSync(path.join(work, "dist/build-info.json"), JSON.stringify({ commit: v1 }));
  mkdirSync(path.join(work, "node_modules"));

  const updater = path.join(root, "updater");
  git(root, "clone", "-q", origin, updater);
  writeFileSync(path.join(updater, "app.txt"), "v2\n");
  writeFileSync(path.join(updater, "scripts/deploy-local.sh"), updateScript(script));
  git(updater, "commit", "-q", "-am", "v2");
  git(updater, "push", "-q", "origin", "HEAD:main");
  const v2 = git(updater, "rev-parse", "HEAD");

  mkdirSync(bin);
  const log = path.join(root, "calls.log");
  stub(bin, "npm", `
case "$1 \${2:-}" in
  "ci "*) echo "npm ci" >> "${log}"; mkdir -p node_modules; echo "$PWD" > node_modules/.installed-in ;;
  "run build") mkdir -p dist; printf '{"commit":"%s"}' "$BUILD_COMMIT" > dist/build-info.json ;;
  "run db:check") echo "db:check $DATABASE_URL" >> "${log}"; [[ "$DATABASE_URL" == "\${STUB_DBCHECK_FAIL:-none}" ]] && exit 1; exit 0 ;;
esac`);
  // MVPのユニットは、systemdと同じく値を引用符で囲んだ環境ファイルを読む想定にする。
  const mvpEnv = path.join(root, "units/mvp.env");
  mkdirSync(path.dirname(mvpEnv));
  writeFileSync(mvpEnv, 'NODE_ENV=production\nDATABASE_URL="postgresql://stub.invalid/mvp"\n');
  stub(bin, "systemctl", `
[[ -z "\${STUB_MVP:-}" ]] && exit 1
[[ "$1" == "cat" ]] && exit 0
[[ "$1" == "show" ]] && echo "${mvpEnv} (ignore_errors=no)"
exit 0`);
  stub(bin, "sudo", `echo "sudo $*" >> "${log}"`);
  // healthは作業ツリーのHEADと、dist(symlinkを辿る)のbuild元を返す。STUB_BREAK_COMMITに一致すれば不健全。
  stub(bin, "curl", `
commit="$(git rev-parse HEAD)"
dist="$(sed -n 's/.*"commit":"\\([^"]*\\)".*/\\1/p' dist/build-info.json 2>/dev/null)"
if [[ "$commit" == "\${STUB_BREAK_COMMIT:-none}" ]]; then printf '{"ok":false}'; exit 0; fi
printf '{"ok":true,"deploy":{"commit":"%s","distCommit":"%s"}}' "$commit" "$dist"`);
  stub(bin, "sleep", "exit 0");
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: root,
    DATABASE_URL: "postgresql://stub.invalid/prod"
  };
  return { work, v1, v2, env, log };
}

function deploy(work, env) {
  try {
    return { status: 0, output: execFileSync("bash", ["scripts/deploy-local.sh"], { cwd: work, encoding: "utf8", env, stdio: "pipe" }) };
  } catch (error) {
    return { status: error.status, output: `${error.stdout}${error.stderr}` };
  }
}

const calls = (log) => (existsSync(log) ? readFileSync(log, "utf8") : "");

function withRepo(fn, options) {
  const root = mkdtempSync(path.join(tmpdir(), "deploy-local-"));
  try {
    fn(setup(root, options));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("deploy builds outside the live tree, switches symlinks and verifies production and MVP", () => {
  withRepo(({ work, v1, v2, env, log }) => {
    const result = deploy(work, { ...env, STUB_MVP: "1" });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, new RegExp(`デプロイ成功: ${v2}`));
    assert.equal(git(work, "rev-parse", "HEAD"), v2);
    // dist と node_modules は、対象commitのリリースを指すsymlinkになる。
    for (const name of ["dist", "node_modules"]) {
      assert.ok(lstatSync(path.join(work, name)).isSymbolicLink(), `${name} must be a symlink`);
      assert.equal(readlinkSync(path.join(work, name)), `.releases/${v2}/${name}`);
    }
    assert.equal(JSON.parse(readFileSync(path.join(work, "dist/build-info.json"), "utf8")).commit, v2);
    // 依存の導入とbuildは稼働中のツリーではなくリリースのディレクトリで行う。
    assert.match(readFileSync(path.join(work, "node_modules/.installed-in"), "utf8"), new RegExp(`\\.releases/${v2}\\.tmp`));
    // 以前の実体は退避され、ロールバック先として残る。
    assert.equal(JSON.parse(readFileSync(path.join(work, `.releases/legacy-${v1}/dist/build-info.json`), "utf8")).commit, v1);
    const recorded = calls(log);
    assert.match(recorded, /db:check postgresql:\/\/stub.invalid\/prod/);
    // MVPはユニットの環境ファイルの値を、外側の引用符を外して使う。
    assert.match(recorded, /db:check postgresql:\/\/stub.invalid\/mvp$/m);
    assert.match(recorded, /sudo systemctl restart mirai-web-cad.service/);
    assert.match(recorded, /sudo systemctl restart mirai-web-cad-mvp.service/);
    assert.equal(git(work, "status", "--porcelain"), "", "symlinks and releases must be ignored by git");
  });
});

test("a failing MVP db:check aborts before anything live changes", () => {
  withRepo(({ work, v1, env, log }) => {
    const result = deploy(work, { ...env, STUB_MVP: "1", STUB_DBCHECK_FAIL: "postgresql://stub.invalid/mvp" });
    assert.notEqual(result.status, 0);
    assert.equal(git(work, "rev-parse", "HEAD"), v1);
    assert.ok(!lstatSync(path.join(work, "dist")).isSymbolicLink(), "live dist must stay untouched");
    assert.equal(JSON.parse(readFileSync(path.join(work, "dist/build-info.json"), "utf8")).commit, v1);
    assert.doesNotMatch(calls(log), /systemctl restart/);
  });
});

test("an unhealthy release is rolled back to the previous commit and assets", () => {
  withRepo(({ work, v1, v2, env, log }) => {
    const result = deploy(work, { ...env, STUB_MVP: "1", STUB_BREAK_COMMIT: v2 });
    assert.notEqual(result.status, 0);
    assert.match(result.output, new RegExp(`ロールバック完了: ${v1}`));
    assert.equal(git(work, "rev-parse", "HEAD"), v1);
    assert.equal(readlinkSync(path.join(work, "dist")), `.releases/legacy-${v1}/dist`);
    assert.equal(JSON.parse(readFileSync(path.join(work, "dist/build-info.json"), "utf8")).commit, v1);
    // 本処理と rollback の両方で、本番とMVPを再起動する。
    assert.equal(calls(log).match(/restart mirai-web-cad-mvp.service/g).length, 2);
  });
});

test("MVP is skipped when its unit is not installed", () => {
  withRepo(({ work, v2, env, log }) => {
    const result = deploy(work, env);
    assert.equal(result.status, 0, result.output);
    assert.equal(git(work, "rev-parse", "HEAD"), v2);
    assert.doesNotMatch(calls(log), /mvp/);
  });
});

test("an updated deploy script is re-executed once before anything changes", () => {
  withRepo(({ work, v2, env }) => {
    const result = deploy(work, env);
    assert.equal(result.status, 0, result.output);
    assert.equal(result.output.match(/新しい手順で再実行します/g).length, 1);
    assert.match(result.output, /v2-procedure/);
    assert.equal(git(work, "rev-parse", "HEAD"), v2);
  }, { updateScript: (current) => current.replace('echo "デプロイ対象: $new_sha"', 'echo "デプロイ対象: $new_sha"\necho v2-procedure') });
});

test("an updated deploy script with a syntax error aborts without changing anything", () => {
  withRepo(({ work, v1, env, log }) => {
    const result = deploy(work, env);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /構文エラー/);
    assert.equal(git(work, "rev-parse", "HEAD"), v1);
    assert.ok(!lstatSync(path.join(work, "dist")).isSymbolicLink());
    assert.doesNotMatch(calls(log), /systemctl restart/);
  }, { updateScript: (current) => `${current}\nif then\n` });
});

test("redeploying the live commit reuses its release instead of deleting it", () => {
  withRepo(({ work, v2, env, log }) => {
    assert.equal(deploy(work, env).status, 0);
    const again = deploy(work, env);
    assert.equal(again.status, 0, again.output);
    assert.match(again.output, /再利用します/);
    assert.equal(calls(log).match(/npm ci/g).length, 1);
    assert.equal(readlinkSync(path.join(work, "dist")), `.releases/${v2}/dist`);
  });
});

test("rollback to a legacy dist without build-info.json is verified by health and commit only", () => {
  withRepo(({ work, v1, v2, env }) => {
    const result = deploy(work, { ...env, STUB_BREAK_COMMIT: v2 });
    assert.notEqual(result.status, 0);
    assert.match(result.output, new RegExp(`ロールバック完了: ${v1}`));
    assert.doesNotMatch(result.output, /ロールバック後の確認に失敗/);
  }, { legacyBuildInfo: false });
});
