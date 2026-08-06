import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseHandoff,
  validateOutputAgainstSchema,
  extractAllTags,
  type AgentLocator,
} from "./handoff.js";

const locator: AgentLocator = (raw: string) => ({ id: raw.toLowerCase(), name: raw });

describe("parseHandoff — v2 wire schema", () => {
  it("accepts a v2 block WITHOUT traceId (server generates it)", () => {
    // SHARED_RULES: "traceId 由 server 自动生成" — agents following the
    // prompt examples omit it. Rejecting it would silently break routing.
    const content = "[DECISION] 收到。\n\n```handoff\n" +
      '{"schemaVersion":"2.0","to":["forge"],"taskSummary":"实现需求","requiredOutputSchema":"result_block"}\n' +
      "```";
    const d = parseHandoff(content, locator);
    assert.ok(d, "must parse");
    assert.equal(d.traceId.length > 0, true, "traceId generated");
    assert.equal(d.to[0].id, "forge");
    assert.equal(d.requiredOutputSchema, "result_block");
  });

  it("preserves an explicitly supplied traceId", () => {
    const content = "```handoff\n" +
      '{"schemaVersion":"2.1","traceId":"trace-42","to":["lens"],"taskSummary":"review","intent":"verify_fix"}\n' +
      "```";
    const d = parseHandoff(content, locator);
    assert.ok(d);
    assert.equal(d.traceId, "trace-42");
    assert.equal(d.rawTraceId, "trace-42");
    assert.equal(d.intent, "verify_fix");
  });

  it("rejects an unknown schemaVersion marker", () => {
    const content = "```handoff\n" +
      '{"schemaVersion":"9.9","to":["forge"],"taskSummary":"x"}\n' +
      "```";
    assert.equal(parseHandoff(content, locator), null);
  });

  it("accepts legacy v1 {to, task} shape", () => {
    const content = "```handoff\n{\"to\":[\"forge\"],\"task\":\"实现\"}\n```";
    const d = parseHandoff(content, locator);
    assert.ok(d);
    assert.equal(d.to[0].id, "forge");
    assert.equal(d.taskSummary, "实现");
  });

  it("returns null when `to` resolves to no known agent", () => {
    const content = "```handoff\n" +
      '{"schemaVersion":"2.0","to":["no-such-agent"],"taskSummary":"x"}\n' +
      "```";
    const noMatch: AgentLocator = () => null;
    assert.equal(parseHandoff(content, noMatch), null);
  });

  it("multi-target `to` is preserved in order (parallel fan-out basis)", () => {
    // SEMANTIC CONTRACT: 2+ targets = parallel fan-out, order preserved.
    // Sequential intent must be single-target hops, never a multi-target
    // array. This test locks the parse layer: all targets resolve and keep
    // the declared order so the dispatcher can fan out in parallel.
    const content = "```handoff\n" +
      '{"schemaVersion":"2.0","to":["analyst","lens"],"taskSummary":"分析并复核","requiredOutputSchema":"analysis"}\n' +
      "```";
    const d = parseHandoff(content, locator);
    assert.ok(d, "must parse");
    assert.equal(d.to.length, 2);
    assert.equal(d.to[0].id, "analyst");
    assert.equal(d.to[1].id, "lens");
  });
});

describe("validateOutputAgainstSchema", () => {
  it("result_block passes when [RESULT] present", () => {
    assert.equal(validateOutputAgainstSchema("[RESULT] 完成", "result_block"), true);
    assert.equal(validateOutputAgainstSchema("[RESULT] 完成", "review_block"), false);
  });
  it("memory_write passes for [MEMORY] and [MEMORY:DEPRECATE]", () => {
    assert.equal(validateOutputAgainstSchema("[MEMORY]\nscope: global", "memory_write"), true);
    assert.equal(validateOutputAgainstSchema("title: [MEMORY:DEPRECATE] 旧条目", "memory_write"), true);
  });
  it("answer_text passes on any non-empty reply", () => {
    assert.equal(validateOutputAgainstSchema("hello", "answer_text"), true);
    assert.equal(validateOutputAgainstSchema("", "answer_text"), false);
  });
  it("no required schema always passes", () => {
    assert.equal(validateOutputAgainstSchema("anything", undefined), true);
  });
});

describe("extractAllTags", () => {
  it("extracts the v2 tag set without dupes", () => {
    const tags = extractAllTags("[RESULT][RESULT][REVIEW][MEMORY:DEPRECATE][ANALYSIS]");
    assert.deepEqual([...tags].sort(), ["ANALYSIS", "MEMORY", "RESULT", "REVIEW"].sort());
  });
});
