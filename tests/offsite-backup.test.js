import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// scripts/offsite-backup.sh を、age と rclone のスタブで検証する(ネットワーク・R2には触れない)。
// ageのスタブは受信者ファイルを記録し、入力を反転した内容を書く(平文と区別できる)。
// rcloneのスタブは "r2:<bucket>/<path>" を一時ディレクトリへ写像する。
const script = new URL("../scripts/offsite-backup.sh", import.meta.url).pathname;
const PLAINTEXT = "PGDMP plaintext drawing data";

function stub(bin, name, body) {
  writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  chmodSync(path.join(bin, name), 0o755);
}

function backup(dir, name, { hoursAgo = 1 } = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), `${PLAINTEXT} ${name}`);
  writeFileSync(path.join(dir, `${name}.manifest`), `sha256 ${name}\n`);
  const at = new Date(Date.now() - hoursAgo * 3600 * 1000);
  utimesSync(path.join(dir, name), at, at);
  symlinkSync(name, path.join(dir, "latest.dump"));
}

function withSandbox(fn) {
  const root = mkdtempSync(path.join(tmpdir(), "offsite-"));
  try {
    const bin = path.join(root, "bin");
    const store = path.join(root, "store");
    mkdirSync(bin);
    mkdirSync(store);
    const log = path.join(root, "calls.log");
    stub(bin, "age", `
[[ "$1" == "-R" && "$3" == "-o" ]]
echo "age -R $2" >> "${log}"
{ echo "age-encryption.org/v1"; rev; } > "$4"`);
    stub(bin, "rclone", `
map() { echo "${store}/\${1#r2:}"; }
case "$1" in
  copyto)
    [[ "$2" == "--ignore-existing" ]]
    dst="$(map "$4")"
    echo "rclone copyto $4" >> "${log}"
    [[ -n "\${STUB_RCLONE_FAIL:-}" ]] && exit 1
    [[ -e "$dst" ]] && exit 0
    mkdir -p "$(dirname "$dst")"
    cp "$3" "$dst"
    [[ -n "\${STUB_RCLONE_TRUNCATE:-}" ]] && truncate -s 5 "$dst"
    exit 0 ;;
  lsjson)
    dst="$(map "$3")"
    [[ -e "$dst" ]] || exit 3
    # 実物のrcloneと同じく、整形したJSONを出力する。
    printf '{\\n\\t"Path": "x",\\n\\t"Name": "x",\\n\\t"Size": %s,\\n\\t"IsDir": false\\n}\\n' "$(stat -c %s "$dst")" ;;
esac`);
    const recipients = path.join(root, "recipients.txt");
    writeFileSync(recipients, "age1examplepublickeyonly\n");
    const prod = path.join(root, "backups/postgres");
    const mvp = path.join(root, "backups/mvp-postgres");
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      OFFSITE_SOURCES: `${prod}:production ${mvp}:mvp`,
      OFFSITE_REMOTE: "r2:mirai-web-cad-backups",
      AGE_RECIPIENTS_FILE: recipients
    };
    const run = (extra = {}) => {
      try {
        return { status: 0, output: execFileSync("bash", [script], { env: { ...env, ...extra }, encoding: "utf8", stdio: "pipe" }) };
      } catch (error) {
        return { status: error.status, output: `${error.stdout}${error.stderr}` };
      }
    };
    const uploaded = (prefix) => {
      const dir = path.join(store, "mirai-web-cad-backups", prefix);
      return existsSync(dir) ? readdirSync(dir) : [];
    };
    fn({ root, prod, mvp, recipients, store, log, run, uploaded });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("production and MVP backups are encrypted before upload and verified by size", () => {
  withSandbox(({ prod, mvp, recipients, store, log, run, uploaded }) => {
    backup(prod, "mirai-web-cad-20260925T180000Z.dump");
    backup(mvp, "mirai-web-cad-20260925T184000Z.dump");
    const result = run();
    assert.equal(result.status, 0, result.output);
    assert.equal(result.output.match(/offsite ok/g).length, 2);
    assert.deepEqual(uploaded("production"), ["mirai-web-cad-20260925T180000Z.dump.tar.age"]);
    assert.deepEqual(uploaded("mvp"), ["mirai-web-cad-20260925T184000Z.dump.tar.age"]);
    const sent = readFileSync(path.join(store, "mirai-web-cad-backups/production/mirai-web-cad-20260925T180000Z.dump.tar.age"), "utf8");
    assert.match(sent, /^age-encryption\.org\/v1/);
    assert.equal(sent.includes(PLAINTEXT), false, "plaintext must never leave the host");
    assert.match(readFileSync(log, "utf8"), new RegExp(`age -R ${recipients}`));
  });
});

test("a rerun does not overwrite what is already offsite", () => {
  withSandbox(({ prod, mvp, run, log }) => {
    backup(prod, "mirai-web-cad-a.dump");
    backup(mvp, "mirai-web-cad-b.dump");
    assert.equal(run().status, 0);
    const second = run();
    assert.equal(second.status, 0, second.output);
    assert.equal(readFileSync(log, "utf8").match(/rclone copyto/g).length, 4);
  });
});

test("a stale latest backup is not uploaded as if it were new", () => {
  withSandbox(({ prod, mvp, run, uploaded }) => {
    backup(prod, "mirai-web-cad-old.dump", { hoursAgo: 72 });
    backup(mvp, "mirai-web-cad-new.dump");
    const result = run();
    assert.equal(result.status, 1);
    assert.match(result.output, /\[production\] 最新のバックアップが72時間前/);
    assert.deepEqual(uploaded("production"), []);
    // 他方の転送は続ける。
    assert.deepEqual(uploaded("mvp"), ["mirai-web-cad-new.dump.tar.age"]);
  });
});

test("a backup just over the age limit is not rounded down and accepted", () => {
  withSandbox(({ prod, mvp, run, uploaded }) => {
    backup(prod, "mirai-web-cad-edge.dump", { hoursAgo: 36 + 5 / 60 });
    backup(mvp, "mirai-web-cad-new.dump");
    const result = run();
    assert.equal(result.status, 1);
    assert.match(result.output, /\[production\] 最新のバックアップが36時間前/);
    assert.deepEqual(uploaded("production"), []);
  });
});

test("the rclone binary can be pinned so other systems keep the distribution version", () => {
  withSandbox(({ root, prod, mvp, run, log }) => {
    backup(prod, "mirai-web-cad-a.dump");
    backup(mvp, "mirai-web-cad-b.dump");
    // 既定の rclone(PATH上)は失敗させ、RCLONE_BIN で指定した方だけが使われることを確かめる。
    const pinned = path.join(root, "pinned");
    mkdirSync(pinned);
    writeFileSync(path.join(pinned, "rclone"), `#!/usr/bin/env bash\necho "pinned $1" >> "${log}"\nexec "${path.join(root, "bin", "rclone")}" "$@"\n`);
    chmodSync(path.join(pinned, "rclone"), 0o755);
    const result = run({ RCLONE_BIN: path.join(pinned, "rclone") });
    assert.equal(result.status, 0, result.output);
    const calls = readFileSync(log, "utf8");
    assert.equal(calls.match(/^pinned copyto$/gm).length, 2);
    assert.equal(calls.match(/^pinned lsjson$/gm).length, 2);
  });
});

test("a size mismatch after upload fails", () => {
  withSandbox(({ prod, mvp, run }) => {
    backup(prod, "mirai-web-cad-a.dump");
    backup(mvp, "mirai-web-cad-b.dump");
    const result = run({ STUB_RCLONE_TRUNCATE: "1" });
    assert.equal(result.status, 1);
    assert.match(result.output, /転送後のサイズが一致しません/);
  });
});

test("an upload failure or a missing backup fails the run", () => {
  withSandbox(({ prod, run }) => {
    backup(prod, "mirai-web-cad-a.dump");
    const result = run({ STUB_RCLONE_FAIL: "1" });
    assert.equal(result.status, 1);
    assert.match(result.output, /\[production\] 転送に失敗しました/);
    assert.match(result.output, /\[mvp\] 最新のバックアップがありません/);
  });
});

test("a decryption key in the recipients file is refused before anything is sent", () => {
  withSandbox(({ prod, mvp, recipients, run, uploaded }) => {
    backup(prod, "mirai-web-cad-a.dump");
    backup(mvp, "mirai-web-cad-b.dump");
    writeFileSync(recipients, "AGE-SECRET-KEY-1EXAMPLE\n");
    const result = run();
    assert.equal(result.status, 2);
    assert.match(result.output, /復号鍵が含まれています/);
    assert.deepEqual(uploaded("production"), []);
  });
});
