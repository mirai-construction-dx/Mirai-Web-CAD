import { arc, circle, ellipse, entityArea, line, polyline, rect, spline, text } from "./cad-core.js";
import { duplicateEntityIds, explodeEntity, lengthenEntity, matchProperties, reverseEntity, stretchEntity, unusedLayerIds } from "./cad-edit.js";
import { selectableEntities } from "./cad-selection.js";
import { quickSelect, selectByPath } from "./cad-selection-tools.js";
import {
  arrayEntity,
  blockEntity,
  breakEntity,
  chamferLines,
  createBoundaryEntity,
  dimensionEntity,
  editPolyline,
  extendEntityToBoundary,
  filletLines,
  hatchEntity,
  joinLines,
  measurePoints,
  mirrorEntity,
  offsetEntity,
  transformEntity,
  trimEntityToBoundaries
} from "./cad-advanced.js";

const TOOL_COMMANDS = {
  L: "line",
  LINE: "line",
  REC: "rect",
  RECT: "rect",
  RECTANGLE: "rect",
  C: "circle",
  CIRCLE: "circle",
  ARC: "arc",
  EL: "ellipse",
  ELLIPSE: "ellipse",
  SPL: "spline",
  SPLINE: "spline",
  PL: "polyline",
  PLINE: "polyline",
  POLYLINE: "polyline",
  T: "text",
  TEXT: "text"
};

// 連続点入力の先頭の@が基準にする「直前に入力した点」(AutoCADのLASTPOINT)と、
// 今回のコマンドで最後に解決した連続点。parseCadCommandは同期処理のため呼出し単位で閉じる。
/** @type {{ x: number, y: number } | null} */
let activeLastPoint = null;
/** @type {{ x: number, y: number } | null} */
let resolvedLastPoint = null;

export function parseCadCommand(input, context) {
  activeLastPoint = context?.lastPoint ?? null;
  resolvedLastPoint = null;
  const result = parseCommandTokens(input, context);
  // 連続点を解決したコマンドは、次のコマンドの先頭@の基準になる最終点を返す。
  if (resolvedLastPoint && result && typeof result === "object") return { ...result, lastPoint: resolvedLastPoint };
  return result;
}

