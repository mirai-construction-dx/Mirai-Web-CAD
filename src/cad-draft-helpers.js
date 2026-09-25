import { angleOnArc, arcPointAt, arcSweepDegrees, ellipsePointAt, ellipseSweepRadians, parameterOnEllipse, sampleEllipse, sampleSpline } from "./cad-core.js";

/**
 * Pure geometry helpers for interactive drafting aids (orthogonal constraint,
 * object snap). Kept separate from src/app.js so they stay unit-testable
 * without a DOM/canvas, and so src/app.js does not grow further as a single
 * monolithic UI module (see docs/production-readiness-assessment.md).
 *
 * OSnap modes (AutoCAD風の対象種別):
 *   endpoint      線分・ポリライン頂点・矩形隅・文字挿入点
 *   midpoint      各セグメントの中点
 *   center        円の中心
 *   quadrant      円の四分点(0/90/180/270°)
 *   intersection  セグメント同士の交点
 *   perpendicular カーソルからセグメントへの垂線の足(セグメント上)
 *   nearest       セグメント上の最近点
 *
 * 設計メモ(性能): 対象エンティティは「カーソルからセグメント距離≦tolerance」のものに
 * 事前限定する。交差点pがカーソルからtol以内なら、そのpを通る各セグメントの
 * カーソル距離も≦tolになるため、この限定は交点を取りこぼさない(幾何的に厳密)。
 */

/**
 * Constrain `point` relative to `anchor` to the nearer of the horizontal or
 * vertical axis, matching AutoCAD-style ORTHO behaviour: whichever axis has
 * the larger absolute delta from the anchor wins, the other is pinned to the
 * anchor's value.
 * @param {{x:number,y:number}|null|undefined} anchor
 * @param {{x:number,y:number}} point
 * @returns {{x:number,y:number}}
 */
export function applyOrtho(anchor, point) {
  if (!anchor) return point;
  const dx = Math.abs(point.x - anchor.x);
  const dy = Math.abs(point.y - anchor.y);
  return dx >= dy ? { x: point.x, y: anchor.y } : { x: anchor.x, y: point.y };
}

/**
 * Candidate OSnap points for one entity: endpoints/corners/centers a drafter
 * would expect to snap to. Intentionally coarse (no midpoints/intersections)
 * to keep the scan cheap for large drawings.
 * @param entity a CAD entity from cad-core.js (line/rect/circle/polyline/text/dimension/hatch/block)
 * @returns {{x:number,y:number}[]}
 */
export function entityKeyPoints(entity) {
  const copy = (p) => ({ x: p.x, y: p.y });
  if (entity.type === "line" || entity.type === "dimension") return entity.points.map(copy);
  if (entity.type === "polyline" || entity.type === "hatch") return entity.points.map(copy);
  if (entity.type === "rect") {
    const o = entity.origin;
    return [
      copy(o),
      { x: o.x + entity.width, y: o.y },
      { x: o.x + entity.width, y: o.y + entity.height },
      { x: o.x, y: o.y + entity.height }
    ];
  }
  if (entity.type === "circle") {
    const c = entity.center;
    const r = entity.radius;
    return [copy(c), { x: c.x + r, y: c.y }, { x: c.x - r, y: c.y }, { x: c.x, y: c.y + r }, { x: c.x, y: c.y - r }];
  }
  if (entity.type === "arc") {
    const points = [copy(entity.center), arcPointAt(entity, entity.startAngle), arcPointAt(entity, entity.endAngle)];
    for (const angle of [0, 90, 180, 270]) {
      if (angleOnArc(angle, entity.startAngle, entity.endAngle)) points.push(arcPointAt(entity, angle));
    }
    return points;
  }
  if (entity.type === "ellipse") {
    const parameters = [entity.startParameter, entity.endParameter, 0, Math.PI / 2, Math.PI, Math.PI * 1.5]
      .filter((parameter) => parameterOnEllipse(parameter, entity));
    const points = [copy(entity.center), ...parameters.map((parameter) => ellipsePointAt(entity, parameter))];
    return points.filter((value, index) => points.findIndex((candidate) => Math.hypot(candidate.x - value.x, candidate.y - value.y) < 1e-9) === index);
  }
  if (entity.type === "spline") return entity.controlPoints.map(copy);
  if (entity.type === "text") return [copy(entity.at)];
  if (entity.type === "block") return entity.insertion ? [copy(entity.insertion)] : [];
  return [];
}

/**
 * 線分・矩形・ポリライン等をセグメント(両端点)列へ分解する。円弧・円・文字・
 * ブロックはセグメントを持たない(円はcenter/quadrantで処理する)。
 * @param entity a CAD entity from cad-core.js
 * @returns {{a:{x:number,y:number},b:{x:number,y:number}}[]}
 */
