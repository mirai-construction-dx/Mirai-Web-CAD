import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// deploy-staging.sh(Stagingの独立リリース)を、一時Gitリポジトリとnpm/sudo/systemctl/curlの
// スタブで検証する。本番/ステージングのホスト・DB・systemd・ネットワークには一切触れない。
// 検証対象: 専用ランタイムへの構築、DB check、currentの原子切替、Stagingのみの再起動、
// health検証(commit/distCommit/DB名)、失敗時のロールバック、古いreleaseの掃除、秘密非出力。
const script = readFileSync(new URL("../scripts/deploy-staging.sh", import.meta.url), "utf8");
const gitignore = "/dist\n/node_modules\n/.releases/\n";
const SECRET = "SUPERSECRET-should-not-be-logged";
const DATABASE_URL = `postgresql://mirai_web_cad_app:${SECRET}@stub.invalid:5432/mirai_web_cad_staging`;

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid"
    }
  }).trim();
}

function stub(bin, name, body) {
  writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path.join(bin, name), 0o755);
}

// v1を初期状態として置き、v2〜v5をorigin/mainへ積んだ状態を作る。
function setup(root) {
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const bin = path.join(root, "bin");
  const runtime = path.join(root, "runtime");
  const envFile = path.join(root, "staging.env");
  const log = path.join(root, "calls.log");

  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, work);
  mkdirSync(path.join(work, "scripts"), { recursive: true });
  writeFileSync(path.join(work, "scripts/deploy-staging.sh"), script);
  chmodSync(path.join(work, "scripts/deploy-staging.sh"), 0o755);
  writeFileSync(path.join(work, ".gitignore"), gitignore);
  writeFileSync(path.join(work, "app.txt"), "v1\n");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "v1");
  git(work, "push", "-q", "origin", "HEAD:main");
  const shas = { v1: git(work, "rev-parse", "HEAD") };

  const updater = path.join(root, "updater");
  git(root, "clone", "-q", origin, updater);
  for (const name of ["v2", "v3", "v4", "v5"]) {
    writeFileSync(path.join(updater, "app.txt"), `${name}\n`);
    git(updater, "commit", "-q", "-am", name);
    git(updater, "push", "-q", "origin", "HEAD:main");
    shas[name] = git(updater, "rev-parse", "HEAD");
  }

  // staging.envはsystemdと同じく値を引用符で囲む。sourceせずsedで1変数だけ読めることを確認する。
  writeFileSync(envFile, `NODE_ENV=production\nDATABASE_URL="${DATABASE_URL}"\n`);

  mkdirSync(bin);
  stub(bin, "npm", `
case "$1 \${2:-}" in
  "ci "*) echo "npm ci $PWD" >> "${log}"; mkdir -p node_modules; echo "$PWD" > node_modules/.installed-in ;;
  "run build") echo "npm run build $PWD" >> "${log}"; mkdir -p dist; printf '{"commit":"%s"}' "$BUILD_COMMIT" > dist/build-info.json ;;
  "run db:check") echo "db:check $DATABASE_URL" >> "${log}"; [[ "\${STUB_DBCHECK_FAIL:-none}" == "$DATABASE_URL" ]] && exit 1; exit 0 ;;
esac`);
  stub(bin, "sudo", `echo "sudo $*" >> "${log}"; exit 0`);
  stub(bin, "systemctl", `echo "systemctl $*" >> "${log}"; exit 0`);
  stub(bin, "sleep", "exit 0");
  // healthはcurrentの向き先(release名)と、そのreleaseのbuild元commitを返す。
  // STUB_BREAK_COMMITに一致するreleaseは不健全、STUB_NO_DEPLOY_COMMIT=1ならdeploy.commitを省略する。
  stub(bin, "curl", `
target="$(readlink "${runtime}/current" 2>/dev/null || true)"
sha=""
if [[ -n "$target" ]]; then sha="$(basename "$target")"; fi
dist=""
if [[ -n "$target" && -f "${runtime}/$target/dist/build-info.json" ]]; then
  dist="$(sed -n 's/.*"commit":"\\([^"]*\\)".*/\\1/p' "${runtime}/$target/dist/build-info.json" 2>/dev/null || true)"
fi
if [[ -z "$sha" || "$sha" == "\${STUB_BREAK_COMMIT:-none}" ]]; then printf '{"ok":false}'; exit 0; fi
db="\${STUB_HEALTH_DB:-mirai_web_cad_staging}"
if [[ "\${STUB_NO_DEPLOY_COMMIT:-}" == "1" ]]; then
  printf '{"ok":true,"deploy":{"commit":null,"distCommit":"%s"},"db":{"mode":"connected","migrated":true,"database":"%s"}}' "$dist" "$db"
else
  printf '{"ok":true,"deploy":{"commit":"%s","distCommit":"%s"},"db":{"mode":"connected","migrated":true,"database":"%s"}}' "$sha" "$dist" "$db"
fi`);

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: root,
    STAGING_RUNTIME_ROOT: runtime,
    STAGING_ENV_FILE: envFile,
    STAGING_HEALTH_ATTEMPTS: "2",
    STAGING_HEALTH_INTERVAL: "0"
  };
  return { work, runtime, envFile, env, log, shas };
}

