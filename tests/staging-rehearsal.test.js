import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// scripts/rehearse-staging-migration.sh を、一時ディレクトリのnpm/curl/psqlスタブで検証する。
// 実DB・Stagingホスト・ネットワークには一切触れない。検証対象:
// DB名ガード(本番/MVPを拒否)、`db:verify`→`db:check`の順序、healthの前後確認、dry-run、
// 失敗時の非ゼロ終了、秘密値(DATABASE_URL)の非出力、サービス操作の不在。
const script = readFileSync(new URL("../scripts/rehearse-staging-migration.sh", import.meta.url), "utf8");
const SECRET = "SUPERSECRET-should-not-be-logged";
const STAGING_URL = `postgresql://mirai_web_cad_app:${SECRET}@stub.invalid:5432/mirai_web_cad_staging`;
const PRODUCTION_URL = `postgresql://mirai_web_cad_app:${SECRET}@stub.invalid:5432/mirai_web_cad`;

function stub(bin, name, body) {
  writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path.join(bin, name), 0o755);
}

function setup(root) {
  const bin = path.join(root, "bin");
  const log = path.join(root, "calls.log");
  const envFile = path.join(root, "staging.env");
  const curlCount = path.join(root, "curl.count");

  mkdirSync(path.join(root, "scripts"), { recursive: true });
  writeFileSync(path.join(root, "scripts/rehearse-staging-migration.sh"), script);
  chmodSync(path.join(root, "scripts/rehearse-staging-migration.sh"), 0o755);
  // staging.envはsystemdと同じく値を引用符で囲む。sourceせずsedで1変数だけ読めることを確認する。
  writeFileSync(envFile, `NODE_ENV=production\nDATABASE_URL="${STAGING_URL}"\n`);

  mkdirSync(bin);
  // npmはdb:verify/db:checkだけを実行し、渡されたDATABASE_URLを記録する(テスト内のログのみ)。
  stub(bin, "npm", `
case "$*" in
  "run db:verify") printf 'npm %s DATABASE_URL=%s\\n' "$*" "$DATABASE_URL" >> "${log}"; exit "\${STUB_DBVERIFY_EXIT:-0}" ;;
  "run db:check") printf 'npm %s DATABASE_URL=%s\\n' "$*" "$DATABASE_URL" >> "${log}"; exit "\${STUB_DBCHECK_EXIT:-0}" ;;
  *) printf 'npm %s\\n' "$*" >> "${log}"; exit 0 ;;
esac`);
  // psqlが直接呼ばれたら失敗させる(このスクリプトはnpm script経由でのみDBへ触る)。
  stub(bin, "psql", `printf 'psql %s\\n' "$*" >> "${log}"; exit 90`);
  // curlは呼び出し回数を数え、STUB_CURL_FAIL=all/pre/post で失敗を再現する。
  stub(bin, "curl", `
printf 'curl %s\\n' "$*" >> "${log}"
count="$(cat "${curlCount}" 2>/dev/null || echo 0)"
count=$((count + 1))
printf '%s' "$count" > "${curlCount}"
case "\${STUB_CURL_FAIL:-none}" in
  all) exit 22 ;;
  pre) [[ "$count" == "1" ]] && exit 22 ;;
  post) [[ "$count" == "2" ]] && exit 22 ;;
esac
printf '{"ok":true,"status":"ok","deploy":{"commit":"abc","distCommit":"def"},"db":{"mode":"connected","database":"mirai_web_cad_staging"}}'`);

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: root,
    STAGING_ENV_FILE: envFile
  };
  return { root, bin, log, envFile, env, curlCount };
}