export function entitySegments(entity) {
  if (entity.type === "line") {
    if (!entity.points?.[0] || !entity.points?.[1]) return [];
    return [{ a: entity.points[0], b: entity.points[1] }];
  }
  if (entity.type === "dimension") {
    if (!entity.points?.[0] || !entity.points?.[1]) return [];
    return [{ a: entity.points[0], b: entity.points[1] }];
  }
  if (entity.type === "arc") {
    const sweep = arcSweepDegrees(entity);
    if (!entity.center || !Number.isFinite(entity.radius) || entity.radius <= 0 || sweep <= 0) return [];
    const count = Math.max(8, Math.min(128, Math.ceil(sweep / 7.5)));
    const points = Array.from({ length: count + 1 }, (_, index) =>
      arcPointAt(entity, entity.startAngle + (sweep * index) / count)
    );
    return points.slice(1).map((value, index) => ({ a: points[index], b: value }));
  }
  if (entity.type === "ellipse" || entity.type === "spline") {
    const points = entity.type === "ellipse" ? sampleEllipse(entity) : sampleSpline(entity);
    if (points.length < 2) return [];
    const segments = points.slice(1).map((value, index) => ({ a: points[index], b: value }));
    if (entity.type === "spline" && entity.closed) segments.push({ a: points.at(-1), b: points[0] });
    return segments;
  }
  if (entity.type === "rect") {
    if (!entity.origin) return [];
    const o = entity.origin;
    const corners = [
      o,
      { x: o.x + entity.width, y: o.y },
      { x: o.x + entity.width, y: o.y + entity.height },
      { x: o.x, y: o.y + entity.height }
    ];
    return corners.map((corner, index) => ({ a: corner, b: corners[(index + 1) % corners.length] }));
  }
  if (entity.type === "polyline" || entity.type === "hatch") {
    if (!Array.isArray(entity.points) || entity.points.length < 2) return [];
    const segments = [];
    for (let index = 0; index < entity.points.length - 1; index += 1) {
      segments.push({ a: entity.points[index], b: entity.points[index + 1] });
    }
    if (entity.closed && entity.points.length > 2) {
      segments.push({ a: entity.points[entity.points.length - 1], b: entity.points[0] });
    }
    return segments;
  }
  return [];
}

/**
 * 点pからセグメントab上の最近点(垂線の足をセグメント区間へクランプした値)。
 * @param {{x:number,y:number}} p
 * @param {{x:number,y:number}} a
 * @param {{x:number,y:number}} b
 * @returns {{x:number,y:number}}
 */
export function closestPointOnSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return { x: a.x, y: a.y };
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared));
  return { x: a.x + t * dx, y: a.y + t * dy };
}

/**
 * 点pからセグメントabへの垂線の足。足がセグメント区間外にある場合はnull
 * (AutoCADのPERpendicularスナップは「セグメント上に垂線の足が乗る」場合のみ)。
 * @param {{x:number,y:number}} p
 * @param {{x:number,y:number}} a
 * @param {{x:number,y:number}} b
 * @returns {{x:number,y:number}|null}
 */
export function perpendicularFoot(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return null;
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared;
  if (t < 0 || t > 1) return null;
  return { x: a.x + t * dx, y: a.y + t * dy };
}

/**
 * 2つのセグメントの交点。交差しない/平行の場合はnull。
 * 端点同士の接触(共有端点)は交点として返さない(CADのINTERSECTは
 * クロス交差のみを対象とするのが一般的。共有端点はendpointスナップで拾える)。
 * @param {{a:{x,y},b:{x,y}}} s1
 * @param {{a:{x,y},b:{x,y}}} s2
 * @returns {{x:number,y:number}|null}
 */
export function segmentIntersection(s1, s2) {
  const EPS = 1e-9;
  const { a: p1, b: p2 } = s1;
  const { a: p3, b: p4 } = s2;
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x;
  const d2y = p4.y - p3.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < EPS) return null; // 平行
  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
  const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / denom;
  // 共有端点(端点同士の接触)は除外: t/uが端点(0または1)で、かつ相手も端点の場合
  const atTEnd = t < EPS || t > 1 - EPS;
  const atUEnd = u < EPS || u > 1 - EPS;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
  if (atTEnd && atUEnd) return null;
  return { x: p1.x + t * d1x, y: p1.y + t * d1y };
}

/**
 * 有効なOSnapモード集合(UI・デフォルト値の正本)。
 */
export const OSNAP_MODES = Object.freeze(["endpoint", "midpoint", "center", "quadrant", "intersection", "perpendicular", "tangent", "nearest"]);

