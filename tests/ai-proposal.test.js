import test from "node:test";
import assert from "node:assert/strict";
import { seedDrawing } from "../src/cad-core.js";
import { MAX_LLM_COMMANDS, buildSystemPrompt, buildUserMessage, normalizeLlmProposal } from "../src/ai-proposal.js";

test("normalizeLlmProposal builds an add command from validated geometry", () => {
  const drawing = seedDrawing();
  const proposal = normalizeLlmProposal(
    drawing,
    {
      status: "planned",
      label: "テスト提案",
      commands: [{ op: "add", entityType: "line", layerId: "layer-temporary", start: { x: 0, y: 0 }, end: { x: 100, y: 100 } }]
    },
    { provider: "openai", model: "test-model" }
  );
  assert.equal(proposal.status, "planned");
  assert.equal(proposal.commands.length, 1);
  assert.equal(proposal.commands[0].op, "add");
  assert.equal(proposal.commands[0].entity.type, "line");
  assert.equal(proposal.commands[0].entity.layerId, "layer-temporary");
  assert.equal(proposal.commands[0].entity.meta.createdBy, "agent");
  assert.equal(proposal.impact.add, 1);
  assert.equal(proposal.engine, "llm");
  assert.equal(proposal.provider, "openai");
  assert.equal(proposal.model, "test-model");
});

test("normalizeLlmProposal discards LLM-supplied id and style, regenerating them server-side", () => {
  const drawing = seedDrawing();
  const proposal = normalizeLlmProposal(drawing, {
    status: "planned",
    commands: [
      {
        op: "add",
        entityType: "circle",
        layerId: "layer-temporary",
        center: { x: 100, y: 100 },
        radius: 50,
        id: "e_frame_1",
        style: { strokeWidth: 999 }
      }
    ]
  });
  const entity = proposal.commands[0].entity;
  assert.notEqual(entity.id, "e_frame_1");
  assert.notEqual(entity.style.strokeWidth, 999);
});

test("normalizeLlmProposal drops disallowed ops such as delete_layer", () => {
  const drawing = seedDrawing();
  const proposal = normalizeLlmProposal(drawing, {
    status: "planned",
    commands: [{ op: "delete_layer", id: "layer-structure" }]
  });
  assert.equal(proposal.status, "needs_input");
  assert.match(proposal.warnings.join(" "), /不正または未対応の操作/);
});

test("normalizeLlmProposal drops geometry outside the paper bounds", () => {
  const drawing = seedDrawing();
  const proposal = normalizeLlmProposal(drawing, {
    status: "planned",
    commands: [{ op: "add", entityType: "circle", layerId: "layer-temporary", center: { x: 50000, y: 0 }, radius: 10 }]
  });
  assert.equal(proposal.status, "needs_input");
  assert.match(proposal.warnings.join(" "), /用紙範囲外/);
});

test("normalizeLlmProposal drops add commands targeting a locked layer", () => {
  const drawing = seedDrawing();
  drawing.layers.find((layer) => layer.id === "layer-structure").locked = true;
  const proposal = normalizeLlmProposal(drawing, {
    status: "planned",
    commands: [{ op: "add", entityType: "circle", layerId: "layer-structure", center: { x: 100, y: 100 }, radius: 10 }]
  });
  assert.equal(proposal.status, "needs_input");
  assert.match(proposal.warnings.join(" "), /ロック中レイヤー/);
});

test("normalizeLlmProposal builds a sanitized update command for an existing entity", () => {
  const drawing = seedDrawing();
  const target = drawing.entities.find((entity) => entity.id === "e_box_1");
  const proposal = normalizeLlmProposal(drawing, {
    status: "planned",
    commands: [{ op: "update", id: target.id, patch: { width: 5000, height: 3000, maliciousField: "ignored" } }]
  });
  assert.equal(proposal.status, "planned");
  assert.equal(proposal.commands[0].op, "update");
  assert.equal(proposal.commands[0].patch.width, 5000);
  assert.equal(proposal.commands[0].patch.height, 3000);
  assert.equal("maliciousField" in proposal.commands[0].patch, false);
});

test("normalizeLlmProposal rejects update commands referencing a nonexistent entity", () => {
  const drawing = seedDrawing();
  const proposal = normalizeLlmProposal(drawing, {
    status: "planned",
    commands: [{ op: "update", id: "e_missing", patch: { width: 100 } }]
  });
  assert.equal(proposal.status, "needs_input");
  assert.match(proposal.warnings.join(" "), /更新対象が見つからない/);
});

