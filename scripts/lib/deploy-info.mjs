// 稼働中のコードがどのコミットに由来するかを機械的に識別するための共通モジュール。
//
// 背景(実事故): 2026-09-18、本番ホストのローカルmainがGitHub mainから分岐し、
// 未レビューのPR #87ブランチのコードが本番で稼働していたことが人手で発見されるまで
// 誰も気づけなかった(Issue #98 / 改善台帳P0-58)。原因は「稼働コミットを機械的に
// 記録・比較する仕組みが無く、確認が人の記憶に依存していたこと」にある。
//
// このモジュールは次の2つだけを担う。
//   1. 現在の作業ツリーが指すcommit/branch/未コミット有無を読み取る(readDeployInfo)
//   2. その状態がorigin/mainと比べて安全かどうかを判定する(classifyDeployProvenance)
// 判定はローカルのgit情報だけを使い、ネットワークへは一切アクセスしない
// (systemd起動時のガードとして使うため、外部到達性に依存させない)。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

export const DEPLOY_PROVENANCE = Object.freeze({
  VERIFIED: "verified", // origin/mainと一致しており、未コミット変更もない
  BEHIND: "behind", // origin/mainの方が進んでいる(通常のマージ直後。デプロイ待ち)
  AHEAD: "ahead", // origin/mainに無いコミットが稼働している(未レビューコードの稼働)
  DIRTY: "dirty", // 未コミット変更が混ざった状態で稼働している
  UNKNOWN: "unknown" // git情報が読めない(アーカイブ配布・git未導入など)
});

/**
 * gitコマンドを実行して標準出力を1行に正規化して返す。
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string}
 */
function defaultGitRunner(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000
  }).trim();
}

/**
 * 現在の作業ツリーのデプロイ素性情報を読み取る。gitが使えない場合はUNKNOWN相当を返し、
 * 例外は投げない(起動を止めないため)。
 * @param {{ cwd?: string, gitRunner?: (args: string[], cwd: string) => string }} [options]
 * @returns {{ commit: string|null, commitShort: string|null, branch: string|null, dirty: boolean|null, originMain: string|null }}
 */
export function readDeployInfo(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const git = options.gitRunner ?? defaultGitRunner;
  try {
    const commit = git(["rev-parse", "HEAD"], cwd);
    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
    const status = git(["status", "--porcelain"], cwd);
    let originMain = null;
    try {
      originMain = git(["rev-parse", "--verify", "origin/main"], cwd) || null;
    } catch {
      originMain = null;
    }
    return {
      commit: commit || null,
      commitShort: commit ? commit.slice(0, 7) : null,
      branch: branch || null,
      dirty: status.length > 0,
      originMain
    };
  } catch {
    return { commit: null, commitShort: null, branch: null, dirty: null, originMain: null };
  }
}

/**
 * 配信物(dist/build-info.json)が記録するbuild元commitを読み取る。
 *
 * `scripts/build.mjs`は`BUILD_COMMIT`(無ければgit HEAD)を`dist/build-info.json`へ書く。
 * 独立リリースのStagingのようにgit管理外のアーカイブを配信する場合、サーバー側のgit情報は
 * 無いが、配信物にはbuild元commitが残っている。healthの`deploy.commit`をこの値へ
 * フォールバックさせ、アーカイブ配信でも稼働commitを機械的に確認できるようにする。
 * 壊れた/欠落したファイルはnullを返し、例外は投げない(起動を止めないため)。
 * @param {{ cwd?: string, distRoot?: string }} [options]
 * @returns {string|null}
 */
export function readBuildInfoCommit(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const distRoot = options.distRoot ?? path.join(cwd, "dist");
  try {
    const info = JSON.parse(readFileSync(path.join(distRoot, "build-info.json"), "utf8"));
    return typeof info.commit === "string" && info.commit.length > 0 ? info.commit : null;
  } catch {
    return null;
  }
}

/**
 * 稼働commitを決める。git情報がある場合はそれを最優先し(本番の既存挙動を変えない)、
 * git情報が無い場合に限り配信物のbuild元commitへフォールバックする。
 * provenanceの判定(git情報に基づく)は別関数のままとし、ここでは「どのcommitとして
 * 報告するか」だけを決める。
 * @param {{ commit: string|null, commitShort?: string|null }|null} info readDeployInfoの戻り値
 * @param {{ cwd?: string, distRoot?: string }} [options]
 * @returns {{ commit: string|null, commitShort: string|null, source: "git"|"build-info"|null, buildInfoCommit: string|null }}
 */
