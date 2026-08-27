// Direct unit-style verification of handoff schema + formatHandoffTaskTrailer
// back-compat. Exercises the new structured context AND legacy contextExcerpt.
import assert from "node:assert/strict";
import { parseHandoff, formatHandoffTaskTrailer, HandoffContextSchema } from "../src/agents/handoff.js";

function makeLocator(byName) {
  return (raw) => {
    const key = String(raw ?? "").toLowerCase().replace(/[^a-z]/g, "");
    const map = {
      atlas: { id: "atlas", name: "Atlas", rawName: "atlas" },
      forge: { id: "forge", name: "Forge", rawName: "forge" },
      scout: { id: "scout", name: "Scout", rawName: "scout" },
      echo: { id: "echo", name: "Echo", rawName: "echo" },
    };
    return map[key] ?? null;
  };
}

const loc = makeLocator();

// --- Test 1: legacy v2.0 contextExcerpt still parses
{
  const text = JSON.stringify({
    schemaVersion: "2.0",
    to: ["forge"],
    taskSummary: "实现 X",
    provenance: {
      parentAgent: "atlas",
      contextExcerpt: "atlas 之前的 3-5 行历史摘要",
    },
    requiredOutputSchema: "result_block",
  });
  const d = parseHandoff(`prefix ${text} suffix`, loc);
  assert.ok(d, "legacy v2.0 with contextExcerpt must parse");
  assert.equal(d.to[0].id, "forge");
  assert.equal(d.provenance.contextExcerpt, "atlas 之前的 3-5 行历史摘要");
  assert.equal(d.provenance.context, undefined, "no structured context in legacy");

  // Trailer rendering uses legacy path
  const trailer = formatHandoffTaskTrailer(d);
  assert.match(trailer, /\[context excerpt\]:/);
  assert.match(trailer, /atlas 之前的 3-5 行历史摘要/);
  assert.doesNotMatch(trailer, /\[handoff context\]:/);
  console.log("✅ Test 1: legacy contextExcerpt back-compat OK");
}

// --- Test 2: v2.1 with structured context parses
{
  const text = JSON.stringify({
    schemaVersion: "2.1",
    to: ["forge"],
    taskSummary: "实现 golixp",
    intent: "verify_fix",
    provenance: {
      parentAgent: "atlas",
      parentMessageId: "msg-123",
      context: {
        taskSummary: "用户要 2 页简历",
        outputHighlights: [
          "deadline 180s",
          "字体 ≤ 9.5pt",
        ],
        attachedFacts: [
          "workspace = out/rooms/<id>/",
          "agent 必须 visual verify 后再 RESULT",
        ],
        skippedNoise: [
          "裁掉了 Scout 5 次失败的搜索迭代",
        ],
        parentChain: ["root-trace", "user-001", "atlas-decompose"],
      },
    },
    requiredOutputSchema: "result_block",
    constraints: { deadlineMs: 180000, maxTokens: 4000 },
    evidenceStandard: "strict",
    attachmentRefs: ["img-1"],
  });
  const d = parseHandoff(`prefix ${text} suffix`, loc);
  assert.ok(d, "v2.1 with structured context must parse");
  assert.equal(d.intent, "verify_fix");
  assert.ok(d.provenance.context, "structured context present");
  assert.equal(d.provenance.context.taskSummary, "用户要 2 页简历");
  assert.equal(d.provenance.context.outputHighlights.length, 2);
  assert.equal(d.provenance.context.attachedFacts.length, 2);
  assert.equal(d.provenance.context.skippedNoise.length, 1);
  assert.deepEqual(d.provenance.context.parentChain, ["root-trace", "user-001", "atlas-decompose"]);
  // Legacy field not set
  assert.equal(d.provenance.contextExcerpt, undefined);

  // Trailer renders structured fields
  const trailer = formatHandoffTaskTrailer(d);
  assert.match(trailer, /\[handoff context\]:/);
  assert.match(trailer, /taskSummary: 用户要 2 页简历/);
  assert.match(trailer, /outputHighlights:/);
  assert.match(trailer, /attachedFacts \(must honor\):/);
  assert.match(trailer, /skippedNoise \(do not re-explore\):/);
  assert.match(trailer, /parentChain: root-trace → user-001 → atlas-decompose/);
  assert.match(trailer, /\[constraints\]: deadline=180s; maxTokens=4000/);
  assert.match(trailer, /\[intent\]: verify_fix/);
  assert.doesNotMatch(trailer, /\[context excerpt\]:/);
  console.log("✅ Test 2: structured context v2.1 OK");
}

// --- Test 3: v2.1 with both structured + legacy (structured wins)
{
  const text = JSON.stringify({
    schemaVersion: "2.1",
    to: ["forge"],
    taskSummary: "y",
    provenance: {
      context: { taskSummary: "structured wins" },
      contextExcerpt: "legacy should be ignored in render",
    },
  });
  const d = parseHandoff(text, loc);
  assert.equal(d.provenance.context.taskSummary, "structured wins");
  assert.equal(d.provenance.contextExcerpt, "legacy should be ignored in render");
  // Trailer: structured wins, legacy excerpt hidden
  const trailer = formatHandoffTaskTrailer(d);
  assert.match(trailer, /taskSummary: structured wins/);
  assert.doesNotMatch(trailer, /legacy should be ignored/);
  console.log("✅ Test 3: structured wins over legacy");
}

// --- Test 4: parallel fan-out still works with structured context
{
  const text = JSON.stringify({
    schemaVersion: "2.1",
    to: [
      { name: "forge", taskSummary: "实现", requiredOutputSchema: "result_block" },
      { name: "scout", taskSummary: "调研", requiredOutputSchema: "research_brief" },
    ],
    taskSummary: "并行探索",
    provenance: { context: { outputHighlights: ["deadline 60s"] } },
  });
  const d = parseHandoff(text, loc);
  assert.equal(d.to.length, 2);
  assert.equal(d.to[0].taskSummary, "实现");
  assert.equal(d.to[0].requiredOutputSchema, "result_block");
  assert.equal(d.to[1].taskSummary, "调研");
  assert.equal(d.to[1].requiredOutputSchema, "research_brief");
  assert.equal(d.provenance.context.outputHighlights[0], "deadline 60s");
  console.log("✅ Test 4: parallel fan-out with structured context OK");
}

// --- Test 5: HandoffContextSchema directly validates shape
{
  // preprocess clamps rather than rejects — consistent with taskSummary /
  // task / intent which all clamp in the main schema. Verify truncation,
  // not strict rejection.
  const oversize = HandoffContextSchema.safeParse({
    taskSummary: "x".repeat(600), // over 500 cap
  });
  assert.equal(oversize.success, true, "over-length taskSummary is clamped, not rejected");
  assert.equal(oversize.data.taskSummary.length, 500, "should clamp to 500");

  // Highlights cap is .max(5) on the preprocessed array — slice(0, 5)
  // keeps the first 5; doesn't reject.
  const many = HandoffContextSchema.safeParse({
    outputHighlights: Array(8).fill("bullet"),
  });
  assert.equal(many.success, true);
  assert.equal(many.data.outputHighlights.length, 5, "should clamp highlights to 5");

  // Negative: empty object must pass (all fields optional).
  const empty = HandoffContextSchema.safeParse({});
  assert.equal(empty.success, true);

  console.log("✅ Test 5: schema validation (clamp behavior) OK");
}

console.log("\n🎉 All CP3 (handoff structured context) back-compat tests passed.");
