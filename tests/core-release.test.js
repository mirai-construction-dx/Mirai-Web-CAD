import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkRelease,
  coreLockExistsAt,
  decodeContentsApiResponse,
  formatHumanReport,
  interpretAttestationResponse,
  parseArgs,
  parseSha256Sums,
  parseSigningKeysYaml,
  runCli,
  sanitizeText,
  verifyChecksum
} from "../scripts/check-core-release.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "scripts", "check-core-release.mjs");
const REPO = "mirai-construction-dx/Mirai-Harness-Core";
const ARTIFACT = "contracts.tar.gz fixture content\n";
const ARTIFACT_SHA = createHash("sha256").update(ARTIFACT, "utf8").digest("hex");
const SUMS = `${ARTIFACT_SHA}  contracts.tar.gz\n${"a".repeat(64)}  VERSION\n`;
const RELEASE = {
  tagName: "v0.8.0",
  name: "Mirai-Harness-Core v0.8.0",
  isDraft: false,
  isPrerelease: false,
  publishedAt: "2026-10-19T06:16:03Z",
  targetCommitish: "main",
  assets: [{ name: "SHA256SUMS" }, { name: "contracts.tar.gz" }, { name: "VERSION" }]
};
const KEYS_EMPTY = "# registries/signing-keys.yaml\napiVersion: core.mirai/v1\nkind: SigningKeys\nkeys: []\n";
const KEYS_OK =
  "apiVersion: core.mirai/v1\nkind: SigningKeys\nkeys:\n  - kid: test-key-1\n    jwks_url: https://example.invalid/jwks.json\n";

function makeFakeGh(overrides = {}) {
  const state = {
    release: overrides.release ?? RELEASE,
    sums: overrides.sums ?? SUMS,
    artifact: overrides.artifact ?? ARTIFACT,
    attestation: overrides.attestation ?? {
      status: 0,
      stdout: JSON.stringify({ attestations: [{ id: "att_test_1" }] }),
      stderr: ""
    },
    keys: overrides.keys ?? { status: 0, stdout: KEYS_OK, stderr: "" },
    releaseResponse: overrides.releaseResponse ?? null,
    downloadResponse: overrides.downloadResponse ?? null,
    calls: []
  };
  const runGh = async (args) => {
    state.calls.push(args);
    if (args[0] === "release" && args[1] === "view") {
      if (state.releaseResponse) return state.releaseResponse;
      return { status: 0, stdout: JSON.stringify(state.release), stderr: "" };
    }
    if (args[0] === "release" && args[1] === "download") {
      if (state.downloadResponse) return state.downloadResponse;
      const dir = args[args.indexOf("--dir") + 1];
      await writeFile(path.join(dir, "SHA256SUMS"), state.sums);
      await writeFile(path.join(dir, "contracts.tar.gz"), state.artifact);
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "api" && String(args[1]).includes("/attestations/")) return state.attestation;
    if (args[0] === "api" && String(args[1]).includes("/contents/registries/signing-keys.yaml")) return state.keys;
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  return { runGh, state };
}

function makeDeps(fake, overrides = {}) {
  const dirs = [];
  return {
    dirs,
    deps: {
      runGh: fake.runGh,
      coreLockExists: overrides.coreLockExists ?? (() => false),
      now: overrides.now ?? (() => new Date("2026-10-23T00:00:00.000Z")),
      makeTempDir:
        overrides.makeTempDir ??
        (async () => {
          const dir = await mkdtemp(path.join(os.tmpdir(), "mirai-core-intake-test-"));
          dirs.push(dir);
          return dir;
        }),
      ...overrides
    }
  };
}

async function runCliCaptured(argv, fake, overrides = {}) {
  const { deps, dirs } = makeDeps(fake, overrides);
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, {
    ...deps,
    writeOut: (text) => {
      stdout += text;
    },
    writeErr: (text) => {
      stderr += text;
    }
  });
  return { code, stdout, stderr, dirs, deps };
}

