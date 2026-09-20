import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.AGENT_RUNTIME = "mock";

const { db } = await import("../db.js");
const {
  DEFAULT_BURST_CONFIG,
  resetBursts,
  startBurst,
  abortBurst,
  burstActive,
  burstProgress,
  recordTurn,
  stopBurst,
  normalizeForStall,
  similarity,
  estimateTokens,
} = await import("./burst.js");

// capture broadcast events instead of requiring a WS client
const events: Array<{ event: string; payload: any }> = [];

// monkey-patch broadcast recipients
import { addClient } from "../broadcast.js";
type FakeSock = { send: (s: string) => void; readyState: number };
let fakeSock: FakeSock | null = null;
before(() => {
  fakeSock = {
    readyState: 1,
    send: (s: string) => {
      try {
        const parsed = JSON.parse(s) as { event: string; payload: any };
        events.push({ event: parsed.event, payload: parsed.payload });
      } catch { /* ignore */ }
    },
  };
  addClient(fakeSock as any);
});
after(() => {
  fakeSock = null;
  events.length = 0;
});

function lastOf(event: string): any {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].event === event) return events[i].payload;
  return undefined;
}

// seed one self-talk room with two agents
function seedRoom(roomId: string): void {
  db.prepare(`INSERT OR IGNORE INTO agents (id, name, role, color, avatar, model, status, last_seen)
    VALUES ('atlas','Atlas','orchestrator','#000','A','m','online',0),
           ('forge','Forge','implementer','#111','F','m','idle',0)`).run();
  db.prepare(`INSERT OR REPLACE INTO rooms (id, name, topic, status, unread, last_activity, agent_ids, notes, created_at)
    VALUES (?, 't', 't', 'self-talk', 0, 0, '["atlas","forge"]', '', 0)`).run(roomId);
  db.prepare(`INSERT INTO messages (id, room_id, author_id, content, tags, timestamp)
    VALUES ('seed-1', ?, 'user', '请开始工作', '[]', 1)`).run(roomId);
}

function cleanupRoom(roomId: string): void {
  if (burstActive(roomId)) abortBurst(roomId, "aborted_by_user");
  db.prepare("DELETE FROM messages WHERE room_id = ?").run(roomId);
  db.prepare("DELETE FROM rooms WHERE id = ?").run(roomId);
}

describe("burst — similarity + estimator primitives", () => {
  it("normalizeForStall strips code blocks, punctuation and case", () => {
    const a = normalizeForStall("Hello, WORLD!!!");
    const b = normalizeForStall("hello world");
    assert.equal(a, b);
    // code churn alone is not progress
    const c1 = normalizeForStall("结果如下\n```js\nconst a = 111;\n```");
    const c2 = normalizeForStall("结果如下\n```js\nconst a = 999;\n```");
    assert.equal(similarity(c1, c2), 1);
  });

  it("similarity: identical → 1, disjoint → ~0", () => {
    assert.equal(similarity("abcdef", "abcdef"), 1);
    assert.ok(similarity("完全不同的话题一", "另一个毫不相干的内容") < 0.3);
  });

  it("estimateTokens: CJK≈1/char, ASCII≈1/4char", () => {
    assert.equal(estimateTokens("你好世界"), 4);
    assert.equal(estimateTokens("abcdefgh"), 2);
    assert.equal(estimateTokens("你好world1234"), 5); // 2 CJK + ceil(9/4)=3
    assert.equal(estimateTokens(""), 0);
  });
});

describe("burst — lifecycle + condition ② ([COMPLETE] / question-to-user)", () => {
  const roomId = "burst-complete";
  before(() => seedRoom(roomId));
  after(() => cleanupRoom(roomId));

  it("startBurst marks active and emits self_talk.start", () => {
    resetBursts();
    startBurst(roomId);
    assert.ok(burstActive(roomId));
    assert.equal(lastOf("self_talk.start")?.roomId, roomId);
    assert.equal(lastOf("self_talk.start")?.maxTurns, DEFAULT_BURST_CONFIG.maxTurns);
  });

  it("[COMPLETE] stops the burst with reason=complete", () => {
    const out = recordTurn(roomId, "forge", "全部完成。[COMPLETE]", 100);
    assert.deepEqual(out, {});
    assert.equal(burstActive(roomId), false);
    assert.equal(lastOf("self_talk.stop")?.reason, "complete");
    assert.equal(lastOf("self_talk.stop")?.turnCount, 1);
  });

  it("handoff with empty to[] also stops the burst", () => {
    startBurst(roomId);
    recordTurn(roomId, "atlas", `收尾。\n\n{"schemaVersion":"2.0","to":[]}`, 50);
    assert.equal(burstActive(roomId), false);
    assert.equal(lastOf("self_talk.stop")?.reason, "complete");
  });

  it("[QUESTION] without a handoff block pauses for the user", () => {
    startBurst(roomId);
    recordTurn(roomId, "forge", "[QUESTION] 需要确认：接口用 REST 还是 GraphQL？请回复。", 80);
    assert.equal(burstActive(roomId), false);
    assert.equal(lastOf("self_talk.stop")?.reason, "question_to_user");
  });

  it("[QUESTION] WITH a handoff block does NOT pause (agent-to-agent question)", () => {
    startBurst(roomId);
    recordTurn(roomId, "forge", `[QUESTION] schema 怎么定？\n\n\`\`\`handoff\n{"schemaVersion":"2.0","to":[{"name":"atlas"}]}\n\`\`\``, 80);
    // no pause: burst should still schedule the next tick
    assert.ok(burstActive(roomId));
    assert.ok(getState(roomId)!.turnCount >= 1);
  });
});

