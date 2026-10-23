import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// scripts/run-staging-access-e2e.sh を、一時ディレクトリのnpm/curlスタブで検証する。
// 実ネットワーク・実トークン・実Access policyには一切触れない。
// 検証対象: トークン欠落時のexit 78(実テスト/ネットワークなし)、dry-run、
// トークン値の非出力(xtrace時を含む)、env -iによる必要変数だけの受け渡し、
// 境界→E2E→境界の呼び出し順序、E2E失敗時も境界を再確認すること。
const script = readFileSync(new URL("../scripts/run-staging-access-e2e.sh", import.meta.url), "utf8");
const boundaryScript = readFileSync(new URL("../scripts/check-staging-public-boundary.sh", import.meta.url), "utf8");

const TOKEN_ID = "stub-client-id-do-not-print";
const TOKEN_SECRET = "stub-client-secret-do-not-print";
const EXPECT_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const STAGING_URL = "https://mirai-web-cad-stg.mirai-dx-platform.com";
const PRODUCTION_HEALTH_URL = "https://mirai-web-cad.mirai-dx-platform.com/api/health";
const MVP_URL = "https://mirai-web-cad-mvp.mirai-dx-platform.com/";

const BOUNDARY_CALLS = [
  `curl ${STAGING_URL}/`,
  `curl ${STAGING_URL}/api/health`,
  `curl ${PRODUCTION_HEALTH_URL}`,
  `curl ${MVP_URL}`
];

function stub(bin, name, body) {
  writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path.join(bin, name), 0o755);
}

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "staging-access-e2e-"));
  const scriptsDir = path.join(root, "scripts");
  const bin = path.join(root, "bin");
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(bin);

  const scriptPath = path.join(scriptsDir, "run-staging-access-e2e.sh");
  writeFileSync(scriptPath, script);
  chmodSync(scriptPath, 0o755);
  writeFileSync(path.join(scriptsDir, "check-staging-public-boundary.sh"), boundaryScript);
  chmodSync(path.join(scriptsDir, "check-staging-public-boundary.sh"), 0o755);

  // npmスタブ: 呼び出しを記録し、env -iで渡されたトークンが期待値と一致するかを
  // 値ではなく判定結果(tokens=ok)として記録する。E2Eの終了コードはファイルで制御する。
  stub(bin, "npm", `
dir="$(cd "$(dirname "$0")" && pwd)"
echo "npm $*" >> "$dir/calls.log"
touch "$dir/e2e-ran"
if [[ -f "$dir/expected-id" && "\${E2E_CF_ACCESS_CLIENT_ID:-}" == "$(cat "$dir/expected-id")" && "\${E2E_CF_ACCESS_CLIENT_SECRET:-}" == "$(cat "$dir/expected-secret")" ]]; then
  echo "tokens=ok" >> "$dir/checks.log"
else
  echo "tokens=mismatch" >> "$dir/checks.log"
fi
if [[ -n "\${E2E_EXPECT_COMMIT:-}" ]]; then
  echo "expect=\${E2E_EXPECT_COMMIT}" >> "$dir/checks.log"
fi
if [[ -n "\${E2E_STAGING_LOCAL:-}" ]]; then
  echo "local-forwarded" >> "$dir/checks.log"
fi
code=0
if [[ -f "$dir/npm-exit" ]]; then
  code="$(cat "$dir/npm-exit")"
fi
exit "$code"
`);

  // curlスタブ: 公開境界チェックの期待値(Staging 302 / 本番200 / MVP 302)を返す。
  // 境界チェックへトークンが渡っていれば boundary-token-leak を記録する。
  stub(bin, "curl", `
dir="$(cd "$(dirname "$0")" && pwd)"
url=""
for arg in "$@"; do url="$arg"; done
echo "curl $url" >> "$dir/calls.log"
if [[ -n "\${E2E_CF_ACCESS_CLIENT_ID:-}" || -n "\${E2E_CF_ACCESS_CLIENT_SECRET:-}" ]]; then
  echo "boundary-token-leak" >> "$dir/checks.log"
fi
if [[ -f "$dir/force-boundary-failure" ]]; then
  printf '500 '
  exit 0
fi
if [[ -f "$dir/force-post-failure" && -f "$dir/e2e-ran" ]]; then
  printf '500 '
  exit 0
fi
case "$url" in
  ${PRODUCTION_HEALTH_URL}) printf '200 ' ;;
  *) printf '302 https://stub.cloudflareaccess.com/cdn-cgi/access/login' ;;
esac
`);

  writeFileSync(path.join(bin, "expected-id"), TOKEN_ID);
  writeFileSync(path.join(bin, "expected-secret"), TOKEN_SECRET);

  return {
    root,
    bin,
    scriptPath,
    env: cleanEnv(bin),
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

// 実行環境からE2E_*を消し、実トークンや実URLの設定を持ち込まない。
function cleanEnv(bin) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("E2E_")) delete env[key];
  }
  delete env.BASH_ENV;
  delete env.ENV;
  delete env.SHELLOPTS;
  env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`;
  return env;
}

function withTokens(env, extra = {}) {
  return {
    ...env,
    E2E_CF_ACCESS_CLIENT_ID: TOKEN_ID,
    E2E_CF_ACCESS_CLIENT_SECRET: TOKEN_SECRET,
    ...extra
  };
}

function run(ctx, { args = [], env = ctx.env, bashArgs = [] } = {}) {
  const result = spawnSync("bash", [...bashArgs, ctx.scriptPath, ...args], {
    cwd: ctx.root,
    encoding: "utf8",
    env,
    timeout: 60_000
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`
  };
}