/**
 * デフォルトの有効モード。近接点(nearest)は「線の近くをクリックすると常に
 * 線上へ吸着してしまう」ため既定OFF(UIから明示的にON可能)。垂線も誤発火を
 * 避けるため既定OFF。AutoCAD同様、端点・中点・中心・四分点・交点は既定ON。
 */
export const DEFAULT_OSNAP_MODES = Object.freeze({
  endpoint: true,
  midpoint: true,
  center: true,
  quadrant: true,
  intersection: true,
  perpendicular: false,
  tangent: false,
  nearest: false
});

/** モード優先度(同距離時にどれを採用するか)。距離が違えば距離優先。 */
const MODE_PRIORITY = Object.freeze({
  endpoint: 0,
  intersection: 1,
  midpoint: 2,
  center: 3,
  quadrant: 4,
  perpendicular: 5,
  tangent: 6,
  nearest: 7
});

/**
 * 外部の点fromから円・円弧へ引いた接線の接点(最大2点)。fromが円の内側・円周上なら接点はない。
 * 円弧は接点が弧の範囲にあるものだけを返す。
 * @param {{ x: number, y: number }} from
 * @param entity circle または arc
 */
export function tangentPoints(from, entity) {
  if (entity.type !== "circle" && entity.type !== "arc") return [];
  const { center, radius } = entity;
  const dx = from.x - center.x;
  const dy = from.y - center.y;
  const distance = Math.hypot(dx, dy);
  if (!(radius > 0) || distance <= radius + 1e-9) return [];
  const base = Math.atan2(dy, dx);
  const offset = Math.acos(radius / distance);
  const points = [];
  for (const angle of [base + offset, base - offset]) {
    const degrees = ((angle * 180) / Math.PI + 360) % 360;
    if (entity.type === "arc" && !angleOnArc(degrees, entity.startAngle, entity.endAngle)) continue;
    points.push({ x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) });
  }
  return points;
}

/**
 * 1エンティティから有効モードの候補点を列挙する。
 * @param entity
 * @param modes enabled mode object (DEFAULT_OSNAP_MODES互換)
 * @returns {{x:number,y:number,mode:string}[]}
 */
function candidatesForEntity(entity, modes) {
  const copy = (p) => ({ x: p.x, y: p.y });
  const result = [];
  const segments = entitySegments(entity);

  if (modes.endpoint) {
    if (entity.type === "line" || entity.type === "polyline" || entity.type === "hatch" || entity.type === "dimension") {
      for (const point of entity.points ?? []) result.push({ ...copy(point), mode: "endpoint" });
    } else if (entity.type === "arc") {
      result.push(
        { ...arcPointAt(entity, entity.startAngle), mode: "endpoint" },
        { ...arcPointAt(entity, entity.endAngle), mode: "endpoint" }
      );
    } else if (entity.type === "ellipse" && ellipseSweepRadians(entity) < Math.PI * 2 - 1e-9) {
      result.push(
        { ...ellipsePointAt(entity, entity.startParameter), mode: "endpoint" },
        { ...ellipsePointAt(entity, entity.endParameter), mode: "endpoint" }
      );
    } else if (entity.type === "spline") {
      const points = sampleSpline(entity);
      if (points.length > 1) result.push({ ...points[0], mode: "endpoint" }, { ...points.at(-1), mode: "endpoint" });
    } else if (entity.type === "rect") {
      const o = entity.origin;
      result.push(
        { ...copy(o), mode: "endpoint" },
        { x: o.x + entity.width, y: o.y, mode: "endpoint" },
        { x: o.x + entity.width, y: o.y + entity.height, mode: "endpoint" },
        { x: o.x, y: o.y + entity.height, mode: "endpoint" }
      );
    } else if (entity.type === "text") {
      if (entity.at) result.push({ ...copy(entity.at), mode: "endpoint" });
    } else if (entity.type === "block") {
      if (entity.insertion) result.push({ ...copy(entity.insertion), mode: "endpoint" });
    }
  }

  if (modes.midpoint) {
    if (entity.type === "arc") {
      result.push({ ...arcPointAt(entity, entity.startAngle + arcSweepDegrees(entity) / 2), mode: "midpoint" });
    } else if (entity.type === "ellipse") {
      result.push({ ...ellipsePointAt(entity, entity.startParameter + ellipseSweepRadians(entity) / 2), mode: "midpoint" });
    } else for (const segment of segments) {
      result.push({
        x: (segment.a.x + segment.b.x) / 2,
        y: (segment.a.y + segment.b.y) / 2,
        mode: "midpoint"
      });
    }
  }

  if (modes.center && (entity.type === "circle" || entity.type === "arc" || entity.type === "ellipse") && entity.center) {
    result.push({ ...copy(entity.center), mode: "center" });
  }

  if (modes.quadrant && entity.type === "ellipse" && entity.center) {
    for (const parameter of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
      if (parameterOnEllipse(parameter, entity)) result.push({ ...ellipsePointAt(entity, parameter), mode: "quadrant" });
    }
  } else if (modes.quadrant && (entity.type === "circle" || entity.type === "arc") && entity.center) {
    const c = entity.center;
    const r = Number.isFinite(entity.radius) ? entity.radius : 0;
    const quadrants = [
      { angle: 0, x: c.x + r, y: c.y },
      { angle: 180, x: c.x - r, y: c.y },
      { angle: 90, x: c.x, y: c.y + r },
      { angle: 270, x: c.x, y: c.y - r }
    ];
    for (const candidate of quadrants) {
      if (entity.type === "circle" || angleOnArc(candidate.angle, entity.startAngle, entity.endAngle)) {
        result.push({ x: candidate.x, y: candidate.y, mode: "quadrant" });
      }
    }
  }

  return result;
}

