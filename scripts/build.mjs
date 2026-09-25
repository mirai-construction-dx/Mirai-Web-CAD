import { execFileSync } from "node:child_process";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import path from "node:path";

const root = process.cwd();
const dist = path.join(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(path.join(dist, "src"), { recursive: true });

for (const file of ["index.html", "_headers"]) {
  await cp(path.join(root, file), path.join(dist, file));
}

await cp(path.join(root, "src", "styles.css"), path.join(dist, "src", "styles.css"));
await build({
  entryPoints: [path.join(root, "src", "app.js")],
  outfile: path.join(dist, "src", "app.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  legalComments: "none"
});

// 配信物がどのcommitからbuildされたかを記録する。本番は作業ツリーのdist/を配信するため、
// 稼働中のサーバーのcommitと配信物のbuild元がずれていないかをhealthとデプロイで照合する。
const commit = process.env.BUILD_COMMIT || readGitCommit();
await writeFile(path.join(dist, "build-info.json"), `${JSON.stringify({ commit, builtAt: new Date().toISOString() }, null, 2)}\n`);

console.log(`build ok: ${path.relative(root, dist)}${commit ? ` (${commit.slice(0, 7)})` : ""}`);

function readGitCommit() {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    // 未コミットの変更を含むbuildは、レビュー済みcommitと区別できるよう印を付ける。
    return dirty ? `${head}-dirty` : head;
  } catch {
    return null;
  }
}
