import { db } from "../db.js";
import { sendAll } from "../broadcast.js";

/**
 * Self-talk burst state machine.
 *
 * A "burst" is one bounded autonomous run: agents keep talking without user
 * input until a termination condition fires. Inspired by AutoGen's
 * TerminationCondition combinator family + Magentic-One's stall/re-plan loop:
 *
 *   1. MaxMessageTermination  — turnCount >= maxTurns (1 turn = 1 completed
 *      agent run; an atlas→forge→lens round-trip ≈ 3 turns)
 *   2. TextMentionTermination — [COMPLETE] tag (or handoff `to: []`) ends the
 *      burst; [QUESTION] addressed at the user PAUSES it (HandoffTermination
 *      "user" equivalent — user reply resumes with a fresh burst)
 *   3. Stall detection        — 3 consecutive low-novelty turns triggers ONE
 *      re-plan routed to atlas (Magentic-One max_stalls=3 → outer loop); if
 *      stalling continues after the re-plan turn, the burst stops.
 *   4. TokenUsageTermination  — cumulative tokens (real usage when the
 *      runtime reports it, estimator fallback otherwise); 80% soft limit
 *      ends the burst with a structured wrap-up.
 *
 * When a condition fires the burst stops with a deterministic system message
 * (no extra LLM call). A user message always resets/aborts the current burst
 * and starts a new one — this is the budget-reset lever.
 */

export type BurstConfig = {
  maxTurns: number;
  maxTokens: number;
  /** consecutive low-novelty turns before re-plan */
  maxStalls: number;
  /** trigram Jaccard similarity above this counts as "no new info" */
  stallSimilarity: number;
  /** delay before the chained next tick, ms (jittered) */
  tickDelayMs: number;
};

export const DEFAULT_BURST_CONFIG: BurstConfig = {
  maxTurns: 35,
  maxTokens: 5_000_000,
  maxStalls: 3,
  stallSimilarity: 0.85,
  tickDelayMs: 3000,
};

export type BurstStopReason =
  | "complete"
  | "max_turns"
  | "budget_exhausted"
  | "stalled_after_replan"
  | "question_to_user"
  | "aborted_by_user"
  | "no_agents"
  | "room_closed";

export type BurstState = {
  roomId: string;
  turnCount: number;
  tokenUsage: number;
  /** normalized trigram text of recent turns (for stall detection) */
  recentTexts: string[];
  /** consecutive low-novelty turns */
  stallCount: number;
  /** whether the one-shot re-plan has already been spent this burst */
  replanUsed: boolean;
  startedAt: number;
  lastAgentId: string | null;
  timer: ReturnType<typeof setTimeout> | null;
};

const bursts = new Map<string, BurstState>();

/** test hook — wipe all state */
export function resetBursts(): void {
  for (const b of bursts.values()) if (b.timer) clearTimeout(b.timer);
  bursts.clear();
}

export function getBurstState(roomId: string): BurstState | undefined {
  return bursts.get(roomId);
}

export function burstProgress(roomId: string): { turnCount: number; maxTurns: number; tokens: number; maxTokens: number } | null {
  const b = bursts.get(roomId);
  if (!b) return null;
  return { turnCount: b.turnCount, maxTurns: DEFAULT_BURST_CONFIG.maxTurns, tokens: b.tokenUsage, maxTokens: DEFAULT_BURST_CONFIG.maxTokens };
}

// ---------------------------------------------------------------------------
// text normalization + trigram Jaccard similarity (no LLM calls, deterministic)
// ---------------------------------------------------------------------------

export function normalizeForStall(text: string): string {
  return text
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, " ")      // code blocks: content churn ≠ progress
    .replace(/[\s\p{P}\p{S}]+/gu, " ")
    .trim();
}

function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < s.length - 2; i++) out.add(s.slice(i, i + 3));
  return out;
}

