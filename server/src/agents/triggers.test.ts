import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildBargeInPrompt, detectDispatchIntent } from "./triggers.js";

const NOW = 1_700_000_000_000;
const resolve = (name: string): { id: string } | null =>
  /^(atlas|forge|lens|echo|scout|writer|trainer|analyst|archivist)$/i.test(name)
    ? { id: name.toLowerCase() }
    : null;

describe("detectDispatchIntent — narrated dispatch without structured block", () => {
  it("fires on the 2026-09-19 atlas resume narration", () => {
    const content =
      "收到，接着上次的进度推进。中断前 Forge 正在做剩余视觉修复线，它已经定位到 `/blog` 侧栏 `lg:pt-10` 的对齐 bug，但改动没做完。我现在把这条线重新派给 Forge 续做——带上中断前的进度要点，避免它从头探索。完成后按流程派 Lens 复验，再向你汇总。";
    assert.equal(detectDispatchIntent(content, resolve), "forge");
  });

  it("fires on direct hand-over phrasing", () => {
    assert.equal(detectDispatchIntent("这条任务交给 Lens 复验。", resolve), "lens");
    assert.equal(detectDispatchIntent("这条线转派给 Forge 续做。", resolve), "forge");
  });

  it("skips conditional / future wrap-up phrasing (legitimate no-dispatch)", () => {
    assert.equal(detectDispatchIntent("你说一声「继续」我就派 Forge 逐条改版。", resolve), null);
    assert.equal(detectDispatchIntent("完成后我让 Lens 复验再向你汇总。", resolve), null);
    assert.equal(detectDispatchIntent("改完我再派 Lens 复验。", resolve), null);
    assert.equal(detectDispatchIntent("之后将把任务交给 Forge。", resolve), null);
  });

  it("ignores mentions of non-agent names", () => {
    assert.equal(detectDispatchIntent("让 用户 自己硬刷新看看。", resolve), null);
    assert.equal(detectDispatchIntent("我会把结果发到 中土编年史 里。", resolve), null);
  });
});

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
