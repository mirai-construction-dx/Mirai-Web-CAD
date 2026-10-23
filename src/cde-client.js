// CDE(確定版の正本)へ承認済み版を登録する将来APIのための**フェイルクローズド**なアダプタ。
//
// 2026-10-23時点の実測では、CDEにはREST APIとMCPツールがあるが、Web-CADの確定版を
// 登録するAPI・認証・受入形式は提供されていない(docs/architecture/platform-integration.md §6.4)。
// したがって本モジュールは推測のエンドポイントを実装せず、どの環境変数が設定されていても
// `registerApprovedVersion` は常に `not_supported` を返し、ネットワーク呼び出しを行わない。
// このファイルに `fetch` は無い(テストで静的に検証する)。
//
// 設定はMCIPアダプタと同じ規則で扱う:
// - 未設定なら `not_configured`(fail-closed)
// - base URLが不正・資格情報入り・平文HTTP(ループバック以外)なら `invalid_configuration`
// - 秘密値(トークン)は戻り値・ログへ出さない
//
// 将来の登録インターフェース(設計案。項目は外部入力で確定する):
//   registerApprovedVersion({
//     projectId,        // Web-CADの案件ID(現行は `prj_…`)。MCIP IDではない
//     drawingId,        // Web-CADの図面ID(`dwg_…`)
//     versionId,        // 確定済み版のID(`drawing_versions.id`)
//     versionNo,        // 版番号
//     contentHash,      // 版の内容ハッシュ(改ざん検知・照合用)
//     approverId,       // 承認者のIdP oid(メールアドレスは渡さない)
//     approvalRef,      // Web-CAD側の承認記録への参照
//     idempotencyKey    // 再送時の重複登録を防ぐキー(方式はCDEと確定する)
//   })
//
// 必要な外部入力(認証方式・登録形式・冪等キー等)は docs/architecture/integration-adapters.md
// に列挙する。CDEが受入APIを提供するまで、本モジュールは登録を実行しない。
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export const CDE_ERROR_CODES = Object.freeze({
  NOT_CONFIGURED: "not_configured",
  INVALID_CONFIGURATION: "invalid_configuration",
  NOT_SUPPORTED: "not_supported"
});

export function describeCdeConfig(env) {
  const baseUrl = normalize(env?.CDE_API_BASE_URL);
  const token = normalize(env?.CDE_API_TOKEN);
  if (!baseUrl || !token) return { enabled: false, reason: "missing_configuration", baseUrlOrigin: null };
  const parsed = parseBaseUrl(baseUrl);
  if (!parsed.ok) return { enabled: false, reason: parsed.reason, baseUrlOrigin: null };
  return { enabled: true, reason: null, baseUrlOrigin: parsed.url.origin };
}

export function createCdeClient(env) {
  const config = describeCdeConfig(env);

  return {
    configured: config.enabled,

    // 秘密値を含まない設定状態。ログ・ヘルス応答へ出してよい。
    describe() {
      return { ...config };
    },

    // API未提供のため、設定済みでも常に `not_supported` を返す。
    // 入力は検証しない(先に「APIが無い」ことを明示するほうが誤解が少ない)。
    // 将来CDEの受入APIが提供された時点で、このメソッドの実装とdocsを同時に更新する。
    async registerApprovedVersion(input) {
      if (!config.enabled) {
        return failure(
          config.reason === "missing_configuration" ? CDE_ERROR_CODES.NOT_CONFIGURED : CDE_ERROR_CODES.INVALID_CONFIGURATION,
          config.reason === "missing_configuration"
            ? "CDEのAPI設定が無いため、外部呼び出しを行いません。"
            : "CDEのAPI設定が不正なため、外部呼び出しを行いません。"
        );
      }
      return failure(
        CDE_ERROR_CODES.NOT_SUPPORTED,
        "CDEには承認済み版を登録するAPIが提供されていません。推測のエンドポイントへは送信しません(外部入力待ち)。"
      );
    }
  };
}

function failure(code, message) {
  return { ok: false, error: { code, message } };
}

function normalize(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "invalid_base_url" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, reason: "invalid_base_url" };
  if (!url.hostname) return { ok: false, reason: "invalid_base_url" };
  if (url.username || url.password) return { ok: false, reason: "credentials_in_base_url" };
  if (url.search || url.hash) return { ok: false, reason: "invalid_base_url" };
  if (url.protocol === "http:" && !LOOPBACK_HOSTNAMES.has(url.hostname)) {
    return { ok: false, reason: "insecure_base_url" };
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return { ok: true, url };
}
