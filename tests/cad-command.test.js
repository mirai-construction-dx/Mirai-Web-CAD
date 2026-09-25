import test from "node:test";
import assert from "node:assert/strict";
import { parseCadCommand } from "../src/cad-command.js";
import { applyTransaction, line, seedDrawing } from "../src/cad-core.js";

function context(overrides = {}) {
  const drawing = seedDrawing();
  return { drawing, currentLayerId: "layer-structure", selectedId: null, ...overrides };
}

test("command line creates line, rectangle, circle, arc, ellipse, spline, polyline, and text transactions", () => {
  const cases = [
    ["LINE 0,0 100,200", "line"],
    ["RECT 10,20 110,220", "rect"],
    ["CIRCLE 50,60 25", "circle"],
    ["ARC 50,60 25 350 20", "arc"],
    ["ELLIPSE 50,60 40 20 30", "ellipse"],
    ["SPLINE 0,0 50,100 100,0", "spline"],
    ["PLINE 0,0 100,0 100,100 CLOSE", "polyline"],
    ['TEXT 30,40 "施工 注記"', "text"]
  ];
  for (const [input, type] of cases) {
    const parsed = parseCadCommand(input, context());
    assert.equal(parsed.kind, "transaction");
    assert.equal(parsed.commands[0].entity.type, type);
  }
});

test("command line move and copy selected geometry through CAD transactions", () => {
  const drawing = seedDrawing();
  const selectedId = drawing.entities.find((entity) => entity.type === "rect").id;
  const move = parseCadCommand("MOVE 100,50", context({ drawing, selectedId }));
  const moved = applyTransaction(drawing, { source: "user", label: move.label, commands: move.commands });
  assert.equal(moved.ok, true);
  assert.equal(moved.drawing.entities.find((entity) => entity.id === selectedId).origin.x, 2300);

  const copy = parseCadCommand(`COPY ${selectedId} -100,25`, context({ drawing }));
  const copied = applyTransaction(drawing, { source: "user", label: copy.label, commands: copy.commands });
  assert.equal(copied.ok, true);
  assert.equal(copied.drawing.entities.length, drawing.entities.length + 1);
});

test("command line supports UI commands and rejects malformed input", () => {
  assert.deepEqual(parseCadCommand("ZOOM EXTENTS", context()), { kind: "ui", action: "fit" });
  assert.deepEqual(parseCadCommand("UNDO", context()), { kind: "ui", action: "undo" });
  assert.deepEqual(parseCadCommand("REDO", context()), { kind: "ui", action: "redo" });
  assert.equal(parseCadCommand("LAYER 構造物", context()).layerId, "layer-structure");
  assert.equal(parseCadCommand("NEW 仮設計画図", context()).name, "仮設計画図");
  assert.throws(() => parseCadCommand("LINE 0,0 100,", context()), /yが空/);
  assert.throws(() => parseCadCommand("CIRCLE 0,0 -1", context()), /半径/);
  assert.throws(() => parseCadCommand("ARC 0,0 10 90 90", context()), /開始角度/);
  assert.throws(() => parseCadCommand("ELLIPSE 0,0 10 20", context()), /長半径/);
  assert.throws(() => parseCadCommand("SPLINE 0,0", context()), /2点以上/);
  assert.throws(() => parseCadCommand("UNKNOWN", context()), /未対応/);
});

test("advanced commands create and transform production CAD geometry", () => {
  const drawing = seedDrawing();
  const selectedId = drawing.entities.find((entity) => entity.type === "line").id;
  const selectedContext = context({ drawing, selectedId });
  for (const input of ["ROTATE 45", "SCALE 2", "OFFSET 100"]) {
    assert.equal(parseCadCommand(input, selectedContext).kind, "transaction");
  }
  assert.equal(parseCadCommand("DIM 0,0 300,400", selectedContext).commands[0].entity.type, "dimension");
  assert.equal(parseCadCommand("HATCH 0,0 100,0 100,100", selectedContext).commands[0].entity.type, "hatch");
  assert.match(parseCadCommand("DIST 0,0 300,400", selectedContext).message, /距離=500/);
  assert.match(parseCadCommand("AREA e_box_1", selectedContext).message, /面積=/);
  assert.deepEqual(parseCadCommand("PAN 100,50", selectedContext), { kind: "ui", action: "pan", offset: { x: 100, y: 50 } });
  assert.deepEqual(parseCadCommand("PLOT", selectedContext), { kind: "ui", action: "plot" });
});

