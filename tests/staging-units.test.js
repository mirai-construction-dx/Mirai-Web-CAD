import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// ADR-0006: Stagingの常駐サービスと定期ジョブは、本番/MVPが使う共有worktreeではなく、
// 独立ランタイムの current(releases/<sha> へのsymlink)から scripts/ を読む。
// 本番worktreeを更新してもStagingの定期ジョブの版が暗黙に変わらないことを固定する。
const RUNTIME_CURRENT = "/home/kensan/.local/share/mirai-web-cad/staging-runtime/current";
const SHARED_WORKTREE = "/home/kensan/Projects/Mirai-Construction-DX/Mirai-Web-CAD";

const units = [
  "mirai-web-cad-staging.service",
  "mirai-web-cad-staging-monitor.service",
  "mirai-web-cad-staging-backup.service",
  "mirai-web-cad-staging-backup-check.service",
  "mirai-web-cad-staging-restore-drill.service"
];

for (const unit of units) {
  test(`${unit} は独立ランタイムの current から実行する`, async () => {
    const content = await readFile(new URL(`../deploy/systemd/${unit}`, import.meta.url), "utf8");
    assert.match(content, new RegExp(`^WorkingDirectory=${RUNTIME_CURRENT.replaceAll("/", "\\/")}$`, "m"));
    assert.doesNotMatch(content, new RegExp(`^WorkingDirectory=${SHARED_WORKTREE.replaceAll("/", "\\/")}$`, "m"));
  });
}

test("Stagingの構成検査が定期ジョブのWorkingDirectoryも検査する", async () => {
  const script = await readFile(new URL("../scripts/check-staging-config.sh", import.meta.url), "utf8");
  assert.match(script, /staging-runtime\/current/);
  assert.match(script, /\$bkp.*\$bchk.*\$mon.*\$rd/s);
});
