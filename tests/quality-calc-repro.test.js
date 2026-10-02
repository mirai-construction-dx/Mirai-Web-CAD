// 品質テスト(計算の再現性・単位・座標系・図面検査)。
//
// 対象業務フロー(これに限定):
//  - 図面検査 validateDrawing: 重複ID / 存在しないレイヤー / 用紙外 / 0長線 / 円半径 / Critical残存
//  - 単位(unit: mm/m)と座標系(MODEL_EXTENT=12000×7000mm、仮想シート)
//  - 計算の決定的再現性・丸め(DXF書出しの座標丸め、図面比較 compareDrawings)
//
// 方針: 浮動小数点は許容差(1e-6)で比較し、決定的出力(issue列/DXF文字列)は strictEqual/deepEqual
// で「完全一致」を要求する。synthetic fixture のみ。業務判定ロジックは緩めない。

import test from "node:test";
import assert from "node:assert/strict";

import {
  MODEL_EXTENT,
  applyTransaction,
  circle,
  createDrawing,
  line,
  seedDrawing,
  text,
  validateDrawing
} from "../src/cad-core.js";
import { compareDrawings } from "../src/drawing-compare.js";
import { exportDxf } from "../src/dxf-export.js";
import { parseCadImport } from "../src/importers.js";
import { TOLERANCE_V0, scoreComparison } from "../src/compat-score.js";

const EPS = 1e-6;

function issueTuples(drawing) {
  return validateDrawing(drawing).map((issue) => [issue.code, issue.entityId, issue.severity]);
}

function approx(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < EPS, `${label}: ${actual} != ${expected} (±${EPS})`);
}

// 検査対象の不正図形を「storage由来の不正データ相当」として直接注入する。
// (applyTransaction は存在しないレイヤー参照を拒否するため、ここでは保存済み相当を再現する)
function buildInvalidFixture() {
  const drawing = createDrawing();
  drawing.entities = [
    line("layer-structure", [100, 100], [200, 100], { id: "dup" }),
    line("layer-structure", [300, 100], [400, 100], { id: "dup" }), // 重複ID(2件目で検出)
    line("no-such-layer", [100, 200], [200, 200], { id: "missing-layer" }), // 存在しないレイヤー
    line("layer-structure", [20000, 0], [21000, 0], { id: "outside" }), // 用紙外(MODEL_EXTENT.maxX超過)
    line("layer-structure", [500, 500], [500, 500], { id: "zero" }), // 0長線
    circle("layer-structure", [600, 600], 0, { id: "r0" }), // 半径0の円
    text("layer-annotation", [100, 300], "注記", { id: "t1", size: 100 }) // missing-title-noteを回避
  ];
  return drawing;
}

// 同じ物理寸法を、m(メートル)とmm(ミリメートル)の2通りで表した図面。
function metersShape() {
  const drawing = createDrawing({ unit: "m" });
  const applied = applyTransaction(drawing, {
    source: "system",
    label: "meters-shape",
    commands: [
      { op: "add", entity: line("layer-structure", [1, 2], [3, 4], { id: "u_line" }) },
      { op: "add", entity: circle("layer-structure", [2, 3], 0.5, { id: "u_circle" }) }
    ]
  });
  assert.equal(applied.ok, true, applied.error);
  return applied.drawing;
}

function millimetersShape() {
  const drawing = createDrawing({ unit: "mm" });
  const applied = applyTransaction(drawing, {
    source: "system",
    label: "millimeters-shape",
    commands: [
      { op: "add", entity: line("layer-structure", [1000, 2000], [3000, 4000], { id: "u_line" }) },
      { op: "add", entity: circle("layer-structure", [2000, 3000], 500, { id: "u_circle" }) }
    ]
  });
  assert.equal(applied.ok, true, applied.error);
  return applied.drawing;
}

