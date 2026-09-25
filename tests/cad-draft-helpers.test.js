import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_OSNAP_MODES,
  OSNAP_MODES,
  applyOrtho,
  closestPointOnSegment,
  entityKeyPoints,
  entitySegments,
  findOsnapPoint,
  perpendicularFoot,
  segmentIntersection
} from "../src/cad-draft-helpers.js";
import { arc, circle, ellipse, line, polyline, rect, spline } from "../src/cad-core.js";

test("applyOrtho pins the axis with the smaller delta to the anchor", () => {
  assert.deepEqual(applyOrtho({ x: 0, y: 0 }, { x: 120, y: 40 }), { x: 120, y: 0 });
  assert.deepEqual(applyOrtho({ x: 0, y: 0 }, { x: 40, y: 120 }), { x: 0, y: 120 });
  assert.deepEqual(applyOrtho(null, { x: 40, y: 120 }), { x: 40, y: 120 });
});

test("entityKeyPoints returns endpoints/corners/quadrants per entity type", () => {
  const l = line("layer-structure", [0, 0], [100, 0]);
  assert.deepEqual(entityKeyPoints(l), l.points);

  const r = rect("layer-structure", [0, 0], 100, 50);
  assert.deepEqual(entityKeyPoints(r), [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 50 },
    { x: 0, y: 50 }
  ]);

  const c = circle("layer-structure", [10, 10], 5);
  assert.deepEqual(entityKeyPoints(c), [
    { x: 10, y: 10 },
    { x: 15, y: 10 },
    { x: 5, y: 10 },
    { x: 10, y: 15 },
    { x: 10, y: 5 }
  ]);

  const p = polyline("layer-structure", [[0, 0], [10, 0], [10, 10]]);
  assert.deepEqual(entityKeyPoints(p), p.points);
});

test("findOsnapPoint snaps to the nearest visible entity vertex within tolerance", () => {
  const drawing = {
    layers: [
      { id: "layer-structure", visible: true },
      { id: "layer-hidden", visible: false }
    ],
    entities: [
      rect("layer-structure", [1000, 1000], 200, 200, { id: "e_rect" }),
      line("layer-hidden", [1000, 1000], [1500, 1000], { id: "e_hidden" })
    ]
  };

  assert.deepEqual(findOsnapPoint(drawing, { x: 1195, y: 1010 }, 30), { x: 1200, y: 1000 });
  assert.equal(findOsnapPoint(drawing, { x: 1500, y: 1500 }, 30), null);
  assert.equal(findOsnapPoint(drawing, { x: 1495, y: 1000 }, 30), null, "hidden layer must not be snappable");
});

// --- 高精度編集(Round 2): OSnapの中点・交点・垂線・近接点対応 ---

test("entitySegments decomposes line/rect/polyline into segments", () => {
  const l = line("layer-structure", [0, 0], [100, 0]);
  assert.deepEqual(entitySegments(l), [{ a: { x: 0, y: 0 }, b: { x: 100, y: 0 } }]);

  const r = rect("layer-structure", [0, 0], 100, 50);
  assert.equal(entitySegments(r).length, 4);

  const openP = polyline("layer-structure", [[0, 0], [10, 0], [10, 10]]);
  assert.equal(entitySegments(openP).length, 2, "open polyline has n-1 segments");

  const closedP = polyline("layer-structure", [[0, 0], [10, 0], [10, 10]], { closed: true });
  assert.equal(entitySegments(closedP).length, 3, "closed polyline closes back to start");

  assert.deepEqual(entitySegments(circle("layer-structure", [0, 0], 5)), [], "circle has no segments");
});

test("arc exposes only valid key points and segmented geometry for OSnap", () => {
  const entity = arc("layer-structure", [0, 0], 100, 350, 100);
  const keys = entityKeyPoints(entity);
  assert.ok(keys.some((point) => Math.abs(point.x - 100) < 1e-9 && Math.abs(point.y) < 1e-9), "0 degree quadrant");
  assert.ok(keys.some((point) => Math.abs(point.x) < 1e-9 && Math.abs(point.y - 100) < 1e-9), "90 degree quadrant");
  assert.equal(keys.some((point) => Math.abs(point.x + 100) < 1e-9 && Math.abs(point.y) < 1e-9), false, "180 degree quadrant is outside arc");
  assert.ok(entitySegments(entity).length >= 8);

  const drawing = { layers: [{ id: "layer-structure", visible: true }], entities: [entity] };
  assert.deepEqual(findOsnapPoint(drawing, { x: 1, y: 99 }, 5), { x: 0, y: 100 });
});