function lines(file) {
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : [];
}

const calls = (ctx) => lines(path.join(ctx.bin, "calls.log"));
const checks = (ctx) => lines(path.join(ctx.bin, "checks.log"));

function withContext(fn) {
  const ctx = setup();
  try {
    fn(ctx);
  } finally {
    ctx.cleanup();
  }
}

test("missing tokens exit 78 without running the E2E or touching the network", () => {
  withContext((ctx) => {
    const result = run(ctx);
    assert.equal(result.status, 78, result.output);
    assert.deepEqual(calls(ctx), [], "npm/curlを実行してはならない");
    assert.match(result.output, /E2E_CF_ACCESS_CLIENT_ID/);
    assert.match(result.output, /E2E_CF_ACCESS_CLIENT_SECRET/);
    assert.match(result.output, /npm run test:e2e:staging/, "実行計画を表示する");
    assert.match(result.output, /実テストは実行していません/);
    assert.match(result.output, /ネットワークアクセス\(公開境界チェック\)も行っていません/);
    assert.ok(!result.output.includes(TOKEN_ID));
    assert.ok(!result.output.includes(TOKEN_SECRET));
  });
});

test("either token missing exits 78", () => {
  withContext((ctx) => {
    const idOnly = run(ctx, { env: { ...ctx.env, E2E_CF_ACCESS_CLIENT_ID: TOKEN_ID } });
    assert.equal(idOnly.status, 78, idOnly.output);
    assert.match(idOnly.output, /E2E_CF_ACCESS_CLIENT_SECRET が未設定/);
    assert.deepEqual(calls(ctx), []);

    const secretOnly = run(ctx, { env: { ...ctx.env, E2E_CF_ACCESS_CLIENT_SECRET: TOKEN_SECRET } });
    assert.equal(secretOnly.status, 78, secretOnly.output);
    assert.match(secretOnly.output, /E2E_CF_ACCESS_CLIENT_ID が未設定/);
    assert.deepEqual(calls(ctx), []);
    assert.ok(!secretOnly.output.includes(TOKEN_SECRET));
  });
});

test("--dry-run prints the commands, target URL and expected commit without executing anything", () => {
  withContext((ctx) => {
    const baseUrl = "https://staging.example.invalid/";
    const result = run(ctx, {
      args: ["--dry-run"],
      env: withTokens(ctx.env, { E2E_EXPECT_COMMIT: EXPECT_COMMIT, E2E_BASE_URL: baseUrl })
    });
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(calls(ctx), [], "dry-runはnpm/curlを実行してはならない");
    assert.match(result.output, /dry-run/);
    assert.match(result.output, /npm run test:e2e:staging/);
    assert.match(result.output, /bash scripts\/check-staging-public-boundary\.sh/);
    assert.ok(result.output.includes(baseUrl), "対象URLを表示する");
    assert.ok(result.output.includes(EXPECT_COMMIT), "期待commitを表示する");
    assert.match(result.output, /E2E_CF_ACCESS_CLIENT_ID: 設定済み/);
    assert.ok(!result.output.includes(TOKEN_ID));
    assert.ok(!result.output.includes(TOKEN_SECRET));
  });
});