// 浮動小数(0.1+0.2, 1/3)を含む図面。丸めの決定性検証用。
function floatFixture() {
  const drawing = createDrawing();
  const applied = applyTransaction(drawing, {
    source: "system",
    label: "float-fixture",
    commands: [
      { op: "add", entity: line("layer-structure", [0.1 + 0.2, 1 / 3], [12000.123456789, 0.0000000004], { id: "f_line" }) },
      { op: "add", entity: circle("layer-structure", [1 / 7, 2 / 3], 1 / 6, { id: "f_circle" }) },
      { op: "add", entity: text("layer-annotation", [0.1, 0.2], "丸め", { id: "f_text", size: 100 }) }
    ]
  });
  assert.equal(applied.ok, true, applied.error);
  return applied.drawing;
}

function roundTripDxf(drawing) {
  const exported = exportDxf(drawing);
  assert.equal(exported.skipped.length, 0, exported.skipped.map((item) => item.reason).join(" / "));
  const base = createDrawing();
  const imported = parseCadImport({
    filename: "roundtrip.dxf",
    content: exported.content,
    drawing: base,
    currentLayerId: "layer-structure"
  });
  const result = applyTransaction(base, { source: "system", label: "roundtrip", commands: imported.commands });
  assert.equal(result.ok, true, result.error);
  return { exported, drawing: result.drawing };
}

// ---------------------------------------------------------------------------
// 1. 決定的再現性
// ---------------------------------------------------------------------------

test("決定的再現性: validateDrawingは別途構築した同一図面で毎回同一のissue列を返す", () => {
  const first = issueTuples(buildInvalidFixture());
  const second = issueTuples(buildInvalidFixture());
  assert.deepEqual(second, first);
  // 同一オブジェクトに対する複数回呼び出しも完全一致する(純関数)
  const drawing = buildInvalidFixture();
  assert.deepEqual(issueTuples(drawing), issueTuples(drawing));
});

test("決定的再現性: compareDrawings(同一図面, 同一図面)は差0・満点", () => {
  const expected = seedDrawing();
  const report = compareDrawings(expected, structuredClone(expected), TOLERANCE_V0);
  assert.equal(report.totals.missing, 0);
  assert.equal(report.totals.extra, 0);
  assert.equal(report.totals.ambiguous, 0);
  assert.equal(report.findings.filter((finding) => finding.severity === "critical").length, 0);
  assert.equal(scoreComparison(report).score, 1);
});

// ---------------------------------------------------------------------------
// 2. 単位一貫性
// ---------------------------------------------------------------------------

test("単位一貫性: m図面はINSUNITS=6で書出され、再読込で座標が丸め誤差内で一致する", () => {
  const source = metersShape();
  assert.equal(source.unit, "m");
  const { exported, drawing } = roundTripDxf(source);
  assert.match(exported.content, /\n9\n\$INSUNITS\n70\n6\n/);
  assert.equal(drawing.unit, "m");

  const lineEntity = drawing.entities.find((entity) => entity.type === "line");
  const circleEntity = drawing.entities.find((entity) => entity.type === "circle");
  approx(lineEntity.points[0].x, 1, "m line p0.x");
  approx(lineEntity.points[0].y, 2, "m line p0.y");
  approx(lineEntity.points[1].x, 3, "m line p1.x");
  approx(lineEntity.points[1].y, 4, "m line p1.y");
  approx(circleEntity.center.x, 2, "m circle center.x");
  approx(circleEntity.center.y, 3, "m circle center.y");
  approx(circleEntity.radius, 0.5, "m circle radius");
});

test("単位一貫性: mm図面はINSUNITS=4で書出され、再読込で座標が丸め誤差内で一致する", () => {
  const source = millimetersShape();
  assert.equal(source.unit, "mm");
  const { exported, drawing } = roundTripDxf(source);
  assert.match(exported.content, /\n9\n\$INSUNITS\n70\n4\n/);
  assert.equal(drawing.unit, "mm");

  const lineEntity = drawing.entities.find((entity) => entity.type === "line");
  const circleEntity = drawing.entities.find((entity) => entity.type === "circle");
  approx(lineEntity.points[0].x, 1000, "mm line p0.x");
  approx(lineEntity.points[0].y, 2000, "mm line p0.y");
  approx(lineEntity.points[1].x, 3000, "mm line p1.x");
  approx(lineEntity.points[1].y, 4000, "mm line p1.y");
  approx(circleEntity.center.x, 2000, "mm circle center.x");
  approx(circleEntity.center.y, 3000, "mm circle center.y");
  approx(circleEntity.radius, 500, "mm circle radius");
});

