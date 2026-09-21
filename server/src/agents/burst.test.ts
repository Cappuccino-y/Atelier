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
  roomQuiet,
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
    startBurst(roomId, true);
    assert.ok(burstActive(roomId));
    assert.equal(lastOf("self_talk.start")?.roomId, roomId);
    assert.equal(lastOf("self_talk.start")?.maxTurns, DEFAULT_BURST_CONFIG.maxTurns);
  });

  it("[COMPLETE] stops the burst with reason=complete", () => {
    // latch from the previous test's stop clears only via user intent —
    // in-process tests simulate the user by resetting state
    resetBursts();
    startBurst(roomId, true);
    const out = recordTurn(roomId, "forge", "全部完成。[COMPLETE]", 100);
    assert.deepEqual(out, {});
    assert.equal(burstActive(roomId), false);
    assert.equal(lastOf("self_talk.stop")?.reason, "complete");
    assert.equal(lastOf("self_talk.stop")?.turnCount, 1);
  });

  it("handoff with empty to[] also stops the burst", () => {
    resetBursts();
    startBurst(roomId, true);
    recordTurn(roomId, "atlas", `收尾。\n\n{"schemaVersion":"2.0","to":[]}`, 50);
    assert.equal(burstActive(roomId), false);
    assert.equal(lastOf("self_talk.stop")?.reason, "complete");
  });

  it("[QUESTION] without a handoff block pauses for the user", () => {
    resetBursts();
    startBurst(roomId, true);
    recordTurn(roomId, "forge", "[QUESTION] 需要确认：接口用 REST 还是 GraphQL？请回复。", 80);
    assert.equal(burstActive(roomId), false);
    assert.equal(lastOf("self_talk.stop")?.reason, "question_to_user");
  });

  it("[QUESTION] WITH a handoff block does NOT pause (agent-to-agent question)", () => {
    resetBursts();
    startBurst(roomId, true);
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
    // fast-forward: (maxTurns-1) turns whose trigrams are genuinely disjoint
    // (distinct CJK phrase families per turn — template texts with only a
    // number changed ARE ~identical to trigrams and would misfire stall)
    const topics = [
      "数据库层改用 WAL 模式提升并发写入安全性",
      "前端路由增加懒加载减少首屏加载体积",
      "鉴权中间件补充令牌刷新与黑名单校验",
      "日志管道引入结构化字段便于检索聚合",
      "构建缓存策略调整缩短持续集成等待时间",
      "错误码表统一收敛避免各模块自行定义",
      "对象存储分片上传补充断点续速能力",
      "配置中心热更新增加版本回滚保护",
      "消息队列消费端加入幂等去重处理",
      "监控埋点覆盖关键路径补齐延迟指标",
      "文档站生成器迁移到新的静态框架",
      "接口网关增加请求体大小限制防护",
      "定时任务调度器支持分布式锁竞争",
      "测试覆盖率报告聚合到统一面板",
    ];
    // pad each topic to >50 normalized chars so the short-text stall rule
    // doesn't misfire — these turns are meant to exercise the TURN budget,
    // not stall detection
    for (let i = 1; i < DEFAULT_BURST_CONFIG.maxTurns; i++) {
      recordTurn(roomId, i % 2 ? "atlas" : "forge",
        `${topics[i % topics.length]}——本轮决定：接口约定采用显式版本号与向后兼容弃用策略，错误处理统一走结构化错误码，并配套补充对应的回归测试用例与文档说明（第 ${i} 批次）`,
        1000);
      if (!burstActive(roomId)) break;
    }
    assert.ok(burstActive(roomId), "burst should survive up to maxTurns-1");
    assert.equal(state.turnCount, DEFAULT_BURST_CONFIG.maxTurns - 1);
    recordTurn(roomId, "forge", `${topics[DEFAULT_BURST_CONFIG.maxTurns % topics.length]}——最后批次收尾验证：确认全部模块通过测试、文档已更新、无遗留风险项，准备结项`, 1000);
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
    startBurst(roomId, true);
    // 2 turns × 3M tokens = 6M > 5M
    recordTurn(roomId, "atlas", "进展一：架构设计与模块划分的详细说明", 3_000_000);
    assert.ok(burstActive(roomId));
    recordTurn(roomId, "forge", "进展二：核心模块实现细节与测试结果说明", 3_000_000);
    assert.equal(burstActive(roomId), false);
    assert.equal(lastOf("self_talk.stop")?.reason, "budget_exhausted");
  });

  it("falls back to the text estimator when tokens=0", () => {
    resetBursts();
    startBurst(roomId, true);
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
    startBurst(roomId, true);
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
    startBurst(roomId, true);
    recordTurn(roomId, "atlas", "好的。", 10);
    recordTurn(roomId, "forge", "收到。", 10);
    const o3 = recordTurn(roomId, "atlas", "继续。", 10);
    assert.ok(o3.replan, "3 short turns = 3 stalls");
  });

  it("real progress DECAYS the stall counter (Magentic-One semantics)", () => {
    resetBursts();
    startBurst(roomId, true);
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
    startBurst(roomId, true);
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
    startBurst(roomId, true);
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
    startBurst(roomId, true);
    stopBurst(roomId, "room_closed");
    assert.equal(burstActive(roomId), false);
    assert.equal(lastOf("self_talk.stop")?.reason, "room_closed");
  });
});