test("precision edit commands mirror, array, break and join geometry", () => {
  // 専用の作業線を用意してから精密編集コマンドを検証する(デモ図面の線は分割位置が不明確なため)
  const seed = seedDrawing();
  const source = line("layer-structure", [0, 0], [1000, 0]);
  const created = applyTransaction(seed, {
    source: "user",
    label: "test line",
    commands: [{ op: "add", entity: source }]
  });
  assert.equal(created.ok, true);
  const drawing = created.drawing;
  const lineId = drawing.entities.find((entity) => entity.type === "line" && entity.points[0].x === 0 && entity.points[0].y === 0 && entity.points[1].x === 1000).id;
  const ctx = context({ drawing, selectedId: lineId });

  // MIRROR: y軸(x=0)で反転 → 点列が負側へ置換される
  const mirror = parseCadCommand("MIRROR 0,0 0,100", ctx);
  assert.equal(mirror.kind, "transaction");
  const mirrored = applyTransaction(drawing, { source: "user", label: mirror.label, commands: mirror.commands });
  assert.equal(mirrored.ok, true);
  const afterMirror = mirrored.drawing.entities.find((entity) => entity.id === lineId);
  assert.deepEqual(afterMirror.points, [{ x: 0, y: 0 }, { x: -1000, y: 0 }]);

  // ARRAY: 反転済みの線分を2×2(列間隔2000,行間隔1000)で複写 → 3件追加
  // (鏡像後のdrawingへ適用し、コピーの座標が鏡像済み線分から複写されることを確認)
  const array = parseCadCommand("ARRAY 2 2 2000 1000", context({ drawing: mirrored.drawing, selectedId: lineId }));
  const arrayed = applyTransaction(mirrored.drawing, { source: "user", label: array.label, commands: array.commands });
  assert.equal(arrayed.ok, true);
  assert.equal(arrayed.drawing.entities.length, mirrored.drawing.entities.length + 3, "2×2-1=3件の複写");
  const copies = arrayed.drawing.entities.filter((entity) => entity.id.startsWith("e_array_") && entity.points[0].y === 0);
  const copyStarts = copies.map((copy) => copy.points[0].x).sort((a, b) => a - b);
  assert.deepEqual(copyStarts, [2000], "鏡像済み(-1000,0)起点の線の列複写は(2000,0)(元位置はスキップ)");

  // JOINが余分な引数を拒否する
  assert.throws(() => parseCadCommand("JOIN e1 e2 unexpected", context({ drawing: arrayed.drawing })), /引数が多すぎます/);

  // BREAK: 別の作業線を用意し(0,0)-(1000,0)を(500,0)で2分割
  const line2 = line("layer-structure", [0, 2000], [1000, 2000]);
  const withLine2 = applyTransaction(arrayed.drawing, {
    source: "user",
    label: "test line2",
    commands: [{ op: "add", entity: line2 }]
  });
  assert.equal(withLine2.ok, true);
  const line2Id = withLine2.drawing.entities.find((entity) => entity.type === "line" && entity.points[0].y === 2000).id;
  const breakCmd = parseCadCommand("BREAK 500,2000", context({ drawing: withLine2.drawing, selectedId: line2Id }));
  assert.equal(breakCmd.commands[0].op, "delete");
  assert.equal(breakCmd.commands.filter((command) => command.op === "add").length, 2);
  const broken = applyTransaction(withLine2.drawing, { source: "user", label: breakCmd.label, commands: breakCmd.commands });
  assert.equal(broken.ok, true);

  // JOIN: 分割された2線分(同一線上・端点一致)を再結合する
  const pieces = broken.drawing.entities.filter((entity) => entity.type === "line" && entity.points[0].y === 2000);
  assert.equal(pieces.length, 2);
  const joinCmd = parseCadCommand(`JOIN ${pieces[0].id} ${pieces[1].id}`, context({ drawing: broken.drawing }));
  const joined = applyTransaction(broken.drawing, { source: "user", label: joinCmd.label, commands: joinCmd.commands });
  assert.equal(joined.ok, true);
  const joinedPieces = joined.drawing.entities.filter((entity) => entity.type === "line" && entity.points[0].y === 2000);
  assert.equal(joinedPieces.length, 1, "2線分が1本へ結合される");
  assert.deepEqual(joinedPieces[0].points, [{ x: 0, y: 2000 }, { x: 1000, y: 2000 }]);
});