function run(setup_, args = [], extraEnv = {}) {
  const result = spawnSync("bash", ["scripts/rehearse-staging-migration.sh", ...args], {
    cwd: setup_.root,
    encoding: "utf8",
    env: { ...setup_.env, ...extraEnv }
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`
  };
}

const calls = (log) => (existsSync(log) ? readFileSync(log, "utf8") : "");
const lines = (log) => calls(log).trim().split("\n").filter(Boolean);
const firstIndex = (logLines, pattern) => logLines.findIndex((line) => pattern.test(line));

async function withRepo(fn) {
  const root = mkdtempSync(path.join(tmpdir(), "staging-rehearsal-"));
  try {
    return await fn(setup(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("db:verify→db:checkの順に実行し、healthを前後で確認する", async () => {
  await withRepo((repo) => {
    const result = run(repo);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Staging migrationリハーサル成功/);
    assert.match(result.output, /DB=mirai_web_cad_staging/);

    const logLines = lines(repo.log);
    const preHealth = firstIndex(logLines, /^curl /);
    const verify = firstIndex(logLines, /^npm run db:verify /);
    const check = firstIndex(logLines, /^npm run db:check /);
    const postHealth = logLines.findLastIndex((line) => /^curl /.test(line));
    assert.ok(preHealth >= 0 && verify > preHealth, `health(前)→db:verifyの順序が違う: ${logLines.join(" | ")}`);
    assert.ok(check > verify, `db:verify→db:checkの順序が違う: ${logLines.join(" | ")}`);
    assert.ok(postHealth > check, `db:check→health(後)の順序が違う: ${logLines.join(" | ")}`);
    assert.equal(logLines.filter((line) => line.startsWith("curl ")).length, 2);
    assert.equal(logLines.filter((line) => line.startsWith("psql ")).length, 0);

    // 引用符を外したDATABASE_URLが環境変数としてnpm scriptへ渡る。
    assert.ok(logLines[verify].endsWith(`DATABASE_URL=${STAGING_URL}`));
    assert.ok(logLines[check].endsWith(`DATABASE_URL=${STAGING_URL}`));

    // 秘密値・接続文字列は出力しない。
    assert.ok(!result.output.includes(SECRET));
    assert.ok(!result.output.includes(STAGING_URL));
  });
});

test("staging.envが本番・MVP・復元用DBを指す場合は何も実行せず拒否する", async () => {
  for (const db of ["mirai_web_cad", "mirai_web_cad_mvp", "mirai_web_cad_staging_recovery"]) {
    await withRepo((repo) => {
      const url = `postgresql://mirai_web_cad_app:${SECRET}@stub.invalid:5432/${db}`;
      writeFileSync(repo.envFile, `DATABASE_URL="${url}"\n`);
      const result = run(repo);
      assert.notEqual(result.status, 0, `${db} を拒否していない`);
      assert.match(result.output, /DB名が mirai_web_cad_staging と一致しません/);
      assert.doesNotMatch(calls(repo.log), /^npm /m, `${db} に対してnpmを実行してはならない`);
      assert.doesNotMatch(calls(repo.log), /^curl /m, `${db} に対してhealth確認をしてはならない`);
      assert.ok(!result.output.includes(SECRET));
      assert.ok(!result.output.includes(url));
    });
  }
});

test("--dry-runはコマンドと対象DB名だけを表示し、何も実行しない", async () => {
  await withRepo((repo) => {
    const result = run(repo, ["--dry-run"]);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /対象DB: mirai_web_cad_staging/);
    assert.match(result.output, /npm run db:verify/);
    assert.match(result.output, /npm run db:check/);
    assert.match(result.output, /health確認\(前\)/);
    assert.match(result.output, /health確認\(後\)/);
    assert.equal(calls(repo.log), "", "dry-runで外部コマンドを実行してはならない");
    assert.ok(!result.output.includes(SECRET));
    assert.ok(!result.output.includes(STAGING_URL));
  });
});

test("--dry-runでも接続先がStagingでなければ拒否する", async () => {
  await withRepo((repo) => {
    writeFileSync(repo.envFile, `DATABASE_URL="${PRODUCTION_URL}"\n`);
    const result = run(repo, ["--dry-run"]);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /DB名が mirai_web_cad_staging と一致しません/);
    assert.ok(!result.output.includes(SECRET));
  });
});