export function resolveDeployCommit(info, options = {}) {
  const buildInfoCommit = readBuildInfoCommit(options);
  if (info?.commit) {
    return {
      commit: info.commit,
      commitShort: info.commitShort ?? info.commit.slice(0, 7),
      source: "git",
      buildInfoCommit
    };
  }
  return {
    commit: buildInfoCommit,
    commitShort: buildInfoCommit ? buildInfoCommit.slice(0, 7) : null,
    source: buildInfoCommit ? "build-info" : null,
    buildInfoCommit
  };
}

/**
 * 稼働素性を判定する。`ahead`/`dirty` は「レビューを経ていないコードが稼働している」
 * ことを意味するため、strictな運用ではこれを起動拒否の条件にする。
 *
 * 重要: `counts` が `null`(origin/main 参照が未取得)の場合は **verified ではなく
 * unknown** を返す。比較できないことを「一致」と報告すると、検知器そのものが
 * 見逃しの原因になる(fail-open)。
 * @param {{ commit: string|null, dirty: boolean|null, counts?: { ahead: number, behind: number }|null }} input
 * @returns {{ status: string, reasons: string[] }}
 */
export function classifyDeployProvenance(input) {
  const reasons = [];
  if (!input.commit) {
    return { status: DEPLOY_PROVENANCE.UNKNOWN, reasons: ["稼働commitを特定できません(git情報なし)"] };
  }
  if (input.dirty === true) {
    reasons.push("作業ツリーに未コミットの変更があります");
  }
  const counts = input.counts;
  if (counts && Number.isFinite(counts.ahead) && counts.ahead > 0) {
    reasons.push(`origin/mainに存在しないcommitが${counts.ahead}件稼働しています`);
  }
  if (reasons.length > 0) {
    return { status: input.dirty === true && !counts?.ahead ? DEPLOY_PROVENANCE.DIRTY : DEPLOY_PROVENANCE.AHEAD, reasons };
  }
  if (!counts) {
    return {
      status: DEPLOY_PROVENANCE.UNKNOWN,
      reasons: ["origin/mainの参照が未取得のため、レビュー済みmainとの一致を判定できません"]
    };
  }
  if (Number.isFinite(counts.behind) && counts.behind > 0) {
    return { status: DEPLOY_PROVENANCE.BEHIND, reasons: [`origin/mainが${counts.behind}件先行しています(デプロイ待ち)`] };
  }
  return { status: DEPLOY_PROVENANCE.VERIFIED, reasons: [] };
}

/**
 * ローカルgit情報だけから`ahead`/`behind`を数える。ネットワークへは出ない。
 * `origin/main` が未取得の場合はnullを返し、判定側でUNKNOWNに縮退させる。
 * @param {{ cwd?: string, gitRunner?: (args: string[], cwd: string) => string }} [options]
 * @returns {{ ahead: number, behind: number }|null}
 */
export function readCommitCounts(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const git = options.gitRunner ?? defaultGitRunner;
  try {
    git(["rev-parse", "--verify", "origin/main"], cwd);
    const output = git(["rev-list", "--left-right", "--count", "origin/main...HEAD"], cwd);
    const [behindRaw, aheadRaw] = output.split(/\s+/);
    const behind = Number.parseInt(behindRaw, 10);
    const ahead = Number.parseInt(aheadRaw, 10);
    if (!Number.isFinite(behind) || !Number.isFinite(ahead)) return null;
    return { ahead, behind };
  } catch {
    return null;
  }
}

/**
 * `readDeployInfo` + `readCommitCounts` をまとめて評価する。
 * @param {{ cwd?: string, gitRunner?: (args: string[], cwd: string) => string }} [options]
 */
export function evaluateDeployProvenance(options = {}) {
  const info = readDeployInfo(options);
  const counts = info.commit ? readCommitCounts(options) : null;
  return { info, counts, ...classifyDeployProvenance({ commit: info.commit, dirty: info.dirty, counts }) };
}