// helper to peek internal state through progress + turn semantics
import { getBurstState } from "./burst.js";
function getState(roomId: string) {
  return getBurstState(roomId);
}

describe("burst — condition ① max turns", () => {
  const roomId = "burst-turns";
  before(() => seedRoom(roomId));
  after(() => cleanupRoom(roomId));

  it("stops at maxTurns with reason=max_turns", () => {
    resetBursts();
    startBurst(roomId);
    const state = getState(roomId)!;
    // fast-forward: simulate (maxTurns-1) recorded turns with varied content
    // (each text mentions a distinct module so similarity stays low)
    for (let i = 1; i < DEFAULT_BURST_CONFIG.maxTurns; i++) {
      recordTurn(roomId, i % 2 ? "atlas" : "forge", `第 ${i} 轮实质进展：模块 alpha${i}beta 的设计与实现说明，涵盖接口约定、错误处理和测试策略等多个维度`, 1000);
      if (!burstActive(roomId)) break;
    }
    assert.ok(burstActive(roomId), "burst should survive up to maxTurns-1");
    assert.equal(state.turnCount, DEFAULT_BURST_CONFIG.maxTurns - 1);
    recordTurn(roomId, "forge", `最后一轮，第 ${DEFAULT_BURST_CONFIG.maxTurns} 轮 gamma 的实质性产出说明，包含收尾验证与文档更新`, 1000);
    assert.equal(burstActive(roomId), false);
    assert.equal(lastOf("self_talk.stop")?.reason, "max_turns");
    assert.equal(lastOf("self_talk.stop")?.turnCount, DEFAULT_BURST_CONFIG.maxTurns);
  });
});

describe("burst — condition ④ token budget", () => {
  const roomId = "burst-tokens";
  before(() => seedRoom(roomId));
  after(() => cleanupRoom(roomId));

  it("stops when cumulative tokens exceed maxTokens", () => {
    resetBursts();
    startBurst(roomId);
    // 2 turns × 3M tokens = 6M > 5M
    recordTurn(roomId, "atlas", "进展一：架构设计与模块划分的详细说明", 3_000_000);
    assert.ok(burstActive(roomId));
    recordTurn(roomId, "forge", "进展二：核心模块实现细节与测试结果说明", 3_000_000);
    assert.equal(burstActive(roomId), false);
    assert.equal(lastOf("self_talk.stop")?.reason, "budget_exhausted");
  });

  it("falls back to the text estimator when tokens=0", () => {
    resetBursts();
    startBurst(roomId);
    const state = getState(roomId)!;
    const before = state.tokenUsage;
    recordTurn(roomId, "atlas", "你好世界 hello world estimation check", 0);
    assert.ok(state.tokenUsage > before, "estimator fallback should add tokens");
    assert.equal(state.tokenUsage - before, estimateTokens("你好世界 hello world estimation check"));
  });
});