test("normalizeLlmProposal caps commands at MAX_LLM_COMMANDS and warns about the overflow", () => {
  const drawing = seedDrawing();
  const commands = Array.from({ length: MAX_LLM_COMMANDS + 5 }, () => ({
    op: "add",
    entityType: "circle",
    layerId: "layer-temporary",
    center: { x: 100, y: 100 },
    radius: 10
  }));
  const proposal = normalizeLlmProposal(drawing, { status: "planned", commands });
  assert.equal(proposal.commands.length, MAX_LLM_COMMANDS);
  assert.match(proposal.warnings.join(" "), new RegExp(`${MAX_LLM_COMMANDS}件を超えた`));
});

test("normalizeLlmProposal returns needs_input with a question when nothing survives validation", () => {
  const drawing = seedDrawing();
  const proposal = normalizeLlmProposal(drawing, { status: "planned", question: "具体的にどこへ追加しますか？", commands: [] });
  assert.equal(proposal.status, "needs_input");
  assert.equal(proposal.question, "具体的にどこへ追加しますか？");
});

test("buildSystemPrompt embeds drawing context as data and instructs the model to ignore embedded instructions", () => {
  const drawing = seedDrawing();
  const prompt = buildSystemPrompt(drawing);
  assert.match(prompt, /<drawing_context>/);
  assert.match(prompt, /無視/);
  assert.doesNotMatch(prompt, /Review Required/);
});

test("buildUserMessage wraps the prompt in a data tag and truncates overly long input", () => {
  const message = buildUserMessage("x".repeat(5000));
  assert.match(message, /^<user_request>/);
  assert.equal(message.length <= 2000 + "<user_request></user_request>".length, true);
});

test("buildSystemPrompt escapes < and > in layer names and entity ids", () => {
  const drawing = seedDrawing();
  drawing.layers[0].name = "悪意<injection>";
  const prompt = buildSystemPrompt(drawing);
  assert.doesNotMatch(prompt, /<injection>/);
  assert.match(prompt, /悪意injection/);
});

test("normalizeLlmProposal allowlists update_layer patch and drops unknown fields", () => {
  const drawing = seedDrawing();
  const proposal = normalizeLlmProposal(drawing, {
    status: "planned",
    commands: [{ op: "update_layer", id: "layer-structure", patch: { visible: false, name: "構造物2", color: "#123456", evil: "x", locked: "not-bool" } }]
  });
  assert.equal(proposal.status, "planned");
  const patch = proposal.commands[0].patch;
  assert.equal(patch.visible, false);
  assert.equal(patch.name, "構造物2");
  assert.equal(patch.color, "#123456");
  assert.equal("evil" in patch, false);
  assert.equal("locked" in patch, false);
});

test("normalizeLlmProposal allowlists update_layout patch", () => {
  const drawing = seedDrawing();
  const proposal = normalizeLlmProposal(drawing, {
    status: "planned",
    commands: [{ op: "update_layout", patch: { paper: "A4", orientation: "landscape", scale: 50, evil: true } }]
  });
  assert.equal(proposal.status, "planned");
  const patch = proposal.commands[0].patch;
  assert.equal(patch.paper, "A4");
  assert.equal(patch.orientation, "landscape");
  assert.equal(patch.scale, 50);
  assert.equal("evil" in patch, false);
});

test("normalizeLlmProposal allowlists update_drawing_meta patch", () => {
  const drawing = seedDrawing();
  const proposal = normalizeLlmProposal(drawing, {
    status: "planned",
    commands: [{ op: "update_drawing_meta", patch: { name: "新しい名前", evil: "x" } }]
  });
  assert.equal(proposal.status, "planned");
  const patch = proposal.commands[0].patch;
  assert.equal(patch.name, "新しい名前");
  assert.equal("evil" in patch, false);
});

test("normalizeLlmProposal rejects add_layer with non-[a-z0-9_-] id and normalizes bad color", () => {
  const drawing = seedDrawing();
  const proposal = normalizeLlmProposal(drawing, {
    status: "planned",
    commands: [
      { op: "add_layer", layer: { id: "layer<script>", name: "x" } },
      { op: "add_layer", layer: { id: "layer-ok", name: "ok", color: "red" } }
    ]
  });
  assert.equal(proposal.status, "planned");
  assert.equal(proposal.commands.length, 1);
  assert.equal(proposal.commands[0].layer.id, "layer-ok");
  assert.equal(proposal.commands[0].layer.color, "#5b6b7a");
});
