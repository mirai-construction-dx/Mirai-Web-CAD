#!/usr/bin/env node
/**
 * Mirai-Harness-Core の GitHub Release を Web-CAD へ取り込めるか判定する読み取り専用CLI。
 *
 * 判定する受入条件(AGENTS.md §1、docs/architecture/platform-integration.md §3):
 *   1. Release(既定はLatest)を特定できる。draft/prereleaseでない。
 *   2. 必須asset(SHA256SUMS / contracts.tar.gz)がReleaseにある。
 *   3. SHA256SUMS を解釈でき、contracts.tar.gz のSHA256と一致する。
 *   4. contracts.tar.gz のdigestに対する attestation が存在する
 *      (`/attestations/sha256:<digest>` が404ならNO-GO)。
 *   5. `registries/signing-keys.yaml` の `keys` が空でない。
 *
 * core-lock の有無は情報として報告する(判定は変えない)。Web-CADはNO-GOのReleaseを
 * 取り込まず、core-lock も作らない(取り込んでいないものを固定しない)。
 *
 * 安全側の設計:
 *   - 読み取りのみ。`gh release view` / `gh release download` / `gh api` だけを実行する。
 *   - 外部コマンドは runGh として注入できる(テストは実ネットワークを使わない)。
 *   - 一時ディレクトリは finally で削除する。
 *   - 秘密値・トークン・接続文字列を出力しない(外部コマンドの出力を sanitize する)。
 *   - NO-GOでも終了コード0(判定レポート)。`--strict` 指定時だけNO-GOで1。
 *     引数エラー・Release情報を取得できない場合は判定不能として1。
 *
 * 使い方:
 *   node scripts/check-core-release.mjs
 *   node scripts/check-core-release.mjs --tag v0.8.0
 *   node scripts/check-core-release.mjs --tag v0.8.0 --json --strict
 *   node scripts/check-core-release.mjs --repo mirai-construction-dx/Mirai-Harness-Core
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_NAME = "check-core-release";
const REPORT_FORMAT = "mirai-web-cad/core-release-intake/1";
const DEFAULT_REPO = "mirai-construction-dx/Mirai-Harness-Core";
const ARTIFACTS = Object.freeze(["SHA256SUMS", "contracts.tar.gz"]);
const ARTIFACT_NAME = "contracts.tar.gz";
const SUMS_NAME = "SHA256SUMS";
const SIGNING_KEYS_PATH = "registries/signing-keys.yaml";
const RELEASE_FIELDS = "tagName,name,isDraft,isPrerelease,publishedAt,targetCommitish,assets";
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,139}\/[A-Za-z0-9_.-]{1,100}$/;
// CoreのReleaseタグはvX.Y.Z。任意文字列をghへ渡さない(オプション注入・URL破壊を防ぐ)。
const TAG_RE = /^v?[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]{1,60})?$/;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = `使い方: node scripts/check-core-release.mjs [options]

Mirai-Harness-Core の GitHub Release を読み取り専用で確認し、Web-CADが取り込めるかを
GO/NO-GOで判定する。Release・assetの取得には認証済みの gh CLI を使う。

options:
  --tag <tag>   確認するReleaseタグ(例: v0.8.0)。省略時はLatest
  --repo <o/r>  対象リポジトリ(既定: ${DEFAULT_REPO})
  --json        判定結果をJSONで標準出力へ出す
  --strict      NO-GOなら終了コード1(既定はレポートとして0)
  -h, --help    このヘルプ

判定(GOの条件):
  - Releaseがdraft/prereleaseでない
  - ${SUMS_NAME} と ${ARTIFACT_NAME} がassetにある
  - ${ARTIFACT_NAME} のSHA256が ${SUMS_NAME} の記載と一致する
  - ${ARTIFACT_NAME} のdigestに対する attestation がある
  - ${SIGNING_KEYS_PATH} の keys が空でない

core-lock の有無は情報表示のみ。NO-GOのReleaseは取り込まず、core-lockも作らない。`;

/**
 * 引数を検証して設定へ変換する純粋関数。
 * @param {string[]} argv `node script.mjs` 以降の引数
 * @returns {{repo: string, tag: string|null, json: boolean, strict: boolean, help: boolean}}
 */