function deploy(work, env, args = []) {
  try {
    return {
      status: 0,
      output: execFileSync("bash", ["scripts/deploy-staging.sh", ...args], {
        cwd: work,
        encoding: "utf8",
        env,
        stdio: "pipe"
      })
    };
  } catch (error) {
    return { status: error.status, output: `${error.stdout}${error.stderr}` };
  }
}

const calls = (log) => (existsSync(log) ? readFileSync(log, "utf8") : "");

function withRepo(fn) {
  const root = mkdtempSync(path.join(tmpdir(), "deploy-staging-"));
  try {
    fn(setup(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("deploy-staging builds in the dedicated runtime, switches current and restarts only staging", () => {
  withRepo(({ work, runtime, env, log, shas }) => {
    const result = deploy(work, env);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, new RegExp(`Stagingデプロイ成功: ${shas.v5}`));

    // currentは対象releaseを指すsymlinkで、build-info.jsonが対象commitを記録する。
    assert.equal(readlinkSync(path.join(runtime, "current")), `releases/${shas.v5}`);
    assert.equal(
      JSON.parse(readFileSync(path.join(runtime, `releases/${shas.v5}/dist/build-info.json`), "utf8")).commit,
      shas.v5
    );
    // 依存導入とbuildは、currentを切り替える前の一時ディレクトリで行う。
    assert.match(
      readFileSync(path.join(runtime, `releases/${shas.v5}/node_modules/.installed-in`), "utf8").trim(),
      new RegExp(`releases/${shas.v5}\\.tmp$`)
    );
    assert.ok(!existsSync(path.join(runtime, ".current.swap")), "一時symlinkが残ってはならない");

    // DB checkはstaging.envのURL(引用符を外した値)で実行し、Stagingサービスだけを再起動する。
    const recorded = calls(log);
    assert.ok(recorded.includes(`db:check ${DATABASE_URL}`));
    assert.equal(recorded.match(/restart mirai-web-cad-staging\.service/g)?.length, 1);
    assert.doesNotMatch(recorded, /mirai-web-cad\.service|mirai-web-cad-mvp\.service/);

    // 秘密値(DATABASE_URLのパスワード)を出力しない。
    assert.ok(!result.output.includes(SECRET));
    assert.ok(!result.output.includes(DATABASE_URL));

    // 本番・MVPが使う作業ツリーはfast-forwardもsymlink変更もしない(HEADはv1のまま)。
    assert.equal(git(work, "rev-parse", "HEAD"), shas.v1);
    assert.equal(git(work, "status", "--porcelain"), "");
  });
});

test("a failing db:check aborts before current is switched or the service is restarted", () => {
  withRepo(({ runtime, work, env, log, shas }) => {
    const result = deploy(work, { ...env, STUB_DBCHECK_FAIL: DATABASE_URL });
    assert.notEqual(result.status, 0);
    assert.ok(!existsSync(path.join(runtime, "current")), "currentを作ってはならない");
    assert.ok(existsSync(path.join(runtime, `releases/${shas.v5}`)), "build自体は完了している");
    assert.doesNotMatch(calls(log), /restart/);
    assert.ok(!result.output.includes(SECRET));
  });
});

test("a staging.env pointing at the production database is rejected before building", () => {
  withRepo(({ work, env, envFile, log }) => {
    const productionUrl = `postgresql://mirai_web_cad_app:${SECRET}@stub.invalid:5432/mirai_web_cad`;
    writeFileSync(envFile, `DATABASE_URL="${productionUrl}"\n`);
    const result = deploy(work, env);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /DB名が mirai_web_cad_staging と一致しません/);
    assert.doesNotMatch(calls(log), /npm ci|restart/);
    assert.ok(!result.output.includes(SECRET));
    assert.ok(!result.output.includes(productionUrl));
  });
});

test("an unhealthy release is rolled back to the previous current and re-verified", () => {
  withRepo(({ work, runtime, env, log, shas }) => {
    assert.equal(deploy(work, env, [shas.v4]).status, 0);
    const result = deploy(work, { ...env, STUB_BREAK_COMMIT: shas.v5 });
    assert.notEqual(result.status, 0);
    assert.match(result.output, new RegExp(`ロールバック完了: ${shas.v4}`));
    assert.equal(readlinkSync(path.join(runtime, "current")), `releases/${shas.v4}`);
    assert.equal(
      JSON.parse(readFileSync(path.join(runtime, `releases/${shas.v4}/dist/build-info.json`), "utf8")).commit,
      shas.v4
    );
    // 初回デプロイ(v4)・v5のデプロイ・rollbackの3回、Stagingだけを再起動する。
    assert.equal(calls(log).match(/restart mirai-web-cad-staging\.service/g)?.length, 3);
    assert.doesNotMatch(calls(log), /restart mirai-web-cad\.service|restart mirai-web-cad-mvp\.service/);
    assert.ok(!result.output.includes(SECRET));
  });
});

test("a failed first deployment has no previous current and stops staging instead of serving it", () => {
  withRepo(({ work, runtime, env, log, shas }) => {
    const result = deploy(work, { ...env, STUB_BREAK_COMMIT: shas.v5 });
    assert.notEqual(result.status, 0);
    assert.match(result.output, /初回デプロイのためロールバック先がありません/);
    assert.ok(!existsSync(path.join(runtime, "current")));
    assert.match(calls(log), /systemctl stop mirai-web-cad-staging\.service/);
    assert.ok(!result.output.includes(SECRET));
  });
});

test("deploy.commit may be absent (archive builds report distCommit only)", () => {
  withRepo(({ work, env, shas }) => {
    const result = deploy(work, { ...env, STUB_NO_DEPLOY_COMMIT: "1" });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, new RegExp(`Stagingデプロイ成功: ${shas.v5}`));
  });
});

test("a health response reporting another database name fails the deployment", () => {
  withRepo(({ work, runtime, env, shas }) => {
    const result = deploy(work, { ...env, STUB_HEALTH_DB: "mirai_web_cad" });
    assert.notEqual(result.status, 0);
    assert.ok(!existsSync(path.join(runtime, "current")), "検証に失敗したreleaseをcurrentにしてはならない");
    assert.match(result.output, /初回デプロイのためロールバック先がありません/);
    assert.ok(!result.output.includes(SECRET));
  });
});

test("old releases are pruned, keeping the newest three and the rollback target", () => {
  withRepo(({ work, runtime, env, shas }) => {
    for (const name of ["v1", "v2", "v3", "v4"]) {
      assert.equal(deploy(work, env, [shas[name]]).status, 0);
    }
    // 古いreleaseを3件作る(mtimeを1970年にする)。
    for (const name of ["old-a", "old-b", "old-c"]) {
      const dir = path.join(runtime, "releases", name, "dist");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "build-info.json"), JSON.stringify({ commit: name }));
      utimesSync(path.join(runtime, "releases", name), new Date(0), new Date(0));
    }
    assert.equal(deploy(work, env).status, 0);
    const remaining = readdirSync(path.join(runtime, "releases")).sort();
    for (const name of ["v3", "v4", "v5"]) {
      assert.ok(remaining.includes(shas[name]), `${name} should remain: ${remaining.join(",")}`);
    }
    for (const name of ["old-a", "old-b", "old-c", shas.v1, shas.v2]) {
      assert.ok(!remaining.includes(name), `${name} should be pruned: ${remaining.join(",")}`);
    }
  });
});
