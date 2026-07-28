import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { consumeJsonObjects, parseOpenCodeOutput } from "./process-agent.js";

describe("consumeJsonObjects — brace-balanced JSON stream parser", () => {
  it("parses a single complete object", () => {
    const buf = `{"type":"text","part":{"text":"hello"}}`;
    const { consumed, objects } = consumeJsonObjects(buf);
    assert.equal(consumed, buf.length);
    assert.equal(objects.length, 1);
    assert.deepEqual(objects[0], { type: "text", part: { text: "hello" } });
  });

  it("parses multiple concatenated objects", () => {
    const buf = `{"type":"step_start"}{"type":"text","part":{"text":"a"}}{"type":"step_finish"}`;
    const { consumed, objects } = consumeJsonObjects(buf);
    assert.equal(consumed, buf.length);
    assert.equal(objects.length, 3);
    assert.equal(objects[0].type, "step_start");
    assert.equal(objects[1].part.text, "a");
    assert.equal(objects[2].type, "step_finish");
  });

  it("decodes \\\\n escape sequences inside string values (opencode real-world)", () => {
    // opencode emits text values containing actual LFs but JSON-escaped as
    // the 2-char sequence `\n` (backslash+n). After JSON.parse the string
    // value contains real LFs (the canonical JSON interpretation).
    const buf = `{"type":"text","part":{"type":"text","text":"line1\\nline2\\nline3"}}`;
    const { consumed, objects } = consumeJsonObjects(buf);
    assert.equal(consumed, buf.length, "should consume the entire buffer");
    assert.equal(objects.length, 1, "should parse as ONE object");
    assert.equal(objects[0].part.text, "line1\nline2\nline3", "LF escapes decoded");
  });

  it("handles braces inside string values", () => {
    const buf = `{"type":"text","part":{"text":"code: {\\n  x: 1\\n}"}}`;
    const { consumed, objects } = consumeJsonObjects(buf);
    assert.equal(consumed, buf.length);
    assert.equal(objects.length, 1);
    assert.equal(objects[0].part.text, "code: {\n  x: 1\n}");
  });

  it("handles escaped quotes inside string values", () => {
    const buf = `{"type":"text","part":{"text":"he said \\"hi\\" to me"}}`;
    const { consumed, objects } = consumeJsonObjects(buf);
    assert.equal(consumed, buf.length);
    assert.equal(objects.length, 1);
    assert.equal(objects[0].part.text, `he said "hi" to me`);
  });

  it("returns incomplete-object marker when buffer is truncated mid-object", () => {
    const buf = `{"type":"text","part":{"text":"truncated`;
    const { consumed, objects } = consumeJsonObjects(buf);
    assert.equal(objects.length, 0, "no complete object yet");
    assert.equal(consumed, 0, "consumed=0 when object starts at index 0");
    assert.equal(buf.slice(consumed), buf, "buffer preserved for retry");
  });

  it("returns partial-consume when only one of many objects fits", () => {
    // Two objects, second one truncated
    const buf = `{"type":"text","part":{"text":"first"}}{"type":"text","part":{"te`;
    const { consumed, objects } = consumeJsonObjects(buf);
    assert.equal(objects.length, 1, "first object parsed");
    assert.equal(objects[0].part.text, "first");
    assert.ok(consumed < buf.length, "tail preserved for next call");
    assert.equal(consumed + (buf.length - consumed), buf.length, "tail starts where parsing stopped");
  });

  it("skips malformed JSON and continues with the next object", () => {
    // Two objects concatenated without a valid separator; first is malformed.
    const buf = `{"type":"broken","part":{"text":"oops"}}{"type":"text","part":{"text":"ok"}}`;
    const { consumed, objects } = consumeJsonObjects(buf);
    assert.equal(consumed, buf.length, "all bytes consumed");
    assert.ok(objects.length >= 1);
    const valid = objects.find((o) => o.type === "text" && o.part?.text === "ok");
    assert.ok(valid, "valid trailing object recovered");
  });

  it("handles the real-world Forge pattern (multi-event with pretty-printed tool output)", () => {
    // Reproduces the opencode stdout shape from the bug screenshot:
    // a text event followed by a tool_use event whose state.output
    // contains escaped \n sequences (pretty-printed JSON inside a string).
    // Naive split-by-line would shred these into many fragments; the
    // brace-balanced parser must recover both events cleanly.
    const buf =
      `{"type":"text","part":{"type":"text","text":"我先确认桌面路径和 C++ 编译器，再生成源码并实际编译验证。"}}` +
      `\n` +
      `{"type":"tool_use","timestamp":1785224705248,"part":{"type":"tool","tool":"todowrite","state":{"status":"completed","input":{"todos":[{"content":"a","status":"in_progress"}]},"output":"[ \\n {\\n  \\"content\\": \\"a\\",\\n  \\"status\\": \\"in_progress\\"\\n }\\n]"}}}`;
    const { consumed, objects } = consumeJsonObjects(buf);
    assert.equal(consumed, buf.length);
    assert.equal(objects.length, 2, "exactly 2 events, not shredded");
    assert.equal(objects[0].type, "text");
    assert.equal(objects[0].part.text, "我先确认桌面路径和 C++ 编译器，再生成源码并实际编译验证。");
    assert.equal(objects[1].type, "tool_use");
    assert.equal(objects[1].part.tool, "todowrite");
    assert.match(objects[1].part.state.output, /\n/, "tool output preserves newlines");
  });

  it("handles empty / whitespace-only buffer", () => {
    assert.deepEqual(consumeJsonObjects(""), { consumed: 0, objects: [] });
    assert.deepEqual(consumeJsonObjects("   \n\n  \n"), { consumed: 8, objects: [] });
  });

  it("recovers from invalid JSON (literal LF inside string) without deadlocking", () => {
    // Strict JSON.parse rejects literal LF inside strings. Our parser must
    // still recognize object boundaries — otherwise a single bad event
    // would block the rest of the stream. The malformed object is skipped;
    // valid trailing objects must still be recovered.
    const buf =
      `{"type":"text","part":{"text":"line1` + "\n" + `line2"}}` +  // literal LF (invalid JSON)
      `\n` +
      `{"type":"text","part":{"text":"valid"}}`;
    const { consumed, objects } = consumeJsonObjects(buf);
    assert.equal(consumed, buf.length, "all bytes consumed (malformed skipped)");
    const valid = objects.find((o) => o.part?.text === "valid");
    assert.ok(valid, "valid trailing object recovered");
  });
});