test("parseArgs: 既定値とオプションを解決する", () => {
  assert.deepEqual(parseArgs([]), {
    repo: REPO,
    tag: null,
    json: false,
    strict: false,
    help: false
  });
  assert.deepEqual(parseArgs(["--tag", "v0.8.0", "--repo", "owner/name", "--json", "--strict"]), {
    repo: "owner/name",
    tag: "v0.8.0",
    json: true,
    strict: true,
    help: false
  });
  assert.equal(parseArgs(["--tag=v0.8.0"]).tag, "v0.8.0");
  assert.equal(parseArgs(["--repo=owner/name"]).repo, "owner/name");
  assert.equal(parseArgs(["--help"]).help, true);
});

test("parseArgs: 不正な引数・タグ・リポジトリを拒否する", () => {
  assert.throws(() => parseArgs(["--tag"]), /値がありません/);
  assert.throws(() => parseArgs(["--repo"]), /値がありません/);
  assert.throws(() => parseArgs(["--tag", "main"]), /vX\.Y\.Z/);
  assert.throws(() => parseArgs(["--tag", "--json"]), /値がありません/);
  assert.throws(() => parseArgs(["--repo", "not-a-repo"]), /owner\/name/);
  assert.throws(() => parseArgs(["--repo", "owner/name; rm"]), /owner\/name/);
  assert.throws(() => parseArgs(["--tag", "v0.8.0", "--tag", "v0.7.0"]), /重複/);
  assert.throws(() => parseArgs(["--unknown"]), /不明な引数/);
  assert.throws(() => parseArgs(["--tag="]), /空です/);
});

test("parseSha256Sums: 正常行・コメント・空行を読み、大文字digestを正規化する", () => {
  const text = [
    "# comment",
    "",
    `${ARTIFACT_SHA.toUpperCase()}  contracts.tar.gz`,
    `${"b".repeat(64)} *VERSION`,
    `${"c".repeat(64)}   sdk-py/file.whl`,
    ""
  ].join("\n");
  const parsed = parseSha256Sums(text);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.entries.size, 3);
  assert.equal(parsed.entries.get("contracts.tar.gz"), ARTIFACT_SHA);
  assert.equal(parsed.entries.get("VERSION"), "b".repeat(64));
  assert.equal(parsed.entries.get("sdk-py/file.whl"), "c".repeat(64));
});

test("parseSha256Sums: 形式違反と重複をerrorsに残す", () => {
  const parsed = parseSha256Sums(
    ["not-a-digest  file.txt", `${"a".repeat(64)}  dup.txt`, `${"b".repeat(64)}  dup.txt`, `${"c".repeat(64)}`].join("\n")
  );
  assert.equal(parsed.entries.size, 1);
  assert.equal(parsed.entries.get("dup.txt"), "a".repeat(64));
  assert.equal(parsed.errors.length, 3);
});

test("verifyChecksum: 一致・不一致・記載なしを判定する", () => {
  const entries = parseSha256Sums(SUMS).entries;
  const ok = verifyChecksum(entries, "contracts.tar.gz", ARTIFACT_SHA);
  assert.equal(ok.ok, true);
  assert.equal(ok.expected, ARTIFACT_SHA);
  assert.match(ok.detail, /一致しました/);

  const mismatch = verifyChecksum(entries, "contracts.tar.gz", "d".repeat(64));
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.detail, /一致しません/);

  const missing = verifyChecksum(entries, "missing.tar.gz", ARTIFACT_SHA);
  assert.equal(missing.ok, false);
  assert.equal(missing.expected, null);

  const noActual = verifyChecksum(entries, "contracts.tar.gz", null);
  assert.equal(noActual.ok, false);
  assert.equal(noActual.actual, null);
});