test("単位一貫性: mとmmの同じ物理寸法は×1000で相互に換算される(座標系の解釈が一貫する)", () => {
  const meters = metersShape();
  const millimeters = millimetersShape();
  const mLine = meters.entities.find((entity) => entity.type === "line");
  const mmLine = millimeters.entities.find((entity) => entity.type === "line");
  const mCircle = meters.entities.find((entity) => entity.type === "circle");
  const mmCircle = millimeters.entities.find((entity) => entity.type === "circle");

  approx(mLine.points[0].x * 1000, mmLine.points[0].x, "line p0.x m→mm");
  approx(mLine.points[1].y * 1000, mmLine.points[1].y, "line p1.y m→mm");
  approx(mCircle.center.x * 1000, mmCircle.center.x, "circle center.x m→mm");
  approx(mCircle.radius * 1000, mmCircle.radius, "circle radius m→mm");
});

// ---------------------------------------------------------------------------
// 3. 検査の検出
// ---------------------------------------------------------------------------

test("検査検出: 重複ID・存在しないレイヤー・用紙外・0長線・半径0円を該当issueとして検出する", () => {
  const issues = validateDrawing(buildInvalidFixture());

  const find = (code) => issues.filter((issue) => issue.code === code);
  assert.ok(find("duplicate-entity-id").some((issue) => issue.entityId === "dup" && issue.severity === "critical"), "重複IDをCriticalで検出");
  assert.ok(find("missing-layer").some((issue) => issue.entityId === "missing-layer" && issue.severity === "critical"), "存在しないレイヤー参照をCriticalで検出");
  assert.ok(find("outside-paper").some((issue) => issue.entityId === "outside" && issue.severity === "major"), "用紙外を検出");
  assert.ok(find("zero-length-line").some((issue) => issue.entityId === "zero" && issue.severity === "major"), "0長線を検出");
  assert.ok(find("invalid-radius").some((issue) => issue.entityId === "r0" && issue.severity === "critical"), "半径0の円をCriticalで検出");
});

test("検査検出: 用紙外判定はMODEL_EXTENT(12000×7000mm)を基準とする", () => {
  // 境界内ぎりぎりの図形は用紙外にならず、1mm超で用紙外になることを確認する。
  const inside = createDrawing();
  inside.entities = [
    line("layer-structure", [0, 0], [MODEL_EXTENT.maxX, MODEL_EXTENT.maxY], { id: "edge" }),
    text("layer-annotation", [500, 500], "注記", { id: "t1", size: 100 })
  ];
  assert.ok(!validateDrawing(inside).some((issue) => issue.code === "outside-paper"), "境界上の図形は用紙外にしない");

  const outside = createDrawing();
  outside.entities = [
    line("layer-structure", [MODEL_EXTENT.maxX + 2, 0], [MODEL_EXTENT.maxX + 3, 0], { id: "over" }),
    text("layer-annotation", [500, 500], "注記", { id: "t1", size: 100 })
  ];
  assert.ok(validateDrawing(outside).some((issue) => issue.code === "outside-paper" && issue.entityId === "over"), "MODEL_EXTENTを超える図形を用紙外として検出");
});

test("検査検出: 正しい図面はCritical/invalid-geometryが0件", () => {
  const issues = validateDrawing(seedDrawing());
  assert.equal(issues.some((issue) => issue.severity === "critical"), false, "Criticalは0件");
  assert.equal(issues.some((issue) => issue.code === "invalid-geometry"), false, "invalid-geometryは0件");
});

// ---------------------------------------------------------------------------
// 4. 丸めの決定性
// ---------------------------------------------------------------------------

test("丸めの決定性: 同一図面のDXF書出しは2回ともbyte一致する", () => {
  const drawing = floatFixture();
  const first = exportDxf(drawing).content;
  const second = exportDxf(drawing).content;
  assert.strictEqual(first, second);
});

test("丸めの決定性: 別途構築した同一図面のDXF書出しもbyte一致する", () => {
  const first = exportDxf(floatFixture()).content;
  const second = exportDxf(floatFixture()).content;
  assert.strictEqual(first, second);
});
