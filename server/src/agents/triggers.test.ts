import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildBargeInPrompt } from "./triggers.js";

const NOW = 1_700_000_000_000;

describe("buildBargeInPrompt — barge-in steering prompt", () => {
  it("includes the interrupt report with elapsed time and last tool", () => {
    const out = buildBargeInPrompt(
      "先别改命名，改成 patch-only",
      [{ startedAt: NOW - 42_000, lastTool: "bash", lastInput: "npm test" }],
      NOW,
    );
    assert.match(out, /\[用户插话中断\]/);
    assert.match(out, /已运行 42s/);
    assert.match(out, /`bash`: npm test/);
    assert.match(out, /用户新指示：先别改命名，改成 patch-only/);
  });

  it("handles runs that never started a tool call", () => {
    const out = buildBargeInPrompt("换个方向", [{ startedAt: NOW - 5_000 }], NOW);
    assert.match(out, /尚未开始工具调用/);
    assert.doesNotMatch(out, /正在执行/);
  });

  it("does not include a report section when no runs were live", () => {
    const out = buildBargeInPrompt("继续", [], NOW);
    assert.match(out, /\[用户插话中断\]/);
    assert.doesNotMatch(out, /中断现场/);
    assert.match(out, /用户新指示：继续/);
  });

  it("caps elapsed at 1s minimum for very fresh runs", () => {
    const out = buildBargeInPrompt("停", [{ startedAt: NOW - 300 }], NOW);
    assert.match(out, /已运行 1s/);
  });
});