test("parseSigningKeysYaml: 空keys(インライン/ブロック)を空と判定する", () => {
  assert.deepEqual(parseSigningKeysYaml(KEYS_EMPTY), { ok: true, empty: true, count: 0, error: null });
  assert.deepEqual(parseSigningKeysYaml("apiVersion: core.mirai/v1\nkeys: [] # none\n"), {
    ok: true,
    empty: true,
    count: 0,
    error: null
  });
  assert.deepEqual(parseSigningKeysYaml("apiVersion: core.mirai/v1\nkeys:\nkind: SigningKeys\n"), {
    ok: true,
    empty: true,
    count: 0,
    error: null
  });
});

test("parseSigningKeysYaml: 非空keysを件数付きで判定する", () => {
  assert.deepEqual(parseSigningKeysYaml(KEYS_OK), { ok: true, empty: false, count: 1, error: null });
  assert.deepEqual(parseSigningKeysYaml("keys:\n  - kid: a\n  - kid: b\n"), {
    ok: true,
    empty: false,
    count: 2,
    error: null
  });
  assert.deepEqual(parseSigningKeysYaml("keys: [{ kid: a }, { kid: b }]\n"), {
    ok: true,
    empty: false,
    count: 2,
    error: null
  });
});

test("parseSigningKeysYaml: 欠落・不正な形式はok:false(fail secure)", () => {
  assert.equal(parseSigningKeysYaml("apiVersion: core.mirai/v1\n").ok, false);
  assert.equal(parseSigningKeysYaml("keys: not-an-array\n").ok, false);
  assert.equal(parseSigningKeysYaml("keys:\n  - \n").ok, false);
  assert.equal(parseSigningKeysYaml("").ok, false);
});

test("interpretAttestationResponse: 200/空/404/その他を区別する", () => {
  assert.equal(
    interpretAttestationResponse({ status: 0, stdout: JSON.stringify({ attestations: [{ id: "a" }, { id: "b" }] }) })
      .status,
    "found"
  );
  assert.equal(
    interpretAttestationResponse({ status: 0, stdout: JSON.stringify({ attestations: [] }) }).status,
    "not-found"
  );
  assert.equal(interpretAttestationResponse({ status: 0, stdout: "{}" }).status, "unconfirmed");
  assert.equal(interpretAttestationResponse({ status: 1, stderr: "gh: Not Found (HTTP 404)" }).status, "not-found");
  assert.equal(interpretAttestationResponse({ status: 1, stderr: "gh: HTTP 500" }).status, "unconfirmed");
});

test("decodeContentsApiResponse: 生テキストとbase64 JSONの両方を扱える", () => {
  assert.equal(decodeContentsApiResponse("keys: []\n"), "keys: []\n");
  const encoded = Buffer.from("keys: []\n", "utf8").toString("base64");
  assert.equal(decodeContentsApiResponse(JSON.stringify({ content: encoded, encoding: "base64" })), "keys: []\n");
});

test("coreLockExistsAt: core-lockディレクトリの有無を返す", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mirai-core-lock-test-"));
  assert.equal(coreLockExistsAt(root), false);
  await mkdir(path.join(root, "core-lock"));
  assert.equal(coreLockExistsAt(root), true);
});

test("checkRelease: 全条件を満たすとGOになり、一時ディレクトリを削除する", async () => {
  const fake = makeFakeGh();
  const { deps, dirs } = makeDeps(fake);
  const report = await checkRelease({ repo: REPO, tag: "v0.8.0" }, deps);
  assert.equal(report.decision, "GO");
  assert.deepEqual(report.reasons, []);
  assert.equal(report.tag, "v0.8.0");
  assert.equal(report.artifact.sha256, ARTIFACT_SHA);
  assert.equal(report.artifact.expectedSha256, ARTIFACT_SHA);
  assert.equal(report.attestation.status, "found");
  assert.deepEqual(report.signingKeys, { configured: true, keysCount: 1 });
  assert.equal(report.coreLock.exists, false);
  assert.equal(report.checks.find((check) => check.id === "core_lock").required, false);
  assert.equal(report.checks.filter((check) => check.required && !check.ok).length, 0);
  assert.equal(dirs.length, 1);
  assert.equal(existsSync(dirs[0]), false);
});

