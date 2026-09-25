import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

// GITHUB_POLICY.md が列挙する必須チェックは、実在するCIジョブ名でなければならない
// (以前は存在しない `quality (20)` 等を前提にした別プロジェクトの文書だった。独立レビュー H-2)。
const policy = readFileSync(new URL("../GITHUB_POLICY.md", import.meta.url), "utf8");
const workflowDir = new URL("../.github/workflows/", import.meta.url);
const jobNames = new Set(
  readdirSync(workflowDir)
    .filter((name) => name.endsWith(".yml"))
    .flatMap((name) => [...readFileSync(new URL(name, workflowDir), "utf8").matchAll(/^ {4}name:\s*(.+?)\s*$/gm)].map((match) => match[1].replace(/^["']|["']$/g, "")))
);

test("GITHUB_POLICY.md lists only required checks that exist as CI job names", () => {
  const section = policy.slice(policy.indexOf("## 3."), policy.indexOf("## 4."));
  const listed = [...section.matchAll(/^\s+- `([^`]+)`$/gm)].map((match) => match[1]);
  assert.ok(listed.length >= 5, "the required checks must be listed");
  for (const check of listed) assert.ok(jobNames.has(check), `required check "${check}" is not a CI job name`);
});

test("GITHUB_POLICY.md is the Web-CAD policy and does not mandate auto-merge over owner approval", () => {
  assert.match(policy, /^# Mirai-Web-CAD GitHub運用ポリシー/);
  assert.match(policy, /A型/);
  assert.doesNotMatch(policy, /^# DeepSeek-Harness-StartUpTools/m);
});