/**
 * 図面上の全可視エンティティから、worldPointに最も近い有効OSnap候補を返す。
 * 候補がtoleranceWorld内に無い場合はnull。戻り値は従来契約どおり座標のみ。
 * @param drawing a CAD drawing from cad-core.js ({layers, entities})
 * @param {{x:number,y:number}} worldPoint
 * @param {number} toleranceWorld world-unit search radius
 * @param {object} [modes] 有効モード(DEFAULT_OSNAP_MODES互換)。省略時は既定全モード
 * @param {{x:number,y:number}|null} [fromPoint] 作図中の直前の点。接線(tangent)の計算に使う
 * @returns {{x:number,y:number}|null}
 */
export function findOsnapPoint(drawing, worldPoint, toleranceWorld, modes = DEFAULT_OSNAP_MODES, fromPoint = null) {
  const visibleLayerIds = new Set(drawing.layers.filter((layer) => layer.visible).map((layer) => layer.id));
  const active = { ...DEFAULT_OSNAP_MODES, ...(modes ?? {}) };
  const nearEntities = [];
  for (const entity of drawing.entities) {
    if (!visibleLayerIds.has(entity.layerId)) continue;
    nearEntities.push(entity);
  }

  let best = null;
  let bestDistance = Infinity;
  let bestPriority = Infinity;

  const consider = (candidate) => {
    const distance = Math.hypot(candidate.x - worldPoint.x, candidate.y - worldPoint.y);
    if (distance > toleranceWorld) return;
    const priority = MODE_PRIORITY[candidate.mode] ?? 99;
    if (distance < bestDistance - 1e-9 || (Math.abs(distance - bestDistance) <= 1e-9 && priority < bestPriority)) {
      best = candidate;
      bestDistance = distance;
      bestPriority = priority;
    }
  };

  // 1) 単独候補(endpoint/midpoint/center/quadrant)
  for (const entity of nearEntities) {
    for (const candidate of candidatesForEntity(entity, active)) consider(candidate);
  }

  // 2) 交点(セグメントを持つ可視エンティティのペア)。対象ペアは事前限定しない
  //    (カーソル近傍の交点を確実に拾うため。交点を構成するセグメントは
  //    交点を通るため、全セグメント間の走査で厳密)。
  if (active.intersection) {
    const segOwners = [];
    for (const entity of nearEntities) {
      const segments = entitySegments(entity);
      for (const segment of segments) segOwners.push({ segment, owner: entity });
    }
    for (let i = 0; i < segOwners.length; i += 1) {
      for (let j = i + 1; j < segOwners.length; j += 1) {
        if (segOwners[i].owner === segOwners[j].owner) continue; // 同一entity内の自己交差は対象外
        const point = segmentIntersection(segOwners[i].segment, segOwners[j].segment);
        if (point) consider({ ...point, mode: "intersection" });
      }
    }
  }

  // 3) 垂線・近接点(カーソルから各セグメントへの足/最近点)
  for (const entity of nearEntities) {
    for (const segment of entitySegments(entity)) {
      if (active.perpendicular) {
        const foot = perpendicularFoot(worldPoint, segment.a, segment.b);
        if (foot) consider({ ...foot, mode: "perpendicular" });
      }
      if (active.nearest) {
        consider({ ...closestPointOnSegment(worldPoint, segment.a, segment.b), mode: "nearest" });
      }
    }
  }

  // 4) 接線: 直前の点から円・円弧へ引いた接線の接点(作図中の2点目以降のみ)
  if (active.tangent && fromPoint) {
    for (const entity of nearEntities) {
      for (const tangent of tangentPoints(fromPoint, entity)) consider({ ...tangent, mode: "tangent" });
    }
  }

  return best ? { x: best.x, y: best.y } : null;
}