export function parseArgs(argv = []) {
  const options = { repo: DEFAULT_REPO, tag: null, json: false, strict: false, help: false };
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--strict") {
      options.strict = true;
      continue;
    }
    let name = arg;
    let value;
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    if (equals !== -1) {
      name = arg.slice(0, equals);
      value = arg.slice(equals + 1);
    }
    if (name !== "--repo" && name !== "--tag") {
      throw new Error(`不明な引数です: ${redactArg(arg)} (--help を参照してください)`);
    }
    if (seen.has(name)) throw new Error(`引数が重複しています: ${name}`);
    seen.add(name);
    if (value === undefined) {
      value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`引数 ${name} に値がありません。`);
      }
      i += 1;
    }
    if (value.length === 0) throw new Error(`引数 ${name} が空です。`);
    if (name === "--repo") {
      if (!REPO_RE.test(value)) {
        throw new Error("--repo は owner/name 形式(英数字・_・.・-、140文字以内)で指定してください。");
      }
      options.repo = value;
    } else {
      if (!TAG_RE.test(value)) {
        throw new Error("--tag は vX.Y.Z 形式(例: v0.8.0)で指定してください。");
      }
      options.tag = value;
    }
  }
  return options;
}

/**
 * SHA256SUMS(coreutils形式)をparseする。解釈できない行は errors に残す(fail secure)。
 * @param {string} text
 * @returns {{entries: Map<string, string>, errors: string[]}}
 */
export function parseSha256Sums(text) {
  const entries = new Map();
  const errors = [];
  const lines = String(text ?? "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (!match) {
      errors.push(`${i + 1}行目がSHA256SUMSの形式ではありません。`);
      continue;
    }
    const digest = match[1].toLowerCase();
    const filename = match[2].trim();
    if (filename.length === 0) {
      errors.push(`${i + 1}行目のファイル名が空です。`);
      continue;
    }
    if (entries.has(filename)) {
      errors.push(`${i + 1}行目のファイル名が重複しています: ${filename}`);
      continue;
    }
    entries.set(filename, digest);
  }
  return { entries, errors };
}

/**
 * SHA256SUMSの記載と実際のdigestを照合する。
 * @param {Map<string, string>} entries
 * @param {string} filename
 * @param {string|null} actual
 */
export function verifyChecksum(entries, filename, actual) {
  const expected = entries instanceof Map ? entries.get(filename) ?? null : null;
  if (expected === null) {
    return { ok: false, expected: null, actual: actual ?? null, detail: `${SUMS_NAME}に${filename}の記載がありません。` };
  }
  if (typeof actual !== "string" || actual.length === 0) {
    return { ok: false, expected, actual: null, detail: `${filename}のSHA256を計算できませんでした。` };
  }
  const ok = expected === actual.toLowerCase();
  return {
    ok,
    expected,
    actual,
    detail: ok
      ? `${filename}のSHA256が${SUMS_NAME}と一致しました。`
      : `${filename}のSHA256が${SUMS_NAME}と一致しません(期待=${expected}, 実際=${actual})。`
  };
}

/**
 * `registries/signing-keys.yaml` の `keys` が空かを判定する。YAML全体は解釈せず、
 * トップレベルの `keys:` だけを見る(秘密情報・公開鍵の中身は出力しない)。
 * @param {string} text
 * @returns {{ok: boolean, empty: boolean|null, count: number|null, error: string|null}}
 */