test("ellipse and spline expose native OSnap keys and sampled curve segments", () => {
  const oval = ellipse("layer-structure", [100, 100], 80, 40, 90);
  const ovalKeys = entityKeyPoints(oval);
  assert.equal(ovalKeys.length, 5);
  assert.ok(ovalKeys.some((point) => Math.abs(point.x - 100) < 1e-9 && Math.abs(point.y - 180) < 1e-9));
  assert.ok(entitySegments(oval).length >= 12);

  const curve = spline("layer-structure", [[0, 0], [50, 100], [100, 0]]);
  assert.deepEqual(entityKeyPoints(curve), curve.controlPoints);
  assert.ok(entitySegments(curve).length >= 8);
  const drawing = { layers: [{ id: "layer-structure", visible: true }], entities: [curve] };
  const endpointOnly = Object.fromEntries(OSNAP_MODES.map((mode) => [mode, mode === "endpoint"]));
  assert.deepEqual(findOsnapPoint(drawing, { x: 2, y: 1 }, 5, endpointOnly), { x: 0, y: 0 });

  const partial = ellipse("layer-structure", [0, 0], 100, 50, 0, { startParameter: 0, endParameter: Math.PI / 2 });
  const partialKeys = entityKeyPoints(partial);
  assert.ok(partialKeys.some((point) => Math.abs(point.x - 100) < 1e-9 && Math.abs(point.y) < 1e-9));
  assert.ok(partialKeys.some((point) => Math.abs(point.x) < 1e-9 && Math.abs(point.y - 50) < 1e-9));
  assert.equal(partialKeys.some((point) => Math.abs(point.x + 100) < 1e-9 && Math.abs(point.y) < 1e-9), false);
});

test("closestPointOnSegment clamps the projection to the segment", () => {
  const a = { x: 0, y: 0 };
  const b = { x: 100, y: 0 };
  assert.deepEqual(closestPointOnSegment({ x: 50, y: 30 }, a, b), { x: 50, y: 0 });
  assert.deepEqual(closestPointOnSegment({ x: -10, y: 30 }, a, b), { x: 0, y: 0 }, "clamps before start");
  assert.deepEqual(closestPointOnSegment({ x: 200, y: -30 }, a, b), { x: 100, y: 0 }, "clamps after end");
});

test("perpendicularFoot returns the foot only when inside the segment", () => {
  const a = { x: 0, y: 0 };
  const b = { x: 100, y: 0 };
  assert.deepEqual(perpendicularFoot({ x: 50, y: 40 }, a, b), { x: 50, y: 0 });
  assert.equal(perpendicularFoot({ x: -20, y: 40 }, a, b), null, "foot outside segment");
  assert.equal(perpendicularFoot({ x: 120, y: 40 }, a, b), null);
});

test("segmentIntersection returns crossing points but not shared endpoints", () => {
  const horizontal = { a: { x: 0, y: 50 }, b: { x: 100, y: 50 } };
  const vertical = { a: { x: 50, y: 0 }, b: { x: 50, y: 100 } };
  assert.deepEqual(segmentIntersection(horizontal, vertical), { x: 50, y: 50 });

  const parallel = { a: { x: 0, y: 10 }, b: { x: 100, y: 10 } };
  assert.equal(segmentIntersection(horizontal, parallel), null, "parallel");

  const disjoint = { a: { x: 200, y: 0 }, b: { x: 200, y: 100 } };
  assert.equal(segmentIntersection(horizontal, disjoint), null, "disjoint");

  // 共有端点(線がつながっているだけ)は交点にしない
  const sharing = { a: { x: 100, y: 50 }, b: { x: 200, y: 50 } };
  assert.equal(segmentIntersection(horizontal, sharing), null, "shared endpoint is not an intersection");
});

test("OSNAP_MODES lists the supported snap modes and defaults keep endpoint/midpoint/center/quadrant/intersection", () => {
  assert.deepEqual(OSNAP_MODES, [
    "endpoint", "midpoint", "center", "quadrant", "intersection", "perpendicular", "tangent", "nearest"
  ]);
  assert.equal(DEFAULT_OSNAP_MODES.endpoint, true);
  assert.equal(DEFAULT_OSNAP_MODES.midpoint, true);
  assert.equal(DEFAULT_OSNAP_MODES.center, true);
  assert.equal(DEFAULT_OSNAP_MODES.quadrant, true);
  assert.equal(DEFAULT_OSNAP_MODES.intersection, true);
  assert.equal(DEFAULT_OSNAP_MODES.perpendicular, false, "perpendicular defaults off to avoid misfires");
  assert.equal(DEFAULT_OSNAP_MODES.tangent, false, "tangent defaults off (needs a from point)");
  assert.equal(DEFAULT_OSNAP_MODES.nearest, false, "nearest defaults off to avoid misfires");
});

test("findOsnapPoint snaps to a line midpoint when midpoint mode is enabled", () => {
  const drawing = {
    layers: [{ id: "layer-structure", visible: true }],
    entities: [line("layer-structure", [0, 0], [1000, 0], { id: "e_line" })]
  };
  assert.deepEqual(findOsnapPoint(drawing, { x: 505, y: 8 }, 20), { x: 500, y: 0 });
  assert.equal(findOsnapPoint(drawing, { x: 505, y: 300 }, 20), null, "far from the line");
});