test("checkRelease: --tag省略時はLatestを解決し、要求タグにnullを返す", async () => {
  const fake = makeFakeGh();
  const { deps } = makeDeps(fake);
  const report = await checkRelease({ repo: REPO, tag: null }, deps);
  assert.equal(report.requestedTag, null);
  assert.equal(report.decision, "GO");
  assert.deepEqual(fake.state.calls[0], [
    "release",
    "view",
    "--repo",
    REPO,
    "--json",
    "tagName,name,isDraft,isPrerelease,publishedAt,targetCommitish,assets"
  ]);
  assert.equal(fake.state.calls[1].includes("v0.8.0"), true);
});

test("checkRelease: attestation 404はNO-GO(既定はexit 0、--strictはexit 1)", async () => {
  const fake = makeFakeGh({ attestation: { status: 1, stderr: "gh: Not Found (HTTP 404)", stdout: "" } });
  const normal = await runCliCaptured(["--tag", "v0.8.0", "--json"], fake);
  assert.equal(normal.code, 0);
  const report = JSON.parse(normal.stdout);
  assert.equal(report.decision, "NO-GO");
  assert.match(report.reasons.join("\n"), /attestation/);
  assert.equal(normal.dirs.length, 1);
  assert.equal(existsSync(normal.dirs[0]), false);

  const strict = await runCliCaptured(["--tag", "v0.8.0", "--json", "--strict"], makeFakeGh({
    attestation: { status: 1, stderr: "gh: Not Found (HTTP 404)", stdout: "" }
  }));
  assert.equal(strict.code, 1);
});

test("checkRelease: 署名鍵が空ならNO-GO", async () => {
  const fake = makeFakeGh({ keys: { status: 0, stdout: KEYS_EMPTY, stderr: "" } });
  const report = await checkRelease({ repo: REPO, tag: "v0.8.0" }, makeDeps(fake).deps);
  assert.equal(report.decision, "NO-GO");
  assert.equal(report.signingKeys.configured, false);
  assert.match(report.reasons.join("\n"), /keysが空/);
});

test("checkRelease: SHA256不一致・asset欠落・draft/prereleaseはNO-GO", async () => {
  const mismatchFake = makeFakeGh({ artifact: "tampered\n" });
  const mismatch = await checkRelease({ repo: REPO, tag: "v0.8.0" }, makeDeps(mismatchFake).deps);
  assert.equal(mismatch.decision, "NO-GO");
  assert.match(mismatch.reasons.join("\n"), /SHA256/);

  const missingFake = makeFakeGh({
    release: { ...RELEASE, assets: [{ name: "contracts.tar.gz" }] }
  });
  const missing = await checkRelease({ repo: REPO, tag: "v0.8.0" }, makeDeps(missingFake).deps);
  assert.equal(missing.decision, "NO-GO");
  assert.match(missing.reasons.join("\n"), /必須asset/);

  const draftFake = makeFakeGh({ release: { ...RELEASE, isDraft: true } });
  const draft = await checkRelease({ repo: REPO, tag: "v0.8.0" }, makeDeps(draftFake).deps);
  assert.equal(draft.decision, "NO-GO");
  assert.match(draft.reasons.join("\n"), /draft/);
});

test("checkRelease: core-lockの存在は情報表示のみで判定を変えない", async () => {
  const fake = makeFakeGh();
  const report = await checkRelease(
    { repo: REPO, tag: "v0.8.0" },
    makeDeps(fake, { coreLockExists: () => true }).deps
  );
  assert.equal(report.decision, "GO");
  assert.equal(report.coreLock.exists, true);
  assert.equal(report.coreLock.path, "core-lock");
});