export function parseSigningKeysYaml(text) {
  if (typeof text !== "string" || text.trim().length === 0) {
    return { ok: false, empty: null, count: null, error: "署名鍵ファイルが空です。" };
  }
  const lines = text.split(/\r?\n/);
  let keyIndex = -1;
  let inline = null;
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^keys\s*:\s*(.*)$/.exec(stripYamlComment(lines[i]));
    if (match) {
      keyIndex = i;
      inline = match[1].trim();
      break;
    }
  }
  if (keyIndex === -1) {
    return { ok: false, empty: null, count: null, error: "keysフィールドがありません。" };
  }
  if (inline !== null && inline !== "") {
    if (inline === "[]" || inline === "~" || inline.toLowerCase() === "null") {
      return { ok: true, empty: true, count: 0, error: null };
    }
    if (inline.startsWith("[") && inline.endsWith("]")) {
      const count = countFlowItems(inline.slice(1, -1));
      return { ok: true, empty: count === 0, count, error: null };
    }
    return { ok: false, empty: null, count: null, error: "keysが配列ではありません。" };
  }
  let count = 0;
  let listIndent = null;
  for (let i = keyIndex + 1; i < lines.length; i += 1) {
    const line = stripYamlComment(lines[i]);
    if (line.trim().length === 0) continue;
    if (/^[A-Za-z0-9_-]+\s*:/.test(line)) break;
    const indent = /^\s*/.exec(line)[0].length;
    if (/^\s*\[\s*\]\s*$/.test(line)) {
      if (count === 0) return { ok: true, empty: true, count: 0, error: null };
      return { ok: false, empty: null, count: null, error: "keysの書式を解釈できません。" };
    }
    if (/^\s*-/.test(line)) {
      if (/^\s*-\s*$/.test(line)) {
        return { ok: false, empty: null, count: null, error: "keysの書式を解釈できません。" };
      }
      // 最初のlist itemのインデントを基準にする。深い`-`は親item内の入れ子リスト。
      if (listIndent === null) listIndent = indent;
      if (indent <= listIndent) count += 1;
      continue;
    }
    if (/\S/.test(line)) {
      // list itemのmapping continuation(`    kid: ...`)は許容する。
      if (listIndent !== null && indent > listIndent) continue;
      return { ok: false, empty: null, count: null, error: "keysの書式を解釈できません。" };
    }
  }
  return { ok: true, empty: count === 0, count, error: null };
}

/**
 * `/attestations/sha256:<digest>` の応答を判定する。404は「attestationなし」。
 * 200でも `attestations` が空なら「なし」、解釈できない応答は「未確認」(NO-GO)。
 * @param {{status?: number, stdout?: string, stderr?: string}|undefined} response
 */
export function interpretAttestationResponse(response) {
  const status = response?.status ?? 1;
  const stdout = typeof response?.stdout === "string" ? response.stdout : "";
  if (status === 0) {
    let data;
    try {
      data = JSON.parse(stdout);
    } catch {
      return { status: "unconfirmed", count: null, detail: "attestationの応答をJSONとして解釈できませんでした。" };
    }
    const list = Array.isArray(data?.attestations) ? data.attestations : null;
    if (list === null) {
      return { status: "unconfirmed", count: null, detail: "attestationの応答形式が想定と異なります。" };
    }
    if (list.length === 0) {
      return { status: "not-found", count: 0, detail: "attestationが登録されていません。" };
    }
    return { status: "found", count: list.length, detail: `attestationを${list.length}件確認しました。` };
  }
  if (isNotFoundResponse(response)) {
    return { status: "not-found", count: 0, detail: "attestationがありません(404)。" };
  }
  return {
    status: "unconfirmed",
    count: null,
    detail: `attestationを確認できませんでした(gh exit ${status})。`
  };
}

/**
 * GitHub Contents API の応答(raw、またはbase64入りJSON)をテキストへ戻す。
 * @param {string} raw
 */
export function decodeContentsApiResponse(raw) {
  const text = String(raw ?? "");
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      const data = JSON.parse(trimmed);
      if (typeof data?.content === "string") {
        return Buffer.from(data.content.replace(/\s+/g, ""), "base64").toString("utf8");
      }
    } catch {
      // JSONでなければrawとして扱う。
    }
  }
  return text;
}

/**
 * リポジトリルートに core-lock があるか(情報表示のみ)。
 * @param {string} root
 */