function parseCommandTokens(input, context) {
  const tokens = tokenize(input.trim());
  if (tokens.length === 0) return { kind: "noop" };
  const command = tokens.shift().toUpperCase();
  const tool = TOOL_COMMANDS[command];

  if (tool && tokens.length === 0) return { kind: "ui", action: "tool", tool };
  if (tool === "line") {
    requireCount(tokens, 2, "LINE x1,y1 x2,y2");
    const [start, end] = pointSequence(tokens);
    return transaction("LINE", [{ op: "add", entity: line(context.currentLayerId, start, end) }]);
  }
  if (tool === "rect") {
    requireCount(tokens, 2, "RECT x1,y1 x2,y2");
    const [origin, opposite] = pointSequence(tokens);
    return transaction("RECT", [
      {
        op: "add",
        entity: rect(
          context.currentLayerId,
          [Math.min(origin.x, opposite.x), Math.min(origin.y, opposite.y)],
          Math.abs(opposite.x - origin.x),
          Math.abs(opposite.y - origin.y)
        )
      }
    ]);
  }
  if (tool === "circle") {
    requireCount(tokens, 2, "CIRCLE x,y radius");
    const radius = number(tokens[1], "radius");
    if (radius <= 0) throw new Error("半径は0より大きい値を指定してください。");
    return transaction("CIRCLE", [
      { op: "add", entity: circle(context.currentLayerId, point(tokens[0]), radius) }
    ]);
  }
  if (tool === "arc") {
    requireCount(tokens, 4, "ARC x,y radius startAngle endAngle");
    const radius = number(tokens[1], "radius");
    if (radius <= 0) throw new Error("半径は0より大きい値を指定してください。");
    const startAngle = number(tokens[2], "startAngle");
    const endAngle = number(tokens[3], "endAngle");
    if ((((endAngle - startAngle) % 360) + 360) % 360 === 0) throw new Error("円弧の開始角度と終了角度は異なる値を指定してください。");
    return transaction("ARC", [
      { op: "add", entity: arc(context.currentLayerId, point(tokens[0]), radius, startAngle, endAngle) }
    ]);
  }
  if (tool === "ellipse") {
    if (tokens.length < 3 || tokens.length > 4) throw new Error("形式: ELLIPSE x,y radiusX radiusY [rotation]");
    const radiusX = number(tokens[1], "radiusX");
    const radiusY = number(tokens[2], "radiusY");
    if (radiusX <= 0 || radiusY <= 0 || radiusY > radiusX) throw new Error("長半径は短半径以上の正の値を指定してください。");
    return transaction("ELLIPSE", [
      { op: "add", entity: ellipse(context.currentLayerId, point(tokens[0]), radiusX, radiusY, tokens[3] === undefined ? 0 : number(tokens[3], "rotation")) }
    ]);
  }
  if (tool === "spline") {
    if (tokens.length < 2) throw new Error("SPLINEには2点以上の制御点が必要です。");
    return transaction("SPLINE", [{ op: "add", entity: spline(context.currentLayerId, pointSequence(tokens)) }]);
  }
  if (tool === "polyline") {
    const closed = tokens.at(-1)?.toUpperCase() === "CLOSE";
    if (closed) tokens.pop();
    if (tokens.length < 2) throw new Error("PLINEには2点以上が必要です。");
    return transaction("PLINE", [
      { op: "add", entity: polyline(context.currentLayerId, pointSequence(tokens), { closed }) }
    ]);
  }
  if (tool === "text") {
    if (tokens.length < 2) throw new Error('TEXT x,y "文字" の形式で指定してください。');
    const at = point(tokens.shift());
    return transaction("TEXT", [
      { op: "add", entity: text(context.currentLayerId, at, tokens.join(" ")) }
    ]);
  }

  if (["E", "ERASE", "DELETE"].includes(command)) {
    const entities = selectedEntities(tokens, context);
    return transaction("ERASE", entities.map(({ id }) => ({ op: "delete", id })));
  }
  if (command === "LENGTHEN") {
    const length = number(tokens.shift(), "total length");
    return transaction(command, selectedEntities(tokens, context).map((entity) => ({ op: "update", id: entity.id, patch: withoutIdentity(lengthenEntity(entity, length)) })));
  }
  if (command === "REVERSE") return transaction(command, selectedEntities(tokens, context).map((entity) => ({ op: "update", id: entity.id, patch: withoutIdentity(reverseEntity(entity)) })));
  if (command === "PURGE") {
    requireCount(tokens, 0, "PURGE");
    const ids = unusedLayerIds(context.drawing, context.currentLayerId);
    return ids.length ? transaction(command, ids.map((id) => ({ op: "delete_layer", id }))) : { kind: "message", message: "未使用レイヤーはありません。" };
  }
  if (command === "OVERKILL") {
    const ids = duplicateEntityIds(context.drawing, selectedEntities(tokens, context));
    return ids.length ? transaction(command, ids.map((id) => ({ op: "delete", id }))) : { kind: "message", message: "削除可能な完全重複LINE/CIRCLEはありません。" };
  }
  if (["X", "EXPLODE"].includes(command)) {
    return transaction("EXPLODE", selectedEntities(tokens, context).flatMap((entity) => [
      { op: "delete", id: entity.id }, ...explodeEntity(entity).map((piece) => ({ op: "add", entity: piece }))
    ]));
  }
  if (["MA", "MATCHPROP"].includes(command)) {
    const sourceId = tokens.shift();
    const source = context.drawing.entities.find((entity) => entity.id === sourceId);
    if (!source) throw new Error("MATCHPROP sourceId [targetId ...]");
    return transaction("MATCHPROP", selectedEntities(tokens, context).filter((entity) => entity.id !== source.id).map((entity) => ({
      op: "update", id: entity.id, patch: withoutIdentity(matchProperties(source, entity))
    })));
  }
  if (command === "STRETCH") {
    if (tokens.length < 3) throw new Error("STRETCH x1,y1 x2,y2 dx,dy [id ...]");
    const [a, b] = pointSequence(tokens.splice(0, 2)), delta = point(tokens.shift());
    return transaction("STRETCH", selectedEntities(tokens, context).map((entity) => ({
      op: "update", id: entity.id, patch: withoutIdentity(stretchEntity(entity, a, b, delta))
    })));
  }
  if (["M", "MOVE"].includes(command)) return transformCommand("MOVE", tokens, context, false);
  if (["CO", "COPY"].includes(command)) return transformCommand("COPY", tokens, context, true);
  if (["RO", "ROTATE"].includes(command)) return rotateOrScaleCommand("ROTATE", tokens, context);
  if (["SC", "SCALE"].includes(command)) return rotateOrScaleCommand("SCALE", tokens, context);
  if (["O", "OFFSET"].includes(command)) return offsetCommand(tokens, context);
  if (["TR", "TRIM"].includes(command)) return endpointCommand("TRIM", tokens, context);
  if (["EX", "EXTEND"].includes(command)) return endpointCommand("EXTEND", tokens, context);
  if (["MI", "MIRROR"].includes(command)) return mirrorCommand(tokens, context);
  if (["AR", "ARRAY"].includes(command)) return arrayCommand(tokens, context);
  if (["BR", "BREAK"].includes(command)) return breakCommand(tokens, context);
  if (["JOIN", "J"].includes(command)) return joinCommand(tokens, context);
  if (["CHA", "CHAMFER"].includes(command)) return chamferCommand(tokens, context);
  if (["F", "FILLET"].includes(command)) return filletCommand(tokens, context);
  if (["BO", "BOUNDARY"].includes(command)) return boundaryCommand(tokens, context);
  if (["PE", "PEDIT"].includes(command)) return polylineEditCommand(tokens, context);
  if (["D", "DIM", "DIMLINEAR", "DIMALIGNED"].includes(command)) {
    if (tokens.length < 2 || tokens.length > 3) throw new Error("形式: DIM x1,y1 x2,y2 [offset]");
    const [start, end] = pointSequence(tokens.slice(0, 2));
    return transaction("DIM", [{ op: "add", entity: dimensionEntity(context.currentLayerId, start, end, { dimensionType: command === "DIMLINEAR" ? "horizontal" : "aligned", offset: tokens[2] === undefined ? 350 : number(tokens[2], "offset") }) }]);
  }
  if (["DIMASSOC", "DIMHORIZONTAL", "DIMVERTICAL", "DIMRADIUS", "DIMDIAMETER"].includes(command)) {
    const entity = context.drawing.entities.find((item) => item.id === (tokens[0] ?? context.selectedId));
    if (!entity || tokens.length > 2) throw new Error(`${command} [entityId] [offset]`);
    const radial = command === "DIMRADIUS" || command === "DIMDIAMETER";
    if (radial && !["circle", "arc"].includes(entity.type)) throw new Error("半径・直径寸法は円/円弧を選択してください。");
    if (!radial && entity.type !== "line") throw new Error("連想2点寸法は線分を選択してください。");
    const dimensionType = { DIMASSOC: "aligned", DIMHORIZONTAL: "horizontal", DIMVERTICAL: "vertical", DIMRADIUS: "radius", DIMDIAMETER: "diameter" }[command];
    const points = radial ? [entity.center, { x: entity.center.x + entity.radius, y: entity.center.y }] : entity.points;
    const references = radial ? [{ entityId: entity.id, kind: "center" }, { entityId: entity.id, kind: "radius", angle: 0 }] : [0, 1].map((index) => ({ entityId: entity.id, kind: "point", index }));
    return transaction(command, [{ op: "add", entity: dimensionEntity(context.currentLayerId, points[0], points[1], { dimensionType, references, offset: tokens[1] === undefined ? 350 : number(tokens[1], "offset") }) }]);
  }
  if (command === "DIMSTYLE") {
    if (tokens.length < 3 || tokens.length > 5) throw new Error("DIMSTYLE precision textSize arrowSize [prefix] [suffix]");
    const targets = selectedEntities([], context);
    if (targets.some((entity) => entity.type !== "dimension")) throw new Error("寸法を選択してください。");
    return transaction(command, targets.map((entity) => ({ op: "update", id: entity.id, patch: { precision: number(tokens[0], "precision"), textSize: number(tokens[1], "textSize"), arrowSize: number(tokens[2], "arrowSize"), prefix: tokens[3] ?? "", suffix: tokens[4] ?? "" } })));
  }
  if (["DI", "DIST"].includes(command)) {
    requireCount(tokens, 2, "DIST x1,y1 x2,y2");
    const result = measurePoints(...pointSequence(tokens));
    return { kind: "message", message: `距離=${format(result.distance)} ΔX=${format(result.dx)} ΔY=${format(result.dy)} 角度=${format(result.angle)}°` };
  }
  if (["AREA", "AA"].includes(command)) {
    const entity = selectedEntity(tokens, context, "AREA");
    return { kind: "message", message: `面積=${format(entityArea(entity))} ${context.drawing.unit}²` };
  }
  if (["ID", "COORD"].includes(command)) {
    requireCount(tokens, 1, "ID x,y");
    const value = point(tokens[0]);
    return { kind: "message", message: `X=${format(value.x)} Y=${format(value.y)}` };
  }
  if (["H", "HATCH"].includes(command)) {
    if (tokens.length < 3) throw new Error("HATCHには3点以上の境界座標が必要です。");
    return transaction("HATCH", [{ op: "add", entity: hatchEntity(context.currentLayerId, pointSequence(tokens)) }]);
  }
  if (["B", "BLOCK"].includes(command)) {
    if (!tokens[0]) throw new Error("形式: BLOCK name [id]");
    const name = tokens.shift();
    const entity = selectedEntity(tokens, context, "BLOCK");
    const child = transformEntity(entity, { dx: 0, dy: 0 });
    child.id = `child_${randomId()}`;
    return transaction("BLOCK", [{ op: "delete", id: entity.id }, { op: "add", entity: blockEntity(entity.layerId, name, [0, 0], [child]) }]);
  }
  if (["LA", "LAYER"].includes(command)) {
    if (tokens.length === 0) {
      return { kind: "message", message: context.drawing.layers.map((layer) => layer.name).join(" / ") };
    }
    if (tokens[0]?.toUpperCase() === "NEW") {
      if (!tokens[1]) throw new Error("形式: LAYER NEW name [#color]");
      const color = tokens[2] ?? "#5b6b7a";
      return transaction("LAYER NEW", [{ op: "add_layer", layer: { id: `layer_${randomId()}`, name: tokens[1], color } }]);
    }
    if (tokens[0]?.toUpperCase() === "EDIT") {
      if (tokens.length < 3) throw new Error("形式: LAYER EDIT id name [#color]");
      return transaction("LAYER EDIT", [{ op: "update_layer", id: tokens[1], patch: { name: tokens[2], color: tokens[3] } }]);
    }
    const query = tokens.join(" ").toLowerCase();
    const layer = context.drawing.layers.find(
      (item) => item.id.toLowerCase() === query || item.name.toLowerCase() === query
    );
    if (!layer) throw new Error(`レイヤーが見つかりません: ${tokens.join(" ")}`);
    return { kind: "ui", action: "layer", layerId: layer.id };
  }
  if (["Z", "ZOOM"].includes(command)) {
    const option = (tokens[0] ?? "EXTENTS").toUpperCase();
    // 誤入力で表示を変えないよう、E/Pに余分な引数があれば拒否する。
    if (["E", "EXTENTS", "ALL", "A"].includes(option)) {
      if (tokens.length > 1) throw new Error("形式: ZOOM E");
      return { kind: "ui", action: "fit" };
    }
    if (["P", "PREVIOUS"].includes(option)) {
      if (tokens.length > 1) throw new Error("形式: ZOOM P");
      return { kind: "ui", action: "zoomPrevious" };
    }
    if (["W", "WINDOW"].includes(option)) {
      // 2点を省略した場合はCanvas上の2回クリックで範囲を指定する。
      if (tokens.length === 1) return { kind: "ui", action: "tool", tool: "zoomwindow" };
      if (tokens.length !== 3) throw new Error("形式: ZOOM W [x1,y1 x2,y2]");
      return { kind: "ui", action: "zoomWindow", corners: [point(tokens[1]), point(tokens[2])] };
    }
    // AutoCADと同様、ZOOMに続けて2点を与えた場合も窓ズームとして扱う。
    if (tokens.length === 2 && isCoordinate(tokens[0]) && isCoordinate(tokens[1])) {
      return { kind: "ui", action: "zoomWindow", corners: [point(tokens[0]), point(tokens[1])] };
    }
    const factorMatch = /^(\d+(?:\.\d+)?|\.\d+)X$/i.exec(tokens[0] ?? "");
    if (factorMatch && tokens.length === 1) {
      const factor = Number(factorMatch[1]);
      if (!Number.isFinite(factor) || !(factor > 0)) throw new Error("ZOOMの倍率は0より大きい有限の値を 2X のように指定してください。");
      return { kind: "ui", action: "zoomFactor", factor };
    }
    throw new Error("ZOOMは E(全体) / W(窓) / P(前画面) / 倍率(例: 2X, 0.5X) に対応しています。");
  }
  if (["P", "PAN"].includes(command)) {
    requireCount(tokens, 1, "PAN dx,dy");
    return { kind: "ui", action: "pan", offset: point(tokens[0]) };
  }
  if (["PLOT", "PRINT"].includes(command)) return { kind: "ui", action: "plot" };
  if (["S", "SELECT"].includes(command)) {
    const mode = tokens[0]?.toUpperCase();
    if (mode === "PREVIOUS") return { kind: "ui", action: "selectMany", entityIds: context.previousSelection ?? [] };
    if (mode === "LAST") return { kind: "ui", action: "selectMany", entityIds: selectableEntities(context.drawing).slice(-1).map((entity) => entity.id) };
    if (tokens[0]?.toUpperCase() === "ALL") return { kind: "ui", action: "selectMany", entityIds: selectableEntities(context.drawing).map((entity) => entity.id) };
    if (!tokens[0]) throw new Error("SELECTには図形IDが必要です。");
    if (!context.drawing.entities.some((entity) => entity.id === tokens[0])) {
      throw new Error(`図形が見つかりません: ${tokens[0]}`);
    }
    return { kind: "ui", action: "select", entityId: tokens[0] };
  }
  if (["FENCE", "LASSO"].includes(command)) {
    if (!tokens.length) return { kind: "ui", action: "tool", tool: command.toLowerCase() };
    return { kind: "ui", action: "selectMany", entityIds: selectByPath(context.drawing, pointSequence(tokens), command.toLowerCase()) };
  }
  if (command === "SELECTSIMILAR") {
    const source = selectedEntities(tokens, context)[0];
    return { kind: "ui", action: "selectMany", entityIds: quickSelect(context.drawing, { type: source.type, layer: source.layerId }) };
  }
  if (command === "QSELECT") {
    if (tokens.length % 2) throw new Error("QSELECT type line layer layerId color #rrggbb width 2");
    const filters = Object.fromEntries(Array.from({ length: tokens.length / 2 }, (_, i) => [tokens[i * 2].toLowerCase(), tokens[i * 2 + 1]]));
    return { kind: "ui", action: "selectMany", entityIds: quickSelect(context.drawing, filters) };
  }
  if (command === "SELECTION") {
    const action = tokens.shift()?.toUpperCase();
    requireCount(tokens, 1, "SELECTION SAVE/LOAD/DELETE name");
    const name = tokens[0];
    if (action === "SAVE") return transaction("SELECTION SAVE", [{ op: "save_selection", name, entityIds: selectedEntities([], context).map((entity) => entity.id) }]);
    if (action === "DELETE") return transaction("SELECTION DELETE", [{ op: "delete_selection", name }]);
    if (action === "LOAD") {
      const set = context.drawing.selectionSets?.find((item) => item.name === name);
      if (!set) throw new Error(`選択セットがありません: ${name}`);
      const visible = new Set(selectableEntities(context.drawing).map((entity) => entity.id));
      return { kind: "ui", action: "selectMany", entityIds: set.entityIds.filter((id) => visible.has(id)) };
    }
    throw new Error("SELECTION SAVE/LOAD/DELETE name");
  }
  if (command === "NEW") return { kind: "ui", action: "new", name: tokens.join(" ") };
  if (command === "IMPORT") return { kind: "ui", action: "import" };
  if (["U", "UNDO"].includes(command)) return { kind: "ui", action: "undo" };
  if (["REDO"].includes(command)) return { kind: "ui", action: "redo" };
  if (["ESC", "CANCEL"].includes(command)) return { kind: "ui", action: "cancel" };
  if (["HELP", "?"].includes(command)) {
    return {
      kind: "message",
      message: "LINE RECT CIRCLE ARC ELLIPSE SPLINE PLINE TEXT DIM DIMASSOC DIMSTYLE HATCH ERASE MOVE COPY ROTATE SCALE OFFSET TRIM EXTEND MIRROR ARRAY BREAK JOIN CHAMFER FILLET BOUNDARY PEDIT STRETCH EXPLODE MATCHPROP LENGTHEN REVERSE PURGE OVERKILL SELECT FENCE LASSO QSELECT SELECTSIMILAR SELECTION DIST AREA ID BLOCK LAYER PAN ZOOM(E/W/P/nX) PLOT UNDO REDO / 座標: x,y 距離<角度 @dx,dy @距離<角度(先頭の@は直前に入力した点が基準) / 作図中は数値だけで距離の直接入力 / F3 OSnap F7 グリッド F8 直交 F9 スナップ"
    };
  }
  throw new Error(`未対応のコマンドです: ${command}`);
}