export function similarity(a: string, b: string): number {
  const A = trigrams(a);
  const B = trigrams(b);
  if (A.size === 0 && B.size === 0) return 1;
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

// ---------------------------------------------------------------------------
// token estimation fallback (CJK ≈ 1 token/char, ASCII ≈ 1 token / 4 chars)
// ---------------------------------------------------------------------------

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[\u3400-\u9FBF\u3040-\u30FF\uAC00-\uD7AF]/g) ?? []).length;
  const rest = text.length - cjk;
  return cjk + Math.ceil(rest / 4);
}

// ---------------------------------------------------------------------------
// burst lifecycle
// ---------------------------------------------------------------------------

function systemMessage(roomId: string, content: string): void {
  const id = `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    `INSERT INTO messages (id, room_id, author_id, content, tags, timestamp) VALUES (?, ?, 'system', ?, '[]', ?)`
  ).run(id, roomId, content, Date.now());
  sendAll("message.created", { id, roomId, authorId: "system", content, timestamp: Date.now() });
}

function roomStatus(roomId: string): string | null {
  const row = db.prepare("SELECT status FROM rooms WHERE id = ?").get(roomId) as { status: string } | undefined;
  return row?.status ?? null;
}

function roomAgents(roomId: string): string[] {
  const row = db.prepare("SELECT agent_ids FROM rooms WHERE id = ?").get(roomId) as { agent_ids: string } | undefined;
  return row ? (JSON.parse(row.agent_ids || "[]") as string[]) : [];
}

function nextSpeaker(roomId: string, excludeAgentId: string | null): string | null {
  const agents = roomAgents(roomId).filter((a) => a !== "user");
  if (agents.length === 0) return null;
  if (agents.length === 1) return agents[0];
  // round-robin-ish: pick next agent after the last speaker (SelectorGroupChat
  // default forbids consecutive repeats; with ≥2 agents that's always possible)
  const others = agents.filter((a) => a !== excludeAgentId);
  const pool = others.length > 0 ? others : agents;
  return pool[0];
}

/** delay a chained tick with jitter so parallel rooms don't sync */
function jitter(ms: number): number {
  return Math.max(800, Math.round(ms * (0.8 + Math.random() * 0.4)));
}

function scheduleNext(roomId: string, state: BurstState): void {
  if (state.timer) clearTimeout(state.timer);
  const fromAgent = state.lastAgentId;
  state.timer = setTimeout(() => {
    state.timer = null;
    if (bursts.get(roomId) !== state) return;
    const target = nextSpeaker(roomId, fromAgent);
    if (!target) { stopBurst(roomId, "no_agents"); return; }
    if (roomStatus(roomId) !== "self-talk") { stopBurst(roomId, "room_closed"); return; }
    const agents = roomAgents(roomId);
    const agentId = agents.includes(target) ? target : agents.find((a) => a !== "user");
    if (!agentId) { stopBurst(roomId, "no_agents"); return; }
    const agentRow = db.prepare("SELECT id, name FROM agents WHERE id = ?").get(agentId) as { id: string; name: string } | undefined;
    if (!agentRow) { stopBurst(roomId, "no_agents"); return; }
    // pull the latest message as continuation prompt (same as triggerOnSelfTalkTick)
    const last = db.prepare("SELECT author_id, content FROM messages WHERE room_id = ? ORDER BY timestamp DESC LIMIT 1").get(roomId) as { author_id: string; content: string } | undefined;
    if (!last) { stopBurst(roomId, "room_closed"); return; }
    sendAll("self_talk.tick", { roomId, agentId: agentRow.id, timestamp: Date.now() });
    void chainTick(roomId, agentRow.id, `${last.content}\n\n(self-talk tick — continue the conversation)`);
  }, jitter(DEFAULT_BURST_CONFIG.tickDelayMs));
}

/** the actual chained invocation — implemented by triggers.ts to avoid a cycle */
let chainTick: (roomId: string, agentId: string, prompt: string) => Promise<void> = async () => {};
export function registerChainTick(fn: (roomId: string, agentId: string, prompt: string) => Promise<void>): void {
  chainTick = fn;
}

// ---------------------------------------------------------------------------
// public control API
// ---------------------------------------------------------------------------

/** start (or restart) a burst — called when user opts into self-talk / replies */
export function startBurst(roomId: string): void {
  const prev = bursts.get(roomId);
  if (prev?.timer) clearTimeout(prev.timer);
  const state: BurstState = {
    roomId,
    turnCount: 0,
    tokenUsage: 0,
    recentTexts: [],
    stallCount: 0,
    replanUsed: false,
    startedAt: Date.now(),
    lastAgentId: null,
    timer: null,
  };
  bursts.set(roomId, state);
  sendAll("self_talk.start", { roomId, maxTurns: DEFAULT_BURST_CONFIG.maxTurns, maxTokens: DEFAULT_BURST_CONFIG.maxTokens, timestamp: Date.now() });
  // first tick fires quickly
  scheduleNext(roomId, state);
}

/** user spoke — the in-flight burst budget resets; a fresh burst begins */
export function abortBurst(roomId: string, reason: BurstStopReason = "aborted_by_user"): void {
  const prev = bursts.get(roomId);
  if (!prev) return;
  if (prev.timer) clearTimeout(prev.timer);
  bursts.delete(roomId);
  sendAll("self_talk.stop", { roomId, reason, turnCount: prev.turnCount, tokenUsage: prev.tokenUsage, elapsedMs: Date.now() - prev.startedAt, timestamp: Date.now() });
}

/** true when a burst is live for the room */
export function burstActive(roomId: string): boolean {
  return bursts.has(roomId);
}

// ---------------------------------------------------------------------------
// evaluation — called by triggers.ts after EVERY completed agent turn
// ---------------------------------------------------------------------------

export type TurnOutcome = {
  /** route a re-plan prompt to atlas instead of the normal next speaker */
  replan?: { prompt: string };
};

/**
 * Record one completed agent turn and decide: continue / re-plan / stop.
 * Returns the outcome; triggers.ts applies side effects (chained tick,
 * re-plan routing) — burst.ts owns counting + the stop decision only.
 */
export function recordTurn(
  roomId: string,
  agentId: string,
  content: string,
  tokens: number,
): TurnOutcome {
  const state = bursts.get(roomId);
  // no live burst (e.g. manual one-shot tick with room active): nothing to do
  if (!state) return {};

  state.turnCount += 1;
  state.tokenUsage += tokens > 0 ? tokens : estimateTokens(content);
  state.lastAgentId = agentId;

  const norm = normalizeForStall(content);
  const tags: string[] = content.match(/\[(COMPLETE|QUESTION|RESULT|REVIEW|DECISION|STATUS|TODO|BLOCKER|RESEARCH|ANALYSIS|DOCUMENT|VISUAL|MEMORY)\]/g) ?? [];
  const handoffToEmpty = /\{\s*"schemaVersion"[\s\S]*"to"\s*:\s*\[\s*\]/.test(content);
  const questionToUser = tags.includes("[QUESTION]") && !/```handoff|\{\s*"schemaVersion"/.test(content);

  // ---- condition ②: completion / handoff-to-user -------------------------
  if (tags.includes("[COMPLETE]") || handoffToEmpty) {
    stopBurst(roomId, "complete");
    return {};
  }
  if (questionToUser) {
    stopBurst(roomId, "question_to_user");
    return {};
  }

  // ---- condition ①: turn budget ------------------------------------------
  if (state.turnCount >= DEFAULT_BURST_CONFIG.maxTurns) {
    stopBurst(roomId, "max_turns");
    return {};
  }

  // ---- condition ④: token budget (soft at 80% → structured wrap-up stop) --
  if (state.tokenUsage >= DEFAULT_BURST_CONFIG.maxTokens) {
    stopBurst(roomId, "budget_exhausted");
    return {};
  }

  // ---- condition ③: stall detection with one-shot re-plan -----------------
  const texts = state.recentTexts;
  const stalledNow =
    (texts.length >= 1 && similarity(norm, texts[texts.length - 1]) > DEFAULT_BURST_CONFIG.stallSimilarity) ||
    norm.length < 50;
  state.recentTexts.push(norm);
  if (state.recentTexts.length > 3) state.recentTexts.shift();

  if (stalledNow) state.stallCount += 1;
  else state.stallCount = Math.max(0, state.stallCount - 1);

  if (state.stallCount >= DEFAULT_BURST_CONFIG.maxStalls) {
    if (!state.replanUsed) {
      // Magentic-One outer loop: ONE re-plan, routed to atlas
      state.replanUsed = true;
      state.stallCount = 0;
      sendAll("system.info", { roomId, reason: "burst-replan", agentId: "atlas", turnCount: state.turnCount, timestamp: Date.now() });
      const replanPrompt = [
        "[REPLAN] Self-talk 检测到连续无进展（多轮相似/空转）。请不要转发原返工指令，",
        "重新评估当前拆解与计划：换一种推进方式（如先补测试桩、调整任务粒度、或明确收尾标准），",
        "然后发出新的 handoff。若认为任务实际已收敛，请输出 [COMPLETE]。",
      ].join("");
      systemMessage(roomId, `🔄 Self-talk 停滞 ${DEFAULT_BURST_CONFIG.maxStalls} 轮 — 已触发 atlas 重规划（第 1/1 次）`);
      return { replan: { prompt: replanPrompt } };
    }
    stopBurst(roomId, "stalled_after_replan");
    return {};
  }

  // ---- continue: schedule the chained next tick ---------------------------
  scheduleNext(roomId, state);
  return {};
}

// ---------------------------------------------------------------------------
// stop + structured wrap-up (deterministic, no LLM call)
// ---------------------------------------------------------------------------

export function stopBurst(roomId: string, reason: BurstStopReason): void {
  const state = bursts.get(roomId);
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  bursts.delete(roomId);
  if (reason !== "aborted_by_user") {
    sendAll("self_talk.stop", {
      roomId, reason,
      turnCount: state.turnCount, tokenUsage: state.tokenUsage,
      elapsedMs: Date.now() - state.startedAt, timestamp: Date.now(),
    });
  }
  const spent = `${state.turnCount} 轮 · ~${(state.tokenUsage / 1000).toFixed(0)}k tokens · ${Math.round((Date.now() - state.startedAt) / 60000)} 分钟`;
  const reasons: Record<BurstStopReason, string> = {
    complete: "✅ Agent 已输出 [COMPLETE]，任务闭环",
    max_turns: `⏸ 达到 ${DEFAULT_BURST_CONFIG.maxTurns} 轮上限`,
    budget_exhausted: `⏸ 达到 token 预算（${(DEFAULT_BURST_CONFIG.maxTokens / 1e6).toFixed(1)}M）`,
    stalled_after_replan: `🔄 停滞 ${DEFAULT_BURST_CONFIG.maxStalls} 轮，重规划后仍未收敛`,
    question_to_user: "❓ Agent 有问题需要你回答",
    aborted_by_user: "⏹ 你插话了，burst 已重置",
    no_agents: "⚠️ 房间里没有可发言的 agent",
    room_closed: "房间已退出 self-talk 模式",
  };
  const options: Record<BurstStopReason, string> = {
    complete: "直接说「继续」可开启新一轮；或给 forge/lens 布置下一步。",
    max_turns: "回复「继续」开启新 burst（35 轮）；或让 atlas 收尾；或直接回答最后的问题。",
    budget_exhausted: "回复「继续」开启新 burst（预算重置）；或让 atlas 收尾。",
    stalled_after_replan: "回复「继续」重试；或亲自给出方向性指示。",
    question_to_user: "回答上面的问题即可继续。",
    aborted_by_user: "你的消息已成为新 burst 的起点。",
    no_agents: "先把 agent 拉进房间（Room settings）。",
    room_closed: "重新开启 Self-Talk 可恢复。",
  };
  systemMessage(roomId, `${reasons[reason]}\n\nSelf-talk 已暂停 — 本次：${spent}\n${options[reason]}`);
}