export function coreLockExistsAt(root) {
  return existsSync(path.join(root, "core-lock"));
}

/**
 * 外部コマンド `gh` を実行する既定実装。シェルを介さず、引数配列で渡す。
 * @param {string[]} args
 * @param {{cwd?: string, timeoutMs?: number, maxBuffer?: number}} [options]
 * @returns {Promise<{status: number, stdout: string, stderr: string}>}
 */
export function runGhCommand(args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 60000;
  const maxBuffer = options.maxBuffer ?? 5 * 1024 * 1024;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("gh", args, {
        cwd: options.cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      resolve({ status: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let bytes = 0;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ status: 124, stdout, stderr: `${stderr}\ngh: timeout (${timeoutMs}ms)` });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBuffer) {
        child.kill("SIGKILL");
        finish({ status: 125, stdout, stderr: "gh: output too large" });
        return;
      }
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish({ status: 127, stdout, stderr: error instanceof Error ? error.message : String(error) });
    });
    child.on("close", (code) => {
      finish({ status: code ?? 1, stdout, stderr });
    });
  });
}

/**
 * チェック一覧から GO/NO-GO を決める。`required: false` は判定に使わない。
 * @param {Array<{label: string, required: boolean, ok: boolean, detail: string}>} checks
 */
export function decide(checks) {
  const failures = checks.filter((check) => check.required && !check.ok);
  return {
    decision: failures.length === 0 ? "GO" : "NO-GO",
    reasons: failures.map((check) => `${check.label}: ${check.detail}`)
  };
}

/**
 * Releaseを取得して受入条件を判定する。Release情報そのものを取得できない場合だけ例外。
 * @param {{repo: string, tag: string|null}} options
 * @param {object} [deps] テスト用の注入点
 */