test("checkRelease: 一時ディレクトリはdownload失敗時も削除される", async () => {
  const fake = makeFakeGh({ downloadResponse: { status: 1, stdout: "", stderr: "gh: network error" } });
  const { deps, dirs } = makeDeps(fake);
  const report = await checkRelease({ repo: REPO, tag: "v0.8.0" }, deps);
  assert.equal(report.decision, "NO-GO");
  assert.equal(dirs.length, 1);
  assert.equal(existsSync(dirs[0]), false);
});

test("秘密非出力: 外部コマンド出力のトークンをstdout/stderrへ出さない", async () => {
  const token = `ghp_${"z".repeat(36)}`;
  const fake = makeFakeGh({
    attestation: { status: 1, stderr: `gh: server error token=${token}`, stdout: "" }
  });
  const result = await runCliCaptured(["--tag", "v0.8.0", "--json", "--strict"], fake);
  assert.equal(result.code, 1);
  assert.equal(result.stdout.includes(token), false);
  assert.equal(result.stderr.includes(token), false);
  assert.equal(result.stdout.includes("ghp_"), false);
  const report = JSON.parse(result.stdout);
  assert.equal(report.decision, "NO-GO");
  assert.equal(JSON.stringify(report).includes(token), false);
});

test("秘密非出力: Release取得失敗のエラーもsanitizeする", async () => {
  const token = `ghp_${"y".repeat(36)}`;
  const fake = makeFakeGh({
    releaseResponse: { status: 1, stdout: "", stderr: `authentication failed: ${token}` }
  });
  const result = await runCliCaptured(["--tag", "v0.8.0"], fake);
  assert.equal(result.code, 1);
  assert.equal(result.stdout.includes(token), false);
  assert.equal(result.stderr.includes(token), false);
  assert.match(result.stderr, /Release情報を取得できません/);
});

test("sanitizeText: トークン・接続文字列・秘密鍵・Authorizationを伏せる", () => {
  const text = [
    "token=ghp_" + "a".repeat(36),
    "DATABASE_URL=postgres://user:password@db.example:5432/mirai",
    "Authorization: Bearer abcdef",
    "-----BEGIN PRIVATE KEY-----",
    "secret",
    "-----END PRIVATE KEY-----"
  ].join("\n");
  const sanitized = sanitizeText(text);
  assert.equal(sanitized.includes("ghp_"), false);
  assert.equal(sanitized.includes("password"), false);
  assert.equal(sanitized.includes("abcdef"), false);
  assert.equal(sanitized.includes("secret"), false);
  assert.equal(sanitizeText("通常のメッセージです。"), "通常のメッセージです。");
});

test("formatHumanReport: 判定と理由を読みやすく出す", async () => {
  const fake = makeFakeGh({ keys: { status: 0, stdout: KEYS_EMPTY, stderr: "" } });
  const report = await checkRelease({ repo: REPO, tag: "v0.8.0" }, makeDeps(fake).deps);
  const text = formatHumanReport(report);
  assert.match(text, /判定: NO-GO/);
  assert.match(text, /NO-GO理由:/);
  assert.match(text, /signing-keys/);
  assert.equal(text.includes("undefined"), false);
});

test("CLI: --help はネットワークへ接続せず0で終了し、環境のトークンを出さない", () => {
  const token = `ghp_${"x".repeat(36)}`;
  const result = spawnSync(process.execPath, [CLI, "--help"], {
    encoding: "utf8",
    env: { ...process.env, GH_TOKEN: token }
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /使い方/);
  assert.equal(result.stdout.includes(token), false);
  assert.equal(result.stderr.includes(token), false);
});

test("CLI: 不正な引数はexit 1で、トークンを含む環境でも値を出さない", () => {
  const token = `ghp_${"w".repeat(36)}`;
  const result = spawnSync(process.execPath, [CLI, "--tag", "not-a-tag"], {
    encoding: "utf8",
    env: { ...process.env, GH_TOKEN: token }
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /vX\.Y\.Z/);
  assert.equal(result.stdout.includes(token), false);
  assert.equal(result.stderr.includes(token), false);
});