describe("parseOpenCodeOutput — end-to-end (Bug 1 regression)", () => {
  it("extracts only text content, never leaks raw JSON", () => {
    const stdout =
      `{"type":"step_start","part":{"type":"step-start"}}` + "\n" +
      `{"type":"text","part":{"type":"text","text":"好的，我先确认环境。"}}` + "\n" +
      `{"type":"tool_use","part":{"type":"tool","tool":"bash","state":{"output":"line1\\nline2\\nline3"}}}` + "\n" +
      `{"type":"text","part":{"type":"text","text":"环境 OK，开始实现。"}}` + "\n" +
      `{"type":"step_finish","part":{"reason":"stop"}}`;

    const result = parseOpenCodeOutput(stdout);
    assert.equal(result.success, true);
    assert.equal(result.content, "好的，我先确认环境。环境 OK，开始实现。");
    assert.ok(!result.content.includes("{"), "no JSON brackets in content");
    assert.ok(!result.content.includes('"type"'), "no JSON keys in content");
  });

it("joins multi-paragraph text correctly", () => {
    const inner = "第一段\\n\\n第二段\\n\\n代码块：x = 1";
    const stdout = `{"type":"text","part":{"text":"${inner}"}}`;
    const result = parseOpenCodeOutput(stdout);
    assert.equal(result.content, "第一段\n\n第二段\n\n代码块：x = 1");
  });

  it("returns empty content and success=false when no text events", () => {
    const stdout = `{"type":"step_start"}{"type":"step_finish"}`;
    const result = parseOpenCodeOutput(stdout);
    assert.equal(result.content, "");
    assert.equal(result.success, false);
  });
});