export async function checkRelease(options, deps = {}) {
  if (!options || typeof options.repo !== "string" || !REPO_RE.test(options.repo)) {
    throw new Error("リポジトリ名が不正です(owner/name 形式で指定してください)。");
  }
  if (options.tag !== null && options.tag !== undefined && !TAG_RE.test(options.tag)) {
    throw new Error("タグが不正です(vX.Y.Z 形式で指定してください)。");
  }
  const runGh = deps.runGh ?? runGhCommand;
  const makeTempDir = deps.makeTempDir ?? (() => mkdtemp(path.join(os.tmpdir(), "mirai-core-intake-")));
  const removeTempDir = deps.removeTempDir ?? ((dir) => rm(dir, { recursive: true, force: true }));
  const coreLockExists = deps.coreLockExists ?? (() => coreLockExistsAt(ROOT));
  const now = deps.now ?? (() => new Date());
  const readText = deps.readText ?? ((file) => readFile(file, "utf8"));
  const hashFile = deps.hashFile ?? sha256File;

  const checks = [];
  const add = (id, label, required, ok, detail) => {
    checks.push({ id, label, required, ok, detail });
  };

  const viewArgs = ["release", "view"];
  if (options.tag) viewArgs.push(options.tag);
  viewArgs.push("--repo", options.repo, "--json", RELEASE_FIELDS);
  const view = await runGh(viewArgs, { timeoutMs: 30000 });
  if (view.status !== 0) {
    throw new Error(`Release情報を取得できませんでした: ${errorSummary(view)}`);
  }
  let release;
  try {
    release = JSON.parse(view.stdout);
  } catch {
    throw new Error("Release情報をJSONとして解釈できませんでした。");
  }
  if (!release || typeof release.tagName !== "string" || release.tagName.length === 0) {
    throw new Error("Release情報にtagNameがありません。");
  }
  if (!TAG_RE.test(release.tagName)) {
    throw new Error("ReleaseのtagNameが想定の形式(vX.Y.Z)ではありません。");
  }

  const requestedTag = options.tag ?? null;
  const tagMatches = requestedTag === null || requestedTag === release.tagName;
  const releaseOk = tagMatches && release.isDraft !== true && release.isPrerelease !== true;
  let releaseDetail;
  if (!tagMatches) {
    releaseDetail = `要求タグ ${requestedTag} と解決タグ ${release.tagName} が一致しません。`;
  } else if (release.isDraft === true) {
    releaseDetail = `Release ${release.tagName} はdraftです。`;
  } else if (release.isPrerelease === true) {
    releaseDetail = `Release ${release.tagName} はprereleaseです。`;
  } else {
    releaseDetail = `Release ${release.tagName} を確認しました${requestedTag === null ? "(Latest)" : ""}。`;
  }
  add("release", "Releaseの特定", true, releaseOk, releaseDetail);

  const assets = Array.isArray(release.assets) ? release.assets : [];
  const assetNames = new Set(
    assets.map((asset) => (asset && typeof asset.name === "string" ? asset.name : null)).filter(Boolean)
  );
  const missingAssets = ARTIFACTS.filter((name) => !assetNames.has(name));
  add(
    "assets",
    "必須assetの存在",
    true,
    missingAssets.length === 0,
    missingAssets.length === 0
      ? `必須asset(${ARTIFACTS.join(", ")})を確認しました。`
      : `必須assetがありません: ${missingAssets.join(", ")}。`
  );

  const canDownload = releaseOk && missingAssets.length === 0;
  let artifactSha256 = null;
  let expectedSha256 = null;
  let attestation = { status: "unconfirmed", count: null, detail: "artifactを取得できなかったためattestationを確認できませんでした。" };

  if (!canDownload) {
    add("checksum", `${ARTIFACT_NAME}のSHA256照合`, true, false, "Release/assetを確認できないため照合していません。");
    add("attestation", "attestationの存在", true, false, "Release/assetを確認できないため確認していません。");
  } else {
    const tempDir = await makeTempDir();
    try {
      const download = await runGh(
        [
          "release",
          "download",
          release.tagName,
          "--repo",
          options.repo,
          "--pattern",
          SUMS_NAME,
          "--pattern",
          ARTIFACT_NAME,
          "--dir",
          tempDir,
          "--clobber"
        ],
        { timeoutMs: 120000 }
      );
      if (download.status !== 0) {
        add(
          "checksum",
          `${ARTIFACT_NAME}のSHA256照合`,
          true,
          false,
          `Release assetを取得できませんでした: ${errorSummary(download)}`
        );
      } else {
        let entries = null;
        try {
          const parsed = parseSha256Sums(await readText(path.join(tempDir, SUMS_NAME)));
          if (parsed.errors.length > 0) {
            add("sha256sums", `${SUMS_NAME}の解析`, true, false, `解釈できない行があります: ${parsed.errors[0]}`);
          } else {
            add("sha256sums", `${SUMS_NAME}の解析`, true, true, `${parsed.entries.size}件の記載を読み取りました。`);
            entries = parsed.entries;
          }
        } catch (error) {
          add("sha256sums", `${SUMS_NAME}の解析`, true, false, `読み取れませんでした: ${errorMessage(error)}`);
        }
        try {
          artifactSha256 = await hashFile(path.join(tempDir, ARTIFACT_NAME));
        } catch (error) {
          artifactSha256 = null;
          add("checksum", `${ARTIFACT_NAME}のSHA256計算`, true, false, `計算できませんでした: ${errorMessage(error)}`);
        }
        if (entries !== null && artifactSha256 !== null) {
          expectedSha256 = entries.get(ARTIFACT_NAME) ?? null;
          const verified = verifyChecksum(entries, ARTIFACT_NAME, artifactSha256);
          add("checksum", `${ARTIFACT_NAME}のSHA256照合`, true, verified.ok, verified.detail);
        } else if (!checks.some((check) => check.id === "checksum")) {
          add("checksum", `${ARTIFACT_NAME}のSHA256照合`, true, false, `${SUMS_NAME}またはartifactを読み取れませんでした。`);
        }
      }
    } finally {
      try {
        await removeTempDir(tempDir);
      } catch {
        // 後片付けの失敗は判定に影響させない(パスは表示しない)。
      }
    }
  }

  if (artifactSha256 !== null) {
    const response = await runGh(
      ["api", `repos/${options.repo}/attestations/sha256:${artifactSha256}`],
      { timeoutMs: 30000 }
    );
    attestation = interpretAttestationResponse(response);
    add("attestation", "attestationの存在", true, attestation.status === "found", attestation.detail);
  } else if (!checks.some((check) => check.id === "attestation")) {
    add("attestation", "attestationの存在", true, false, "artifactのdigestを確定できなかったため確認していません。");
  }

  let signingKeys = { configured: false, keysCount: null };
  const keysRef = encodeURIComponent(release.tagName);
  const keysResponse = await runGh(
    ["api", `repos/${options.repo}/contents/${SIGNING_KEYS_PATH}?ref=${keysRef}`, "-H", "Accept: application/vnd.github.raw"],
    { timeoutMs: 30000 }
  );
  if (keysResponse.status !== 0) {
    const reason = isNotFoundResponse(keysResponse)
      ? "404(ファイルがありません)"
      : `取得できませんでした(gh exit ${keysResponse.status})`;
    add("signing_keys", "署名鍵(signing-keys.yaml)", true, false, `署名鍵を確認できません: ${reason}。`);
  } else {
    const parsed = parseSigningKeysYaml(decodeContentsApiResponse(keysResponse.stdout));
    signingKeys = { configured: parsed.ok === true && parsed.empty === false, keysCount: parsed.count ?? null };
    if (parsed.ok !== true) {
      add("signing_keys", "署名鍵(signing-keys.yaml)", true, false, `署名鍵を確認できません: ${parsed.error}`);
    } else if (parsed.empty === true) {
      add("signing_keys", "署名鍵(signing-keys.yaml)", true, false, "keysが空です(署名鍵未登録)。");
    } else {
      add(
        "signing_keys",
        "署名鍵(signing-keys.yaml)",
        true,
        true,
        `公開鍵が${parsed.count ?? "1件以上"}登録されています。`
      );
    }
  }

  let lockExists = false;
  try {
    lockExists = Boolean(await coreLockExists());
  } catch {
    lockExists = false;
  }
  add(
    "core_lock",
    "Web-CADのcore-lock",
    false,
    true,
    lockExists ? "core-lockが存在します(取込み済みの記録あり)。" : "core-lockは未作成です(取込み未実施)。"
  );

  const { decision, reasons } = decide(checks);
  return {
    report: REPORT_FORMAT,
    checkedAt: now().toISOString(),
    repo: options.repo,
    requestedTag,
    tag: release.tagName,
    release: {
      publishedAt: release.publishedAt ?? null,
      draft: release.isDraft === true,
      prerelease: release.isPrerelease === true,
      targetCommitish: release.targetCommitish ?? null
    },
    artifact: {
      name: ARTIFACT_NAME,
      sha256: artifactSha256,
      expectedSha256
    },
    attestation,
    signingKeys,
    coreLock: { exists: lockExists, path: "core-lock" },
    checks,
    decision,
    reasons
  };
}