function selectedEntities(tokens, context) {
  const ids = tokens.length ? tokens : context.selectedIds?.length ? context.selectedIds : [context.selectedId].filter(Boolean);
  if (!ids.length) throw new Error("図形を選択するかIDを指定してください。");
  return [...new Set(ids)].map((id) => {
    const entity = context.drawing.entities.find((item) => item.id === id);
    if (!entity) throw new Error(`図形が見つかりません: ${id}`);
    return entity;
  });
}

function transformCommand(label, tokens, context, copy) {
  const ids = tokens[0] && !isCoordinate(tokens[0]) ? [tokens.shift()] : [];
  const entities = selectedEntities(ids, context);
  requireCount(tokens, 1, `${label} [id] dx,dy`);
  const offset = point(tokens[0]);
  const commands = entities.map((entity) => {
    if (!copy) return { op: "update", id: entity.id, patch: movedPatch(entity, offset.x, offset.y) };
    const next = movedEntity(entity, offset.x, offset.y);
    next.id = `e_copy_${randomId()}`;
    delete next.dxfRecordId;
    next.meta = { createdBy: "user", createdAt: new Date().toISOString() };
    return { op: "add", entity: next };
  });
  if (copy) {
    const mapping = new Map(entities.map((entity, index) => [entity.id, commands[index].entity.id]));
    for (const command of commands) {
      if (command.entity.references) command.entity.references = command.entity.references.map((reference) => ({ ...reference, entityId: mapping.get(reference.entityId) ?? reference.entityId }));
    }
  }
  return transaction(label, commands);
}

