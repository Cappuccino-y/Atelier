import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseHandoff,
  validateOutputAgainstSchema,
  validateOutputAgainstSchemaDetailed,
  diagnoseHandoffFailure,
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

  it("accepts object-form `to` entries ({id, name}) — LLM drift (assads regression)", () => {
    // Models sometimes emit the server-internal shape
    // [{"id":"atlas","name":"Atlas","rawName":"atlas"}] instead of plain
    // strings. v2 schema now accepts both; both must resolve.
    const content = "```handoff\n" +
      '{"schemaVersion":"2.0","to":[{"id":"atlas","name":"Atlas","rawName":"atlas"}],"taskSummary":"调研完成，派 Forge 实现","requiredOutputSchema":"research_brief"}\n' +
      "```";
    const d = parseHandoff(content, locator);
    assert.ok(d, "must parse object-form to");
    assert.equal(d.to.length, 1);
    assert.equal(d.to[0].id, "atlas");
  });

  it("accepts object-form `to` with only a name", () => {
    const content = "```handoff\n" +
      '{"schemaVersion":"2.0","to":[{"name":"Lens"}],"taskSummary":"review"}\n' +
      "```";
    const d = parseHandoff(content, locator);
    assert.ok(d, "must parse name-only object");
    assert.equal(d.to[0].id, "lens");
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
  it("lenient: schema-name label satisfies research_brief (P2-4 regression)", () => {
    // LLMs occasionally write `research_brief:` instead of `[RESEARCH]`.
    assert.equal(validateOutputAgainstSchema("research_brief: 调研完成", "research_brief"), true);
    assert.equal(validateOutputAgainstSchema("RESEARCH\n结论", "research_brief"), true);
    // ...but a reply with no research signal at all still fails.
    assert.equal(validateOutputAgainstSchema("随便聊两句没有产出", "research_brief"), false);
  });
  it("lenient does not leak across schemas", () => {
    // [RESULT] must not satisfy review_block even under lenient matching.
    assert.equal(validateOutputAgainstSchema("[RESULT] 完成", "review_block"), false);
    assert.equal(validateOutputAgainstSchema("[REVIEW] all clean", "result_block"), false);
  });
});

describe("validateOutputAgainstSchemaDetailed", () => {
  it("returns ok with null reason on pass", () => {
    const r = validateOutputAgainstSchemaDetailed("[RESULT] 完成", "result_block");
    assert.deepEqual(r, { ok: true, reason: null });
  });
  it("returns a SPECIFIC reason naming the missing tag on fail", () => {
    const r = validateOutputAgainstSchemaDetailed("只说了计划没有产出", "result_block");
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /\[RESULT\]/);
    assert.match(r.reason ?? "", /requiredOutputSchema="result_block"/);
  });
  it("empty answer_text fail says reply is empty", () => {
    const r = validateOutputAgainstSchemaDetailed("", "answer_text");
    assert.equal(r.ok, false);
    assert.equal(r.reason, "reply is empty");
  });
  it("no required schema passes without reason", () => {
    const r = validateOutputAgainstSchemaDetailed("anything", undefined);
    assert.deepEqual(r, { ok: true, reason: null });
  });
});

describe("parseHandoff — repair (P1-2 regression)", () => {
  it("repairs illegal backslash escapes in taskSummary (Windows paths)", () => {
    // `D:\浏览器下载文件\脑卒中.yml` — `\浏` is not a valid JSON escape.
    const content = "[STATUS] 收到\n\n" +
      '{"schemaVersion":"2.0","to":["forge"],"taskSummary":"读取 D:\\浏览器下载文件\\脑卒中.yml 并分析","requiredOutputSchema":"result_block"}';
    const d = parseHandoff(content, locator);
    assert.ok(d, "must parse after escape repair");
    assert.equal(d.to[0].id, "forge");
    assert.ok(d.taskSummary.includes("浏览器下载文件"), "path text preserved");
  });

  it("keeps parsing when a code block with unclosed brace precedes the handoff (B7 regression)", () => {
    const content = "代码示例：\n```\nfunction f() {\n  return 1;\n```\n\n" +
      '{"schemaVersion":"2.0","to":["lens"],"taskSummary":"review 上面的代码"}';
    const d = parseHandoff(content, locator);
    assert.ok(d, "must skip past unclosed brace and still find handoff");
    assert.equal(d.to[0].id, "lens");
  });

  it("clamps overlong taskSummary instead of rejecting", () => {
    const long = "x".repeat(5000);
    const content = `{"schemaVersion":"2.0","to":["forge"],"taskSummary":"${long}"}`;
    const d = parseHandoff(content, locator);
    assert.ok(d, "must parse despite overlong taskSummary");
    assert.ok(d.taskSummary.length <= 2000, "taskSummary clamped");
  });

  it("clamps maxRetries instead of rejecting", () => {
    const content = '{"schemaVersion":"2.0","to":["forge"],"taskSummary":"x","failurePolicy":{"maxRetries":9}}';
    const d = parseHandoff(content, locator);
    assert.ok(d, "must parse despite maxRetries: 9");
    assert.equal(d.failurePolicy.maxRetries, 3, "maxRetries clamped to 3");
  });
});

describe("diagnoseHandoffFailure", () => {
  it("explains unknown schemaVersion", () => {
    const content = '{"schemaVersion":"9.9","to":["forge"],"taskSummary":"x"}';
    const diag = diagnoseHandoffFailure(content, locator);
    assert.ok(diag, "should return a reason");
    assert.match(diag!, /schemaVersion/);
  });

  it("explains schema rejection (bad to entry)", () => {
    const content = '{"schemaVersion":"2.0","to":[{"weird":true}],"taskSummary":"x"}';
    const diag = diagnoseHandoffFailure(content, locator);
    assert.ok(diag, "should return a reason");
    assert.match(diag!, /schema rejected/);
  });

  it("explains unresolved targets", () => {
    const knownOnly: AgentLocator = (raw) => {
      const known = new Set(["atlas", "forge", "lens"]);
      return known.has(raw.toLowerCase()) ? { id: raw.toLowerCase(), name: raw } : null;
    };
    const content = '{"schemaVersion":"2.0","to":["ghost-agent"],"taskSummary":"x"}';
    const diag = diagnoseHandoffFailure(content, knownOnly);
    assert.ok(diag, "should return a reason");
    assert.match(diag!, /targets/);
  });

  it("returns null when no handoff-shaped JSON exists", () => {
    assert.equal(diagnoseHandoffFailure("随便聊两句", locator), null);
    assert.equal(diagnoseHandoffFailure("@Atlas 你好", locator), null);
  });

  it("returns null when handoff actually parses fine", () => {
    const content = '{"schemaVersion":"2.0","to":["forge"],"taskSummary":"x"}';
    assert.equal(diagnoseHandoffFailure(content, locator), null);
  });
});

describe("extractAllTags", () => {
  it("extracts the v2 tag set without dupes", () => {
    const tags = extractAllTags("[RESULT][RESULT][REVIEW][MEMORY:DEPRECATE][ANALYSIS]");
    assert.deepEqual([...tags].sort(), ["ANALYSIS", "MEMORY", "RESULT", "REVIEW"].sort());
  });
});