describe("burst — condition ③ stall detection + one-shot re-plan", () => {
  const roomId = "burst-stall";
  before(() => seedRoom(roomId));
  after(() => cleanupRoom(roomId));

  it("3 comparable stalled turns trigger ONE atlas re-plan; 3 more stop it", () => {
    resetBursts();
    startBurst(roomId);
    const near = "好的，继续推进当前事项，我会保持一致地总结当前状态并复述同样的计划安排和背景说明，确保语气与结构保持一致，同时维持原有内容，不做新增工作，感谢理解";
    // warm-up: substantive, unrelated → turn 1 can never stall
    const warm = recordTurn(roomId, "atlas", "开局：先梳理本次需求的边界与目标，明确对外的接口约定和可度量的验收标准，然后按照功能模块逐个拆分成可执行的任务清单", 100);
    assert.equal(warm.replan, undefined);
    // o2 compares against warm → sim 0.000 → no stall; o3..o5 compare against
    // near (sim 1.0) → 3 consecutive comparable stalls on o5
    recordTurn(roomId, "forge", near, 100);
    recordTurn(roomId, "atlas", near, 100);
    recordTurn(roomId, "forge", near, 100);
    const o5 = recordTurn(roomId, "forge", near, 100);
    assert.ok(o5.replan, "3rd comparable stalled turn should return a replan outcome");
    assert.ok(o5.replan!.prompt.includes("REPLAN"));
    assert.equal(lastOf("system.info")?.reason, "burst-replan");
    // after replan the counter restarts: 3 more stalled turns → hard stop
    recordTurn(roomId, "atlas", near, 100);
    recordTurn(roomId, "forge", near, 100);
    recordTurn(roomId, "atlas", near, 100);
    assert.equal(burstActive(roomId), false);
    assert.equal(lastOf("self_talk.stop")?.reason, "stalled_after_replan");
  });

  it("short empty turns (<50 normalized chars) count as stalls", () => {
    resetBursts();
    startBurst(roomId);
    recordTurn(roomId, "atlas", "好的。", 10);
    recordTurn(roomId, "forge", "收到。", 10);
    const o3 = recordTurn(roomId, "atlas", "继续。", 10);
    assert.ok(o3.replan, "3 short turns = 3 stalls");
  });

  it("real progress DECAYS the stall counter (Magentic-One semantics)", () => {
    resetBursts();
    startBurst(roomId);
    recordTurn(roomId, "atlas", "好的，继续推进当前事项，总结当前状态并复述计划安排与背景说明，保持结构一致", 10); // stall 1 (short)
    recordTurn(roomId, "forge", "收到，继续推进当前事项，总结当前状态并复述计划安排与背景说明，保持结构一致", 10); // stall 2 (short vs short: sim 1.0)
    // completely different, substantive content → stall counter decays by 1
    recordTurn(roomId, "atlas", "新决定：把存储层从文件改为 SQLite WAL 模式，理由是并发写入安全且事务语义完整，这改变了后续 forge 的实现路径", 200);
    assert.equal(getState(roomId)!.stallCount, 1); // max(0, 2-1) = 1
    // after progress the counter decays to 1; two more short stalls hit 3
    // → the one-shot replan fires on the SECOND short turn (counter resets)
    recordTurn(roomId, "forge", "又一条空转的简短回复，没有新增信息，仅确认状态", 10);
    const replanTurn = recordTurn(roomId, "atlas", "又一条空转的简短回复，没有新增信息，仅确认状态", 10);
    assert.ok(replanTurn.replan, "stalls reached 3 → replan fires (the one-shot)");
    assert.equal(lastOf("system.info")?.reason, "burst-replan");
    // replan spent: any 3 subsequent stalls → hard stop, no second replan
    recordTurn(roomId, "forge", "收到，继续推进当前事项，总结当前状态并复述计划安排与背景说明，保持结构一致", 10);
    recordTurn(roomId, "atlas", "收到，继续推进当前事项，总结当前状态并复述计划安排与背景说明，保持结构一致", 10);
    recordTurn(roomId, "forge", "收到，继续推进当前事项，总结当前状态并复述计划安排与背景说明，保持结构一致", 10);
    assert.equal(burstActive(roomId), false);
    assert.equal(lastOf("self_talk.stop")?.reason, "stalled_after_replan");
  });
});

describe("burst — user reset + manual tick on active room", () => {
  const roomId = "burst-user";
  before(() => seedRoom(roomId));
  after(() => cleanupRoom(roomId));

  it("abortBurst emits self_talk.stop with aborted_by_user (no system msg via stop)", () => {
    resetBursts();
    startBurst(roomId);
    assert.ok(burstActive(roomId));
    abortBurst(roomId);
    assert.equal(burstActive(roomId), false);
    assert.equal(lastOf("self_talk.stop")?.reason, "aborted_by_user");
  });

  it("recordTurn is a no-op when no burst is live (active-room manual tick)", () => {
    resetBursts();
    const before = events.length;
    const out = recordTurn(roomId, "atlas", "[COMPLETE] anything", 50);
    assert.deepEqual(out, {});
    assert.equal(events.length, before, "no stop/progress events without a live burst");
  });

  it("burstProgress exposes turn/token counters", () => {
    resetBursts();
    startBurst(roomId);
    recordTurn(roomId, "atlas", "一个有内容的进展说明，描述当前的实现状态", 1234);
    const p = burstProgress(roomId)!;
    assert.equal(p.turnCount, 1);
    assert.equal(p.maxTurns, DEFAULT_BURST_CONFIG.maxTurns);
    assert.ok(p.tokens >= 1234);
  });
});

describe("burst — room_no longer self-talk stops the chain", () => {
  const roomId = "burst-closed";
  before(() => seedRoom(roomId));
  after(() => cleanupRoom(roomId));

  it("stopBurst with room_closed cleans up", () => {
    resetBursts();
    startBurst(roomId);
    stopBurst(roomId, "room_closed");
    assert.equal(burstActive(roomId), false);
    assert.equal(lastOf("self_talk.stop")?.reason, "room_closed");
  });
});