function rotateOrScaleCommand(label, tokens, context) {
  const ids = tokens[0] && !looksNumeric(tokens[0]) ? [tokens.shift()] : [];
  const entities = selectedEntities(ids, context);
  if (tokens.length < 1 || tokens.length > 2) throw new Error(`形式: ${label} [id] value [baseX,baseY]`);
  const value = number(tokens[0], label === "ROTATE" ? "angle" : "scale");
  if (label === "SCALE" && value <= 0) throw new Error("尺度は0より大きい値を指定してください。");
  const base = tokens[1] ? point(tokens[1]) : entityReferencePoint(entities[0]);
  return transaction(label, entities.map((entity) => {
    const next = transformEntity(entity, label === "ROTATE" ? { angle: value, base } : { scale: value, base });
    return { op: "update", id: entity.id, patch: withoutIdentity(next) };
  }));
}

function offsetCommand(tokens, context) {
  let id = context.selectedId;
  if (tokens[0] && !looksNumeric(tokens[0])) id = tokens.shift();
  const entity = context.drawing.entities.find((item) => item.id === id);
  if (!entity) throw new Error("OFFSETする図形を選択するかIDを指定してください。");
  requireCount(tokens, 1, "OFFSET [id] distance");
  const next = offsetEntity(entity, number(tokens[0], "distance"));
  next.id = `e_offset_${randomId()}`;
  next.meta = { createdBy: "user", createdAt: new Date().toISOString() };
  return transaction("OFFSET", [{ op: "add", entity: next }]);
}