/**
 * 判定レポートを人間向けの文字列にする。
 * @param {object} report
 */
export function formatHumanReport(report) {
  const lines = [];
  lines.push(`Core release intake checker: ${report.repo}`);
  lines.push(`  要求: ${report.requestedTag ?? "Latest"} / 解決: ${report.tag}`);
  lines.push(`  確認日時: ${report.checkedAt}`);
  if (report.artifact.sha256) {
    lines.push(`  ${ARTIFACT_NAME} SHA256: ${report.artifact.sha256}`);
    lines.push(`  ${SUMS_NAME} の記載 : ${report.artifact.expectedSha256 ?? "未確認"}`);
  }
  lines.push(`  core-lock: ${report.coreLock.exists ? "あり" : "なし"}`);
  lines.push(`判定: ${report.decision}`);
  lines.push("チェック:");
  for (const check of report.checks) {
    const marker = check.required ? (check.ok ? "OK" : "NG") : "INFO";
    lines.push(`  [${marker}] ${check.label}: ${check.detail}`);
  }
  if (report.reasons.length > 0) {
    lines.push("NO-GO理由:");
    for (const reason of report.reasons) lines.push(`  - ${reason}`);
  }
  return lines.join("\n");
}

/**
 * CLI本体。終了コードを返す(テストから直接呼べる)。
 * @param {string[]} argv
 * @param {object} [deps]
 */