test("--dry-run also works without tokens and still executes nothing", () => {
  withContext((ctx) => {
    const result = run(ctx, { args: ["--dry-run"] });
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(calls(ctx), []);
    assert.match(result.output, /E2E_CF_ACCESS_CLIENT_ID: 未設定/);
    assert.match(result.output, /E2E_CF_ACCESS_CLIENT_SECRET: 未設定/);
  });
});

test("runs boundary, E2E, boundary in order and never prints the token values", () => {
  withContext((ctx) => {
    // E2E_STAGING_LOCALはenv -iで子プロセスへ渡さない(公開URLモードを固定する)。
    const result = run(ctx, {
      env: withTokens(ctx.env, { E2E_EXPECT_COMMIT: EXPECT_COMMIT, E2E_STAGING_LOCAL: "1" })
    });
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(calls(ctx), [
      ...BOUNDARY_CALLS,
      "npm run test:e2e:staging",
      ...BOUNDARY_CALLS
    ]);
    assert.ok(checks(ctx).includes("tokens=ok"), "トークンは子プロセスの環境変数として渡す");
    assert.ok(checks(ctx).includes(`expect=${EXPECT_COMMIT}`), "E2E_EXPECT_COMMITを渡す");
    assert.ok(!checks(ctx).includes("local-forwarded"), "E2E_STAGING_LOCALは渡さない");
    assert.ok(!checks(ctx).includes("boundary-token-leak"), "境界チェックへトークンを渡さない");
    assert.ok(!result.output.includes(TOKEN_ID));
    assert.ok(!result.output.includes(TOKEN_SECRET));
    assert.match(result.output, /Staging Access E2E 成功/);
  });
});

test("bash -x never logs the token values", () => {
  withContext((ctx) => {
    const result = run(ctx, { env: withTokens(ctx.env), bashArgs: ["-x"] });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /xtrace\(-x\)を無効化しました/);
    assert.ok(!result.output.includes(TOKEN_ID), "xtraceの出力にトークンを含めない");
    assert.ok(!result.output.includes(TOKEN_SECRET), "xtraceの出力にトークンを含めない");
  });
});

test("a failing E2E still re-checks the boundary and propagates the exit code", () => {
  withContext((ctx) => {
    writeFileSync(path.join(ctx.bin, "npm-exit"), "7");
    const result = run(ctx, { env: withTokens(ctx.env) });
    assert.equal(result.status, 7, result.output);
    assert.deepEqual(calls(ctx), [
      ...BOUNDARY_CALLS,
      "npm run test:e2e:staging",
      ...BOUNDARY_CALLS
    ]);
    assert.match(result.output, /E2E\] 失敗しました/);
    assert.ok(!result.output.includes(TOKEN_ID));
    assert.ok(!result.output.includes(TOKEN_SECRET));
  });
});

test("a failing boundary check before the E2E aborts before running the E2E", () => {
  withContext((ctx) => {
    writeFileSync(path.join(ctx.bin, "force-boundary-failure"), "");
    const result = run(ctx, { env: withTokens(ctx.env) });
    assert.equal(result.status, 1, result.output);
    assert.deepEqual(calls(ctx), BOUNDARY_CALLS);
    assert.match(result.output, /公開境界チェック: 失敗があります/);
  });
});

test("a boundary regression after the E2E is detected and fails the run", () => {
  withContext((ctx) => {
    writeFileSync(path.join(ctx.bin, "force-post-failure"), "");
    const result = run(ctx, { env: withTokens(ctx.env) });
    assert.equal(result.status, 1, result.output);
    assert.deepEqual(calls(ctx), [
      ...BOUNDARY_CALLS,
      "npm run test:e2e:staging",
      ...BOUNDARY_CALLS
    ]);
    assert.match(result.output, /公開境界チェック\(E2E後\)に失敗しました/);
  });
});

test("an unknown argument is rejected without executing anything", () => {
  withContext((ctx) => {
    const result = run(ctx, { args: ["--unknown"] });
    assert.equal(result.status, 64, result.output);
    assert.deepEqual(calls(ctx), []);
    assert.match(result.output, /不明な引数です/);
  });
});