function endpointCommand(label, tokens, context) {
  let id = context.selectedId;
  if (tokens[0] && !isCoordinate(tokens[0])) id = tokens.shift();
  const entity = context.drawing.entities.find((item) => item.id === id);
  if (!entity) throw new Error(`${label}する線分を選択するかIDを指定してください。`);
  requireCount(tokens, 1, `${label} [id] x,y (クリック点)`);
  const clickPoint = point(tokens[0]);
  // 境界は選択図形以外の図面内エンティティ(正確なTRIM/EXTENDの境界交点演算)
  const boundaries = context.drawing.entities.filter((item) => item.id !== id);
  const next = label === "TRIM" ? trimEntityToBoundaries(entity, boundaries, clickPoint) : extendEntityToBoundary(entity, boundaries, clickPoint);
  return transaction(label, [{ op: "update", id: entity.id, patch: { points: next.points } }]);
}

function mirrorCommand(tokens, context) {
  let id = context.selectedId;
  if (tokens[0] && !isCoordinate(tokens[0])) id = tokens.shift();
  const entity = context.drawing.entities.find((item) => item.id === id);
  if (!entity) throw new Error("MIRRORする図形を選択するかIDを指定してください。");
  requireCount(tokens, 2, "MIRROR [id] x1,y1 x2,y2 (鏡像軸の2点)");
  const [axisStart, axisEnd] = pointSequence(tokens);
  const next = mirrorEntity(entity, axisStart, axisEnd);
  // rect→polyline等、型が変わる変換はdelete+addで置換する(updateでは整合しない)
  const commands =
    next.type === entity.type
      ? [{ op: "update", id: entity.id, patch: withoutIdentity(next) }]
      : [{ op: "delete", id: entity.id }, { op: "add", entity: next }];
  return transaction("MIRROR", commands);
}