export async function runCli(argv = [], deps = {}) {
  const writeOut = deps.writeOut ?? ((text) => process.stdout.write(text));
  const writeErr = deps.writeErr ?? ((text) => process.stderr.write(text));
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    writeErr(`${SCRIPT_NAME}: ${sanitizeText(errorMessage(error))}\n`);
    return 1;
  }
  if (options.help) {
    writeOut(`${USAGE}\n`);
    return 0;
  }
  try {
    const report = await checkRelease(options, deps);
    writeOut(options.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatHumanReport(report)}\n`);
    return options.strict && report.decision === "NO-GO" ? 1 : 0;
  } catch (error) {
    writeErr(`${SCRIPT_NAME}: ${sanitizeText(errorMessage(error))}\n`);
    return 1;
  }
}

/**
 * 外部コマンド出力に含まれ得る秘密値らしい文字列を伏せる。多層防御であり、
 * そもそも環境変数やトークンを読まない設計を第一の防御とする。
 * @param {string} value
 */
export function sanitizeText(value) {
  let text = String(value ?? "");
  const patterns = [
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    /\b(?:Authorization|authorization)\s*:\s*(?:Bearer|Basic|token)\s+[^\s]+/g,
    /\b(?:GH_TOKEN|GITHUB_TOKEN|DATABASE_URL|PGPASSWORD|AWS_SECRET_ACCESS_KEY|AZURE_CLIENT_SECRET|OPENAI_API_KEY|ANTHROPIC_API_KEY|AI_PROVIDER_API_KEY)\s*[=:]\s*[^\s]+/g,
    /\bpostgres(?:ql)?:\/\/[^\s]+/g,
    /\bhttps?:\/\/[^\s/@:]+:[^\s/@]+@[^\s]+/g
  ];
  for (const pattern of patterns) text = text.replace(pattern, "[REDACTED]");
  return text;
}

/**
 * ファイルのSHA256を計算する(ストリーム)。
 * @param {string} filePath
 */
export async function sha256File(filePath) {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

function isNotFoundResponse(response) {
  const text = `${response?.stderr ?? ""}\n${response?.stdout ?? ""}`;
  return /HTTP 404\b|Not Found|"status"\s*:\s*"?404"?|status:\s*404/i.test(text);
}

function errorSummary(response) {
  const raw = `${response?.stderr ?? ""}`.trim() || `${response?.stdout ?? ""}`.trim() || `gh exit ${response?.status ?? "?"}`;
  return firstLine(sanitizeText(raw)).slice(0, 300);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function firstLine(text) {
  return text.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? "";
}

function redactArg(value) {
  const text = String(value);
  return text.length > 40 ? `${text.slice(0, 8)}…` : text;
}

function stripYamlComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === "'" && !inDouble) {
      if (inSingle && line[i + 1] === "'") {
        i += 1;
      } else {
        inSingle = !inSingle;
      }
    } else if (char === '"' && !inSingle) {
      if (inDouble && line[i - 1] === "\\") {
        continue;
      }
      inDouble = !inDouble;
    } else if (char === "#" && !inSingle && !inDouble) {
      return line.slice(0, i);
    }
  }
  return line;
}

function countFlowItems(body) {
  if (body.trim().length === 0) return 0;
  let count = 0;
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (char === '"' && !inSingle) inDouble = !inDouble;
    else if (!inSingle && !inDouble) {
      if (char === "[" || char === "{") depth += 1;
      else if (char === "]" || char === "}") depth = Math.max(0, depth - 1);
      else if (char === "," && depth === 0) count += 1;
    }
  }
  return count + 1;
}

const isMain =
  typeof process.argv[1] === "string" && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