test("command line supports chamfer, fillet, boundary, and polyline vertex editing", () => {
  const seed = seedDrawing();
  const horizontal = line("layer-structure", [0, 0], [100, 0], { id: "e_horizontal" });
  const vertical = line("layer-structure", [0, 0], [0, 100], { id: "e_vertical" });
  const top = line("layer-structure", [0, 100], [100, 100], { id: "e_top" });
  const right = line("layer-structure", [100, 100], [100, 0], { id: "e_right" });
  const created = applyTransaction(seed, {
    source: "user",
    label: "precision fixtures",
    commands: [horizontal, vertical, top, right].map((entity) => ({ op: "add", entity }))
  });
  assert.equal(created.ok, true);
  const drawing = created.drawing;

  const chamfer = parseCadCommand("CHAMFER e_vertical 10 20", context({ drawing, selectedId: "e_horizontal" }));
  assert.equal(chamfer.kind, "transaction");
  assert.equal(chamfer.commands.length, 3);
  assert.equal(chamfer.commands[2].entity.type, "line");

  const fillet = parseCadCommand("FILLET e_horizontal e_vertical 15", context({ drawing }));
  assert.equal(fillet.kind, "transaction");
  assert.equal(fillet.commands[2].entity.type, "arc");
  assert.equal(fillet.commands[2].entity.radius, 15);

  const boundary = parseCadCommand("BOUNDARY e_horizontal e_vertical e_top e_right", context({ drawing }));
  assert.equal(boundary.commands[0].entity.type, "polyline");
  assert.equal(boundary.commands[0].entity.closed, true);

  const boundaryDrawing = applyTransaction(drawing, { source: "user", label: boundary.label, commands: boundary.commands }).drawing;
  const boundaryId = boundaryDrawing.entities.at(-1).id;
  const pedit = parseCadCommand(`PEDIT ${boundaryId} MOVE 2 120,0`, context({ drawing: boundaryDrawing }));
  assert.deepEqual(pedit.commands[0].patch.points[1], { x: 120, y: 0 });
  assert.equal(parseCadCommand(`PEDIT ${boundaryId} OPEN`, context({ drawing: boundaryDrawing })).commands[0].patch.closed, false);
  assert.throws(() => parseCadCommand(`PEDIT ${boundaryId} DELETE 0`, context({ drawing: boundaryDrawing })), /1以上/);
});

test("command line resolves relative and polar coordinates against the previous point", () => {
  const lineCommand = parseCadCommand("LINE 100,100 @50,-20", context());
  assert.deepEqual(lineCommand.commands[0].entity.points, [{ x: 100, y: 100 }, { x: 150, y: 80 }]);

  const polar = parseCadCommand("LINE 100<90 @100<180", context());
  assert.deepEqual(polar.commands[0].entity.points, [{ x: 0, y: 100 }, { x: -100, y: 100 }]);

  const rectangle = parseCadCommand("RECT 10,20 @300,-200", context()).commands[0].entity;
  assert.deepEqual([rectangle.origin, rectangle.width, rectangle.height], [{ x: 10, y: -180 }, 300, 200]);

  const pline = parseCadCommand("PLINE 0,0 @1000,0 @0,500 @1000<180 CLOSE", context()).commands[0].entity;
  assert.deepEqual(pline.points, [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 500 }, { x: 0, y: 500 }]);
  assert.equal(pline.closed, true);

  const dimension = parseCadCommand("DIM 0,0 @300<0 200", context()).commands[0].entity;
  assert.deepEqual(dimension.points, [{ x: 0, y: 0 }, { x: 300, y: 0 }]);
  assert.match(parseCadCommand("DIST 0,0 @30,40", context()).message, /距離=50 /);

  const applied = applyTransaction(seedDrawing(), { source: "user", label: polar.label, commands: polar.commands });
  assert.equal(applied.ok, true);
});