function arrayCommand(tokens, context) {
  let id = context.selectedId;
  if (tokens[0] && !isCoordinate(tokens[0]) && !/^\d+$/.test(tokens[0] ?? "")) id = tokens.shift();
  const entity = context.drawing.entities.find((item) => item.id === id);
  if (!entity) throw new Error("ARRAYする図形を選択するかIDを指定してください。");
  requireCount(tokens, 4, "ARRAY [id] 列数 行数 列間隔 行間隔");
  const copies = arrayEntity(entity, number(tokens[0], "列数"), number(tokens[1], "行数"), number(tokens[2], "列間隔"), number(tokens[3], "行間隔"));
  return transaction("ARRAY", copies.map((copy) => ({ op: "add", entity: copy })));
}

function breakCommand(tokens, context) {
  let id = context.selectedId;
  if (tokens[0] && !isCoordinate(tokens[0])) id = tokens.shift();
  const entity = context.drawing.entities.find((item) => item.id === id);
  if (!entity) throw new Error("BREAKする図形を選択するかIDを指定してください。");
  requireCount(tokens, 1, "BREAK [id] x,y");
  const pieces = breakEntity(entity, point(tokens[0]));
  const commands = [{ op: "delete", id: entity.id }, ...pieces.map((piece) => ({ op: "add", entity: piece }))];
  return transaction("BREAK", commands);
}

