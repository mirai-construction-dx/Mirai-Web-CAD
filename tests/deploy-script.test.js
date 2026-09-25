import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// 改善台帳P0-74: デプロイ経路は本番DBへ書き込まない読み取り専用検証だけを実行する。
test("deploy-local.sh verifies the database read-only and never applies migrations or seeds", async () => {
  const script = await readFile(new URL("../scripts/deploy-local.sh", import.meta.url), "utf8");
  const commands = script.split("\n").filter((lineValue) => !lineValue.trim().startsWith("#"));
  assert.ok(commands.some((lineValue) => /npm run db:check/.test(lineValue)), "db:check must run during deploy");
  assert.ok(!commands.some((lineValue) => /db:verify|verify-database\.sh|seeds\/demo\.sql/.test(lineValue)), "deploy must not write to the production database");
  // DB検証は、稼働中の作業ツリーを切り替える(fast-forward・symlink)より前に行う。
  const check = commands.findIndex((lineValue) => /npm run db:check/.test(lineValue));
  const switchStart = commands.findIndex((lineValue) => lineValue.trim().startsWith("git merge --ff-only"));
  const trap = commands.findIndex((lineValue) => lineValue.trim() === "trap rollback ERR");
  assert.ok(check !== -1 && check < trap && trap < switchStart);
  // 稼働中のツリーで依存導入やbuildをしない(独立レビュー H-1)。
  const blockStart = commands.findIndex((lineValue) => lineValue.trim() === 'cd "$release_rel.tmp"');
  const blockEnd = commands.findIndex((lineValue, index) => index > blockStart && lineValue.trim() === ")");
  const installOrBuild = commands.map((lineValue, index) => (/\bnpm (ci|run build)\b/.test(lineValue) ? index : -1)).filter((index) => index !== -1);
  assert.ok(blockStart !== -1 && installOrBuild.length > 0, "the release build block must exist");
  assert.ok(installOrBuild.every((index) => index > blockStart && index < blockEnd), "npm ci/build must run only inside the release directory");
});

// 新しいmigrationを追加したのにdb:checkの検査を追加し忘れると、デプロイ時の検証が素通りする。
test("every migration file is registered in db:check covered_migrations", async () => {
  const { readdir } = await import("node:fs/promises");
  const files = (await readdir(new URL("../migrations/", import.meta.url))).filter((name) => name.endsWith(".sql")).sort();
  const script = await readFile(new URL("../scripts/check-database-state.sh", import.meta.url), "utf8");
  const block = script.match(/covered_migrations=\(([\s\S]*?)\)/);
  assert.ok(block, "covered_migrations must be declared");
  const covered = block[1].split(/\s+/).filter(Boolean).sort();
  assert.deepEqual(covered, files);
});