describe("burst — quiet latch (doom-loop guard from e2e-steer)", () => {
  const roomId = "burst-latch";
  before(() => seedRoom(roomId));
  after(() => cleanupRoom(roomId));

  it("[COMPLETE] stop latches the room; startBurst without userIntent is a no-op", () => {
    resetBursts();
    startBurst(roomId, true);
    recordTurn(roomId, "forge", "[COMPLETE] 完成", 100);
    assert.equal(burstActive(roomId), false);
    assert.ok(roomQuiet(roomId), "terminal stop must latch");
    // chain-end fallback calls startBurst WITHOUT userIntent → refused
    startBurst(roomId);
    assert.equal(burstActive(roomId), false, "latched room must NOT re-arm");
  });

  it("startBurst(userIntent=true) clears the latch and arms a fresh burst", () => {
    startBurst(roomId, true);
    assert.ok(burstActive(roomId));
    assert.equal(roomQuiet(roomId), false);
  });

  it("abortBurst (user spoke) also clears the latch", () => {
    resetBursts();
    startBurst(roomId, true);
    recordTurn(roomId, "atlas", "问题。[QUESTION] 等你回复", 100);
    assert.ok(roomQuiet(roomId));
    abortBurst(roomId);
    assert.equal(roomQuiet(roomId), false);
   });
});

describe("burst — terminal silence ends quietly instead of re-plan storms", () => {
  const roomId = "burst-silence";
  before(() => seedRoom(roomId));
  after(() => cleanupRoom(roomId));

  it("two consecutive terminal-silence replies stop the burst as complete", () => {
    resetBursts();
    startBurst(roomId, true);
    const o1 = recordTurn(roomId, "analyst", "（终态。零输出。）", 50);
    assert.equal(o1.replan, undefined);
    assert.ok(burstActive(roomId), "one silence: give another agent a chance");
    recordTurn(roomId, "archivist", "（静默 — 无未闭合工作）", 50);
    assert.equal(burstActive(roomId), false, "2 silences = workers agree: done");
    assert.equal(lastOf("self_talk.stop")?.reason, "complete");
    assert.ok(roomQuiet(roomId));
  });

  it("bare punctuation counts as terminal silence", () => {
    resetBursts();
    startBurst(roomId, true);
    recordTurn(roomId, "analyst", "。", 10);
    recordTurn(roomId, "archivist", "。", 10);
    assert.equal(burstActive(roomId), false);
  });
});

describe("burst — token estimator includes the prompt", () => {
  const roomId = "burst-prompt";
  before(() => seedRoom(roomId));
  after(() => cleanupRoom(roomId));

  it("recordTurn fallback counts prompt tokens (turn cost ≈ prompt + reply)", () => {
    resetBursts();
    startBurst(roomId, true);
    const state = getState(roomId)!;
    const longPrompt = "系统上下文与任务描述".repeat(200); // ~2000 CJK chars
    const reply = "收到";
    recordTurn(roomId, "atlas", reply, 0, longPrompt);
    assert.ok(state.tokenUsage >= estimateTokens(longPrompt), "prompt must be counted");
  });
});