function joinCommand(tokens, context) {
  // 2ID明示指定(JOIN idA idB)を最優先。次に「選択図形+ID(JOIN idB)」。
  let firstId;
  let secondId;
  if (tokens.length > 2) throw new Error("形式: JOIN [firstId] secondId(引数が多すぎます)");
  if (tokens.length === 2) {
    [firstId, secondId] = tokens;
  } else if (tokens.length === 1) {
    firstId = context.selectedId;
    secondId = tokens[0];
  } else {
    throw new Error("形式: JOIN [firstId] secondId(または図形を選択して JOIN secondId)");
  }
  if (!firstId || !secondId) throw new Error("形式: JOIN [firstId] secondId(または図形を選択して JOIN secondId)");
  const first = context.drawing.entities.find((item) => item.id === firstId);
  const second = context.drawing.entities.find((item) => item.id === secondId);
  if (!first || !second) throw new Error("JOIN対象の線分が見つかりません。");
  const joined = joinLines(first, second);
  if (!joined) throw new Error("端点が一致し同一線上にある2線分のみ結合できます。");
  const commands = [{ op: "delete", id: firstId }, { op: "delete", id: secondId }, { op: "add", entity: joined }];
  return transaction("JOIN", commands);
}

function chamferCommand(tokens, context) {
  const { first, second, rest } = twoLineSelection(tokens, context, "CHAMFER");
  if (rest.length < 1 || rest.length > 2) throw new Error("形式: CHAMFER [firstId] secondId distance1 [distance2]");
  const result = chamferLines(first, second, number(rest[0], "distance1"), rest[1] === undefined ? undefined : number(rest[1], "distance2"));
  return transaction("CHAMFER", [
    { op: "update", id: first.id, patch: { points: result.first.points } },
    { op: "update", id: second.id, patch: { points: result.second.points } },
    { op: "add", entity: result.connector }
  ]);
}

function filletCommand(tokens, context) {
  const { first, second, rest } = twoLineSelection(tokens, context, "FILLET");
  requireCount(rest, 1, "FILLET [firstId] secondId radius");
  const result = filletLines(first, second, number(rest[0], "radius"));
  return transaction("FILLET", [
    { op: "update", id: first.id, patch: { points: result.first.points } },
    { op: "update", id: second.id, patch: { points: result.second.points } },
    { op: "add", entity: result.arc }
  ]);
}

function boundaryCommand(tokens, context) {
  const ids = [...tokens];
  if (ids.length < 3) throw new Error("形式: BOUNDARY id1 id2 id3 [id4 ...]（接続された線分）");
  const entities = ids.map((id) => {
    const entity = context.drawing.entities.find((item) => item.id === id);
    if (!entity) throw new Error(`境界要素が見つかりません: ${id}`);
    return entity;
  });
  const boundary = createBoundaryEntity(context.currentLayerId, entities);
  return transaction("BOUNDARY", [{ op: "add", entity: boundary }]);
}

function polylineEditCommand(tokens, context) {
  let id = context.selectedId;
  if (tokens[0] && context.drawing.entities.some((entity) => entity.id === tokens[0])) id = tokens.shift();
  const entity = context.drawing.entities.find((item) => item.id === id);
  if (!entity) throw new Error("PEDITするポリラインを選択するかIDを指定してください。");
  const action = String(tokens.shift() ?? "").toUpperCase();
  let next;
  if (["CLOSE", "OPEN"].includes(action)) {
    requireCount(tokens, 0, `PEDIT [id] ${action}`);
    next = editPolyline(entity, action);
  } else if (action === "DELETE") {
    requireCount(tokens, 1, "PEDIT [id] DELETE vertexNumber");
    next = editPolyline(entity, action, vertexNumber(tokens[0]));
  } else if (["MOVE", "ADD"].includes(action)) {
    requireCount(tokens, 2, `PEDIT [id] ${action} vertexNumber x,y`);
    next = editPolyline(entity, action, vertexNumber(tokens[0]), point(tokens[1]));
  } else {
    throw new Error("形式: PEDIT [id] MOVE|ADD|DELETE vertexNumber [x,y] / CLOSE / OPEN");
  }
  return transaction("PEDIT", [{ op: "update", id: entity.id, patch: withoutIdentity(next) }]);
}

function twoLineSelection(tokens, context, label) {
  const values = [...tokens];
  let firstId = context.selectedId;
  let secondId;
  const firstTokenIsId = context.drawing.entities.some((entity) => entity.id === values[0]);
  const secondTokenIsId = context.drawing.entities.some((entity) => entity.id === values[1]);
  if (firstTokenIsId && secondTokenIsId) {
    firstId = values.shift();
    secondId = values.shift();
  } else if (firstId && firstTokenIsId) {
    secondId = values.shift();
  }
  if (!firstId || !secondId) throw new Error(`形式: ${label} [firstId] secondId value（または第1線分を選択）`);
  const first = context.drawing.entities.find((entity) => entity.id === firstId);
  const second = context.drawing.entities.find((entity) => entity.id === secondId);
  if (!first || !second) throw new Error(`${label}対象の線分が見つかりません。`);
  return { first, second, rest: values };
}