test("findOsnapPoint finds an intersection of two crossing lines", () => {
  const drawing = {
    layers: [{ id: "layer-structure", visible: true }],
    entities: [
      line("layer-structure", [0, 50], [1000, 50], { id: "e_h" }),
      line("layer-structure", [500, 0], [500, 1000], { id: "e_v" })
    ]
  };
  assert.deepEqual(findOsnapPoint(drawing, { x: 506, y: 55 }, 20), { x: 500, y: 50 });
  assert.equal(findOsnapPoint(drawing, { x: 900, y: 900 }, 20), null);
});

test("findOsnapPoint supports disabling modes via the modes argument", () => {
  const drawing = {
    layers: [{ id: "layer-structure", visible: true }],
    entities: [
      line("layer-structure", [0, 0], [1000, 0], { id: "e_h" }),
      line("layer-structure", [500, 0], [500, 1000], { id: "e_v" })
    ]
  };
  // 交点モードを切れば、線の上(500,55)では何も吸着しない(端点・中点から遠い)
  const modes = { ...DEFAULT_OSNAP_MODES, intersection: false };
  assert.equal(findOsnapPoint(drawing, { x: 506, y: 55 }, 20, modes), null);
  // 中点だけを有効にした場合、中点へ吸着する
  const midpointOnly = { ...DEFAULT_OSNAP_MODES, endpoint: false, intersection: false };
  assert.deepEqual(findOsnapPoint(drawing, { x: 505, y: 8 }, 20, midpointOnly), { x: 500, y: 0 });
});

test("findOsnapPoint snaps perpendicular when enabled", () => {
  const drawing = {
    layers: [{ id: "layer-structure", visible: true }],
    entities: [line("layer-structure", [100, 0], [900, 0], { id: "e_line" })]
  };
  const modes = { ...DEFAULT_OSNAP_MODES, perpendicular: true };
  assert.deepEqual(findOsnapPoint(drawing, { x: 400, y: 15 }, 20, modes), { x: 400, y: 0 });
  // 足までの距離がtoleranceを超える場合は垂線スナップしない(近傍の他候補も無ければnull)
  assert.equal(findOsnapPoint(drawing, { x: 400, y: 300 }, 20, modes), null);
});

test("findOsnapPoint snaps nearest-on-segment when enabled and closer than endpoints", () => {
  const drawing = {
    layers: [{ id: "layer-structure", visible: true }],
    entities: [line("layer-structure", [0, 0], [1000, 0], { id: "e_line" })]
  };
  const modes = { ...DEFAULT_OSNAP_MODES, nearest: true };
  // 端点(1000,0)までの距離 √(494²+6²)≈494 に対し、線上の最近点(506,0)は約6 → nearestが勝つ
  assert.deepEqual(findOsnapPoint(drawing, { x: 506, y: 6 }, 20, modes), { x: 506, y: 0 });
});

test("tangent points from an external point touch circles and respect arc ranges", async () => {
  const { tangentPoints, findOsnapPoint } = await import("../src/cad-draft-helpers.js");
  const { circle, arc, createDrawing } = await import("../src/cad-core.js");
  const ring = circle("layer-structure", [0, 0], 50);
  const from = { x: 100, y: 0 };
  const points = tangentPoints(from, ring);
  assert.equal(points.length, 2);
  for (const tangent of points) {
    assert.ok(Math.abs(Math.hypot(tangent.x, tangent.y) - 50) < 1e-9, "on the circle");
    // 接点では半径と接線が直交する。
    assert.ok(Math.abs(tangent.x * (from.x - tangent.x) + tangent.y * (from.y - tangent.y)) < 1e-6, "perpendicular to radius");
  }
  assert.deepEqual(tangentPoints({ x: 10, y: 0 }, ring), [], "no tangent from inside the circle");
  const upperArc = arc("layer-structure", [0, 0], 50, 0, 180);
  const arcPoints = tangentPoints(from, upperArc);
  assert.equal(arcPoints.length, 1);
  assert.ok(arcPoints[0].y > 0);
  const drawing = createDrawing({ entities: [ring] });
  const upper = points.find((point) => point.y > 0);
  const near = { x: upper.x + 2, y: upper.y + 1 };
  assert.equal(findOsnapPoint(drawing, near, 5, { endpoint: false, midpoint: false, center: false, quadrant: false, intersection: false }, from), null, "tangent is off by default");
  const snapped = findOsnapPoint(drawing, near, 5, { endpoint: false, midpoint: false, center: false, quadrant: false, intersection: false, tangent: true }, from);
  assert.ok(Math.abs(snapped.x - upper.x) < 1e-9 && Math.abs(snapped.y - upper.y) < 1e-9);
  assert.equal(findOsnapPoint(drawing, near, 5, { tangent: true, quadrant: false }, null), null, "tangent needs a from point");
});