test("command line accepts polar coordinates as point arguments and rejects ambiguous relative input", () => {
  const drawing = seedDrawing();
  const selectedId = drawing.entities.find((entity) => entity.type === "rect").id;
  const mirror = parseCadCommand("MIRROR 0,0 @100<90", context({ drawing, selectedId }));
  assert.equal(mirror.label, "MIRROR");
  const circleCommand = parseCadCommand("CIRCLE 200<45 10", context()).commands[0].entity;
  assert.ok(Math.abs(circleCommand.center.x - 141.421356237) < 1e-6);
  assert.equal(circleCommand.center.x, circleCommand.center.y);

  assert.throws(() => parseCadCommand("LINE @10,0 20,0", context()), /先頭の点/);
  assert.throws(() => parseCadCommand("CIRCLE @10,0 5", context()), /相対座標/);
  assert.throws(() => parseCadCommand(`MOVE ${selectedId} @10,0`, context({ drawing })), /相対座標/);
  assert.throws(() => parseCadCommand("LINE 0,0 @10<", context()), /angleが空/);
  assert.throws(() => parseCadCommand("LINE 0,0 10<20<30", context()), /距離<角度/);
  assert.throws(() => parseCadCommand("LINE 0,0 @abc<30", context()), /distanceが数値ではありません/);
  assert.throws(() => parseCadCommand("PLINE 1e308,0 @1e308,0", context()), /有効な数値範囲/);
  assert.throws(() => parseCadCommand("LINE 1e308,0 @1e308<0", context()), /有効な数値範囲/);
  assert.match(parseCadCommand("DIST 0,0 1<1e308", context()).message, /^距離=1 /);
  assert.equal(parseCadCommand("LINE 0,0 1e300<0", context()).commands[0].entity.points[1].x, 1e300);
  // 極座標の移動量はIDと誤認せず座標として扱う
  const moved = parseCadCommand("MOVE 100<0", context({ drawing, selectedId }));
  assert.deepEqual(moved.commands[0].id, selectedId);
});

test("ZOOM supports extents, window, previous and scale factor", () => {
  const ui = (value) => parseCadCommand(value, context());
  assert.deepEqual(ui("ZOOM"), { kind: "ui", action: "fit" });
  assert.deepEqual(ui("Z E"), { kind: "ui", action: "fit" });
  assert.deepEqual(ui("ZOOM P"), { kind: "ui", action: "zoomPrevious" });
  assert.deepEqual(ui("ZOOM PREVIOUS"), { kind: "ui", action: "zoomPrevious" });
  assert.deepEqual(ui("ZOOM W"), { kind: "ui", action: "tool", tool: "zoomwindow" });
  assert.deepEqual(ui("ZOOM W 0,0 1000,500"), { kind: "ui", action: "zoomWindow", corners: [{ x: 0, y: 0 }, { x: 1000, y: 500 }] });
  assert.deepEqual(ui("ZOOM 100,200 300,400"), { kind: "ui", action: "zoomWindow", corners: [{ x: 100, y: 200 }, { x: 300, y: 400 }] });
  assert.deepEqual(ui("ZOOM 2X"), { kind: "ui", action: "zoomFactor", factor: 2 });
  assert.deepEqual(ui("zoom 0.5x"), { kind: "ui", action: "zoomFactor", factor: 0.5 });
  assert.deepEqual(ui("ZOOM .25X"), { kind: "ui", action: "zoomFactor", factor: 0.25 });
  assert.throws(() => ui("ZOOM 0X"), /0より大きい/);
  assert.throws(() => ui("ZOOM 2"), /E\(全体\) \/ W\(窓\) \/ P\(前画面\)/);
  assert.throws(() => ui("ZOOM W 0,0"), /形式: ZOOM W/);
  assert.throws(() => ui("ZOOM Q"), /E\(全体\)/);
  // 余分な引数・無限大の倍率は表示を変えずに拒否する。
  assert.throws(() => ui("ZOOM P 2X"), /形式: ZOOM P/);
  assert.throws(() => ui("ZOOM E unexpected"), /形式: ZOOM E/);
  assert.throws(() => ui(`ZOOM ${"9".repeat(400)}X`), /有限/);
});
