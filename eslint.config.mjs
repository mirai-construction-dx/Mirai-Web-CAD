// ESLint(flat config)。目的は「壊れたコードを配信前に止める」ことであり、
// 好みのスタイルを強制することではない。したがって構文・参照・到達性など
// 実行時バグに直結する規則を中心にerrorとし、整形・命名の規則は入れない。
//
// 導入方針(改善台帳P0-59): 既存コードへ段階導入するため、CIを止めるのは
// 「実際のバグを示す規則」だけにする。スタイル規則は追加しない。
import { defineConfig } from "eslint/config";

// ブラウザとNodeの両方で動く共通のグローバル(Web標準API)。
const webGlobals = {
  AbortController: "readonly",
  AbortSignal: "readonly",
  Blob: "readonly",
  DOMException: "readonly",
  EventTarget: "readonly",
  FormData: "readonly",
  Headers: "readonly",
  ProgressEvent: "readonly",
  Request: "readonly",
  Response: "readonly",
  TextDecoder: "readonly",
  TextEncoder: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  clearInterval: "readonly",
  clearTimeout: "readonly",
  console: "readonly",
  crypto: "readonly",
  fetch: "readonly",
  globalThis: "readonly",
  queueMicrotask: "readonly",
  setInterval: "readonly",
  setTimeout: "readonly",
  structuredClone: "readonly"
};

// src/ はブラウザで動くアプリ本体(テストやスクリプトからも import される)。
const browserGlobals = {
  ...webGlobals,
  CustomEvent: "readonly",
  DOMParser: "readonly",
  Event: "readonly",
  File: "readonly",
  FileReader: "readonly",
  HTMLElement: "readonly",
  Image: "readonly",
  IntersectionObserver: "readonly",
  MutationObserver: "readonly",
  Node: "readonly",
  ResizeObserver: "readonly",
  XMLSerializer: "readonly",
  alert: "readonly",
  atob: "readonly",
  btoa: "readonly",
  cancelAnimationFrame: "readonly",
  confirm: "readonly",
  document: "readonly",
  getComputedStyle: "readonly",
  history: "readonly",
  indexedDB: "readonly",
  localStorage: "readonly",
  location: "readonly",
  matchMedia: "readonly",
  navigator: "readonly",
  performance: "readonly",
  prompt: "readonly",
  requestAnimationFrame: "readonly",
  sessionStorage: "readonly",
  window: "readonly"
};

const nodeGlobals = {
  ...webGlobals,
  Buffer: "readonly",
  __dirname: "readonly",
  __filename: "readonly",
  performance: "readonly",
  process: "readonly",
  setImmediate: "readonly"
};

// 実行時バグに直結する規則のみを有効にする。
const bugDetectionRules = {
  "no-async-promise-executor": "error",
  "no-compare-neg-zero": "error",
  "no-cond-assign": ["error", "except-parens"],
  "no-constant-condition": ["error", { checkLoops: false }],
  // CSVエスケープ等で制御文字を意図的に扱うため無効化する。
  "no-control-regex": "off",
  "no-dupe-args": "error",
  "no-dupe-class-members": "error",
  "no-dupe-keys": "error",
  "no-empty": ["error", { allowEmptyCatch: true }],
  "no-fallthrough": "error",
  "no-obj-calls": "error",
  "no-redeclare": "error",
  "no-self-assign": "error",
  "no-sparse-arrays": "error",
  "no-template-curly-in-string": "error",
  "no-undef": "error",
  "no-unreachable": "error",
  "no-unsafe-negation": "error",
  "no-unsafe-optional-chaining": "error",
  "no-unused-vars": ["error", { args: "none", caughtErrors: "none", ignoreRestSiblings: true }],
  "no-useless-backreference": "error",
  // awaitを挟んだ変数の再代入(本当の競合)は検出し続ける。単一のstateオブジェクトへの
  // プロパティ代入はallowPropertiesで対象外にする。応答待ちの間に図面が切り替わった場合の
  // 上書きは、src/app.jsのdrawingEpoch/isStaleDrawingResponseで応答を破棄して防いでいる。
  "require-atomic-updates": ["warn", { allowProperties: true }],
  "use-isnan": "error",
  "valid-typeof": "error"
};

export default defineConfig([
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "artifacts/**",
      "test-results/**",
      "playwright-report/**",
      ".wrangler/**",
      "DXF-Test-Corpus/**",
      "sample/**",
      "corpus/**"
    ]
  },
  {
    files: ["src/**/*.js"],
    languageOptions: { ecmaVersion: 2023, sourceType: "module", globals: browserGlobals },
    rules: bugDetectionRules
  },
  {
    files: ["scripts/**/*.{js,mjs}", "functions/**/*.js", "tests/**/*.js", "eslint.config.mjs"],
    languageOptions: { ecmaVersion: 2023, sourceType: "module", globals: nodeGlobals },
    rules: bugDetectionRules
  },
  {
    // E2EスペックはNodeで動くが、page.evaluate等のコールバックはブラウザで実行される。
    files: ["tests/e2e/**/*.js"],
    languageOptions: { ecmaVersion: 2023, sourceType: "module", globals: { ...nodeGlobals, ...browserGlobals } },
    rules: bugDetectionRules
  },
  {
    // この検査はHCL中の`${var.account_id}`という「文字列そのもの」を探すため、
    // テンプレート文字列式の警告は誤検知になる。
    files: ["scripts/check-cloudflare-iac.mjs"],
    rules: { ...bugDetectionRules, "no-template-curly-in-string": "off" }
  }
]);
