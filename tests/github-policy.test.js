import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

// GITHUB_POLICY.md は中央ポリシー v2(全リポジトリ auto-merge 統一、Approval: Kensan196948G/Deep-Seek-Harness-Project#71)
// をそのまま配布したもの。マージ条件は Required Checks の成功と conflict 解消だけで、人間の Y/N・選択式・条件付き merge は無効。
const policy = readFileSync(new URL("../GITHUB_POLICY.md", import.meta.url), "utf8");
const workflowDir = new URL("../.github/workflows/", import.meta.url);
const jobNames = new Set(
  readdirSync(workflowDir)
    .filter((name) => name.endsWith(".yml"))
    .flatMap((name) => [...readFileSync(new URL(name, workflowDir), "utf8").matchAll(/^ {4}name:\s*(.+?)\s*$/gm)].map((match) => match[1].replace(/^["']|["']$/g, "")))
);

// Ruleset `central-auto-merge` の必須チェック(2026-09-30 読み戻し)。実在するCIジョブ名でなければならない(独立レビュー H-2)。
// 中央ポリシー v2 §6 も「required_status_checks はそのリポジトリで実際に報告されるCIジョブ名」と定める。
const requiredChecks = [
  "Lint, Test, Build, E2E, A11y",
  "Empty PostgreSQL Migration",
  "PostgreSQL Backup and Restore Drill",
  "PostgreSQL Data Store Integration",
  "Secret Scan",
  "Dependency Vulnerability Audit",
  "SBOM (CycloneDX)",
  "Synthetic DXF Generation and Audit",
  "Terraform Format and Validate",
  "Deploy Preview",
];

test("Ruleset required checks exist as CI job names, as central policy v2 requires", () => {
  assert.match(policy, /`required_status_checks` \| そのリポジトリで実際に報告されるCIジョブ名/);
  for (const check of requiredChecks) assert.ok(jobNames.has(check), `required check "${check}" is not a CI job name`);
});

test("GITHUB_POLICY.md is central policy v2: auto-merge on Required Checks only, no --admin, no human Y/N merge", () => {
  assert.match(policy, /^# DeepSeek-Harness-StartUpTools GitHub Policy/);
  assert.match(policy, /v2 発効/);
  assert.match(policy, /gh pr merge --auto --squash/);
  assert.match(policy, /`gh pr merge --admin` による迂回は禁止/);
  assert.match(policy, /中央ポリシーがRequired Checks成功だけをmerge条件とする/);
  assert.match(policy, /「main宛は人間の選択式」「マージは人間がY\/Nで判断」/);
  assert.match(policy, /条件付きmerge/);
  assert.match(policy, /CODEOWNERSは通知用であり、merge条件にしない/);
});
