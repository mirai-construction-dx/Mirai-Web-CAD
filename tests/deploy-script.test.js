import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// 改善台帳P0-74: デプロイ経路は本番DBへ書き込まない読み取り専用検証だけを実行する。
test("deploy-local.sh verifies the database read-only and never applies migrations or seeds", async () => {
  const script = await readFile(new URL("../scripts/deploy-local.sh", import.meta.url), "utf8");
  const commands = script.split("\n").filter((lineValue) => !lineValue.trim().startsWith("#"));
  assert.ok(commands.some((lineValue) => lineValue.trim() === "npm run db:check"), "db:check must run during deploy");
  assert.ok(!commands.some((lineValue) => /db:verify|verify-database\.sh|seeds\/demo\.sql/.test(lineValue)), "deploy must not write to the production database");
  // DB検証は再起動より前に行い、失敗時はERR trapでロールバックされる。
  const check = commands.findIndex((lineValue) => lineValue.trim() === "npm run db:check");
  // rollback()内にもrestartがあるため、本処理のrestart(最後の出現)と比較する。
  const restart = commands.findLastIndex((lineValue) => lineValue.includes("systemctl restart mirai-web-cad.service"));
  const trap = commands.findIndex((lineValue) => lineValue.trim() === "trap rollback ERR");
  assert.ok(trap !== -1 && trap < check && check < restart);
});