test("db:verifyの失敗は非ゼロで終了し、db:checkへ進まない", async () => {
  await withRepo((repo) => {
    const result = run(repo, [], { STUB_DBVERIFY_EXIT: "1" });
    assert.notEqual(result.status, 0);
    assert.match(result.output, /db:verify が失敗しました/);
    assert.match(result.output, /所有権/);
    assert.match(calls(repo.log), /^npm run db:verify /m);
    assert.doesNotMatch(calls(repo.log), /^npm run db:check /m);
    // 失敗時も稼働状態を確認する(サービスは操作しない)。
    assert.equal(lines(repo.log).filter((line) => line.startsWith("curl ")).length, 2);
    assert.ok(!result.output.includes(SECRET));
  });
});

test("db:checkの失敗は非ゼロで終了する", async () => {
  await withRepo((repo) => {
    const result = run(repo, [], { STUB_DBCHECK_EXIT: "1" });
    assert.notEqual(result.status, 0);
    assert.match(result.output, /db:check が失敗しました/);
    assert.match(calls(repo.log), /^npm run db:check /m);
    assert.ok(!result.output.includes(SECRET));
  });
});

test("実行前のhealthが取れなくてもDB検証は続行し、成功時は終了コード0", async () => {
  await withRepo((repo) => {
    const result = run(repo, [], { STUB_CURL_FAIL: "pre" });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /実行前のhealthを確認できませんでした/);
    assert.match(result.output, /Staging migrationリハーサル成功/);
    assert.match(calls(repo.log), /^npm run db:verify /m);
    assert.ok(!result.output.includes(SECRET));
  });
});

test("実行後のhealthが確認できない場合は成功扱いにしない", async () => {
  await withRepo((repo) => {
    const result = run(repo, [], { STUB_CURL_FAIL: "post" });
    assert.notEqual(result.status, 0);
    assert.match(result.output, /実行後のhealthを確認できませんでした/);
    assert.match(calls(repo.log), /^npm run db:check /m);
    assert.ok(!result.output.includes(SECRET));
  });
});

test("envファイルやDATABASE_URLが無い場合は実行しない", async () => {
  await withRepo((repo) => {
    rmSync(repo.envFile);
    const missingFile = run(repo);
    assert.notEqual(missingFile.status, 0);
    assert.match(missingFile.output, /envファイルを読めません/);
    assert.equal(calls(repo.log), "");
  });
  await withRepo((repo) => {
    writeFileSync(repo.envFile, "NODE_ENV=production\n");
    const missingUrl = run(repo);
    assert.notEqual(missingUrl.status, 0);
    assert.match(missingUrl.output, /DATABASE_URL がありません/);
    assert.equal(calls(repo.log), "");
  });
});

test("不明な引数は拒否し、--helpは使い方を表示して成功する", async () => {
  await withRepo((repo) => {
    const unknown = run(repo, ["--skip-seed"]);
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.output, /不明な引数/);
    assert.equal(calls(repo.log), "");

    const help = run(repo, ["--help"]);
    assert.equal(help.status, 0, help.output);
    assert.match(help.output, /使い方/);
    assert.match(help.output, /--dry-run/);
  });
});

test("サービス操作・直接のpsql接続・sourceを実装に含めない", () => {
  assert.doesNotMatch(script, /^\s*(sudo|systemctl)\b/m, "サービス(systemd)を操作してはならない");
  assert.doesNotMatch(script, /^\s*source\s/m, "envファイルをsourceしてはならない");
  assert.doesNotMatch(script, /^\s*psql\b/m, "DBへ直接接続せずnpm script(db:verify/db:check)へ委譲する");
  assert.doesNotMatch(script, /db:restore|db:backup/, "バックアップ・復元を実行してはならない");
  assert.match(script, /expected_db=.*mirai_web_cad_staging/, "DB名ガードの既定値を持つ");
});
