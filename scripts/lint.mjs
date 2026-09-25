import { readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { findMalformedHeaderLines } from "./lib/http-bridge.mjs";

const root = process.cwd();
const required = [
  "AGENTS.md",
  "CLAUDE.md",
  "index.html",
  "src/app.js",
  "src/cad-core.js",
  "src/cad-command.js",
  "src/importers.js",
  "src/storage.js",
  "src/styles.css",
  "src/drawing-compare.js",
  "src/compat-score.js",
  "scripts/lib/corpus-ledger.mjs",
  "scripts/corpus-ledger.mjs",
  "docs/compat-corpus/ledger.json",
  "migrations/0001_initial.sql",
  "migrations/0002_idempotency.sql",
  "migrations/0003_drawing_revision.sql",
  "migrations/0004_drawing_visibility.sql",
  "migrations/0005_audit_log_immutability.sql",
  "migrations/0006_normalize_jsonb_columns.sql",
  "migrations/0007_project_membership.sql",
  "migrations/0008_audit_truncate_guard.sql",
  "scripts/check-mvp-health.sh",
  "scripts/database-signature.sh",
  "scripts/restore-drill-local.sh",
  "scripts/check-deploy-drift.mjs",
  "scripts/lib/deploy-info.mjs",
  "scripts/sql/verify-audit-append-only.sql",
  "deploy/systemd/mirai-web-cad-deploy-drift.service",
  "deploy/systemd/mirai-web-cad-deploy-drift.timer",
  "deploy/systemd/mirai-web-cad-restore-drill.service",
  "deploy/systemd/mirai-web-cad-restore-drill.timer",
  "deploy/systemd/mirai-web-cad-mvp-backup.service",
  "deploy/systemd/mirai-web-cad-mvp-backup.timer",
  "deploy/systemd/mirai-web-cad-mvp-backup-check.service",
  "deploy/systemd/mirai-web-cad-mvp-backup-check.timer",
  "deploy/systemd/mirai-web-cad-mvp-monitor.service",
  "deploy/systemd/mirai-web-cad-mvp-monitor.timer",
  "deploy/systemd/mirai-web-cad-mvp-restore-drill.service",
  "deploy/systemd/mirai-web-cad-mvp-restore-drill.timer",
  "infra/cloudflare/main.tf",
  "infra/cloudflare/variables.tf",
  "infra/cloudflare/terraform.tfvars.example",
  "infra/cloudflare/imports.tf",
  "infra/cloudflare/README.md",
  "docs/runbooks/cloudflare-access-change.md",
  "docs/runbooks/database-incident.md",
  "docs/runbooks/service-outage.md",
  "_headers",
  "seeds/demo.sql",
  "playwright.config.js",
  "tsconfig.check.json",
  "eslint.config.mjs"
];

const failures = [];

for (const file of required) {
  try {
    const content = await readFile(path.join(root, file), "utf8");
    if (content.trim().length === 0) failures.push(`${file}: empty file`);
  } catch {
    failures.push(`${file}: missing`);
  }
}

const checkDirs = ["src", "functions", "tests", "scripts"];
for (const file of (await Promise.all(checkDirs.map((dir) => jsFiles(path.join(root, dir))))).flat()) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    failures.push(`${path.relative(root, file)}: ${result.stderr || result.stdout}`);
  }
}

const css = await readFile(path.join(root, "src/styles.css"), "utf8");
const forbidden = ["TODO", "FIXME"];
for (const token of forbidden) {
  if (css.includes(token)) failures.push(`src/styles.css: unresolved marker ${token}`);
}

// `_headers`の書式違反は、パーサが該当行を黙って捨てるためCSP等が無言で
// 欠落したまま配信され得る。配信前に検出する。
for (const problem of findMalformedHeaderLines(await readFile(path.join(root, "_headers"), "utf8"))) {
  failures.push(`_headers:${problem.line}: ${problem.reason}`);
}

const iacCheck = spawnSync(process.execPath, ["scripts/check-cloudflare-iac.mjs"], {
  cwd: root,
  encoding: "utf8"
});
if (iacCheck.status !== 0) {
  failures.push(`Cloudflare IaC: ${iacCheck.stderr || iacCheck.stdout}`);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("lint ok");

async function jsFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await jsFiles(full)));
    if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".mjs"))) files.push(full);
  }
  return files;
}