function vertexNumber(value) {
  const parsed = number(value, "vertexNumber");
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error("頂点番号は1以上の整数で指定してください。");
  return parsed - 1;
}

function selectedEntity(tokens, context, label) {
  const id = tokens[0] ?? context.selectedId;
  const entity = context.drawing.entities.find((item) => item.id === id);
  if (!entity) throw new Error(`${label}対象を選択するかIDを指定してください。`);
  return entity;
}

function entityReferencePoint(entity) {
  return entity.center ?? entity.origin ?? entity.at ?? entity.insertion ?? entity.points?.[0] ?? { x: 0, y: 0 };
}

function withoutIdentity(entity) {
  const { id, ...patch } = entity;
  return patch;
}

function looksNumeric(value) {
  return value !== "" && Number.isFinite(Number(value));
}

function format(value) {
  return Math.round(value * 1000) / 1000;
}

function movedEntity(entity, dx, dy) {
  return { ...structuredClone(entity), ...movedPatch(entity, dx, dy) };
}

function movedPatch(entity, dx, dy) {
  return withoutIdentity(transformEntity(entity, { dx, dy }));
}

function transaction(label, commands) {
  return { kind: "transaction", label, commands };
}

// 絶対座標 x,y / 絶対極座標 distance<angle。角度は度、+X軸から反時計回り(ARC/DISTと同じ規約)。
function point(value) {
  const text = String(value);
  if (text.startsWith("@")) throw new Error(`相対座標(@)は2点目以降の連続点入力でのみ指定できます: ${value}`);
  return resolvePoint(text, { x: 0, y: 0 });
}

// 連続点入力。@dx,dy / @distance<angle は同じコマンド内の直前点を基準に解決する。
// 先頭点の@は、直前のコマンドまたはCanvasで最後に入力した点(LASTPOINT)を基準にする。
function pointSequence(tokens) {
  const points = [];
  for (const token of tokens) {
    const text = String(token);
    if (!text.startsWith("@")) {
      points.push(point(text));
      continue;
    }
    const previous = points.at(-1) ?? activeLastPoint;
    if (!previous) throw new Error(`先頭の点の相対座標(@)の基準になる直前の点(LASTPOINT)がありません: ${text}`);
    points.push(resolvePoint(text.slice(1), previous, true));
  }
  if (points.length > 0) resolvedLastPoint = points.at(-1);
  return points;
}

function resolvePoint(text, base, relative = false) {
  if (text.includes("<")) {
    const parts = text.split("<");
    if (parts.length !== 2) throw new Error(`極座標は距離<角度形式で指定してください: ${text}`);
    const distance = number(parts[0], "distance");
    // 巨大な角度でもラジアン変換が溢れないよう先に1周へ正規化する
    const radians = ((number(parts[1], "angle") % 360) * Math.PI) / 180;
    return finitePoint({ x: roundCoordinate(base.x + distance * Math.cos(radians)), y: roundCoordinate(base.y + distance * Math.sin(radians)) }, text);
  }
  const parts = text.split(",");
  if (parts.length !== 2) throw new Error(`座標はx,y、@dx,dy、距離<角度、@距離<角度のいずれかで指定してください: ${text}`);
  const x = number(parts[0], "x");
  const y = number(parts[1], "y");
  return relative ? finitePoint({ x: base.x + x, y: base.y + y }, text) : { x, y };
}

function finitePoint(value, text) {
  if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) throw new Error(`座標が有効な数値範囲を超えています: ${text}`);
  return value;
}

// 極座標の三角関数誤差(例: cos 90° = 6e-17)を座標値へ残さない。
function roundCoordinate(value) {
  const scaled = value * 1e9;
  // 1e9倍で溢れる巨大値は丸め不要(誤差は相対的に無視できる)なのでそのまま返す
  return Number.isFinite(scaled) ? Math.round(scaled) / 1e9 : value;
}

function isCoordinate(value) {
  return /[,<]/.test(value);
}

function number(value, label) {
  if (String(value).trim() === "") throw new Error(`${label}が空です。`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label}が数値ではありません: ${value}`);
  return parsed;
}

function requireCount(tokens, count, usage) {
  if (tokens.length !== count) throw new Error(`形式: ${usage}`);
}

function tokenize(value) {
  const tokens = [];
  const matcher = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = matcher.exec(value))) tokens.push(match[1] ?? match[2] ?? match[3]);
  return tokens;
}

function randomId() {
  return globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(16).slice(2, 10);
}
