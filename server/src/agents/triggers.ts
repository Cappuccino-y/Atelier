import { db } from "../db.js";
import { sendAll } from "../broadcast.js";
import { invokeAgent, persistAgentMemory } from "./runtime.js";
import {
  parseHandoff,
  diagnoseHandoffFailure,
  stripHandoffBlock,
  extractAllTags,
  validateOutputAgainstSchema,
  validateOutputAgainstSchemaDetailed,
  formatHandoffTaskTrailer,
  type HandoffDirectiveV2,
  type AgentLocator,
  type OutputSchema,
} from "./handoff.js";
import { buildEchoFallback } from "./implicit-handoff.js";
import { decideRetry, sleep } from "./retry.js";
import { nanoid } from "nanoid";
import { debugLog } from "./debug.js";

const MENTION_RE = /(?<![\w.@])@(!?)([\w一-鿿]+)/g;
const MAX_HANDOFF_DEPTH = 10;
const FLOOD_WINDOW = 10;
const FLOOD_THRESHOLD = 5;
const MAX_PARALLEL_AGENTS = 4;

/** Global concurrency cap: at most this many opencode processes run at once
 *  across ALL rooms. Excess invocations wait in a FIFO queue instead of
 *  spawning unbounded LLM runs. */
const MAX_GLOBAL_CONCURRENCY = 4;
let globalRunning = 0;
const globalWaiters: Array<() => void> = [];
async function withGlobalSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (globalRunning < MAX_GLOBAL_CONCURRENCY) {
    globalRunning++;
    try {
      return await fn();
    } finally {
      globalRunning--;
      const next = globalWaiters.shift();
      if (next) next();
    }
  }
  await new Promise<void>((resolve) => globalWaiters.push(resolve));
  return withGlobalSlot(fn);
}

/** traceId → retry attempt count (0-indexed). Persists across retry hops so
 *  decideRetry sees a real attempt number instead of a hardcoded 0. */
const retryAttempts = new Map<string, number>();
function bumpRetryAttempt(traceId: string | undefined): number {
  if (!traceId) return 0;
  const next = (retryAttempts.get(traceId) ?? 0) + 1;
  retryAttempts.set(traceId, next);
  return next;
}

/** traceId → accumulated wall-clock across retries. Lets decideRetry's 30s
 *  budget actually count the whole chain instead of one run. */
const retryElapsed = new Map<string, number>();
function retryElapsedMs(traceId: string | undefined, startedAt: number): number {
  const acc = traceId ? (retryElapsed.get(traceId) ?? 0) : 0;
  const total = acc + (Date.now() - startedAt);
  if (traceId) retryElapsed.set(traceId, total);
  return total;
}

type AgentRow = { id: string; name: string };
const agentCache = new Map<string, AgentRow>();

function getAgentByName(name: string): AgentRow | null {
  const key = name.toLowerCase();
  if (agentCache.has(key)) return agentCache.get(key)!;
  const row = db.prepare("SELECT id, name FROM agents WHERE LOWER(name) = ?").get(key) as AgentRow | undefined;
  if (row) agentCache.set(key, row);
  return row ?? null;
}

function getAgentById(id: string): AgentRow | null {
  const row = db.prepare("SELECT id, name FROM agents WHERE id = ?").get(id) as AgentRow | undefined;
  return row ?? null;
}

/**
 * Add agent ids to a room's roster (idempotent) and broadcast the update so
 * the Agents panel reflects everyone who actually worked in the room — not
 * just the ones seeded at creation. Also flips the agents table status to
 * "online" since a real invocation just happened (seeded statuses are stale).
 */
function ensureAgentsInRoom(roomId: string, agentIds: string[]): void {
  if (!roomId || agentIds.length === 0) return;
  let changed = false;
  try {
    const row = db.prepare("SELECT agent_ids FROM rooms WHERE id = ?").get(roomId) as { agent_ids: string } | undefined;
    if (!row) return;
    const ids: string[] = JSON.parse(row.agent_ids || "[]");
    for (const id of agentIds) {
      if (!ids.includes(id)) {
        ids.push(id);
        changed = true;
      }
    }
    if (changed) {
      db.prepare("UPDATE rooms SET agent_ids = ? WHERE id = ?").run(JSON.stringify(ids), roomId);
      sendAll("room.updated", { id: roomId, agentIds: ids });
    }
  } catch (err) {
    debugLog("ensure-members", roomId, undefined, "failed to update room roster", { error: String(err) });
  }
}

/** Mark an agent online/offline in the agents table + broadcast status. */
function setAgentStatus(agentId: string, status: string): void {
  try {
    db.prepare("UPDATE agents SET status = ?, last_seen = ? WHERE id = ?").run(status, Date.now(), agentId);
    const row = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as any;
    if (row) sendAll("agent.status", { id: row.id, name: row.name, role: row.role, color: row.color, avatar: row.avatar, model: row.model, status: row.status, lastSeen: row.last_seen });
  } catch (err) {
    debugLog("agent-status", undefined, agentId, "failed to update status", { error: String(err) });
  }
}

/**
 * Adapter so handoff.parseHandoff() can use our DB lookup without
 * pulling in a circular dependency.
 */
const agentLocator: AgentLocator = (raw: string) => {
  return getAgentByName(raw) ?? getAgentById(raw);
};

export function extractMentions(content: string): Array<{ name: string; id: string }> {
  const out: Array<{ name: string; id: string }> = [];
  const seen = new Set<string>();
  for (const m of content.matchAll(MENTION_RE)) {
    const name = m[2];
    const agent = getAgentByName(name);
    if (agent && !seen.has(agent.id)) {
      out.push({ name: agent.name, id: agent.id });
      seen.add(agent.id);
    }
  }
  return out;
}

/**
 * Strip the ```handoff ... ``` block from content for display. Routing
 * metadata should not pollute the prose the user reads. (Re-export from
 * handoff module to keep the public API stable for downstream callers.)
 */
export function stripHandoff(content: string): string {
  return stripHandoffBlock(content);
}

/**
 * Tags recognized as first-class UI shapes. Tags are display-only — they
 * never trigger routing. Only the structured ```handoff``` block drives
 * routing (see triggerOnMessage comment).
 *
 * v2 expanded set: adds [RESEARCH] [ANALYSIS] [DOCUMENT] [VISUAL] [MEMORY]
 * on top of the original [DECISION] [TODO] [STATUS] [RESULT] [REVIEW]
 * [QUESTION] [BLOCKER].
 */
export function extractTags(content: string): string[] {
  return extractAllTags(content);
}

const runningAgents = new Set<string>();
const agentQueues = new Map<string, Array<() => Promise<void>>>();

/**
 * Fan-in barrier state for parallel fan-out groups (LangGraph Send + fan-in
 * pattern). When an agent dispatches to 2+ targets (multi-target `to`), a
 * group is registered keyed by traceId. Each worker that hands back to the
 * ORIGINATOR (the agent that fanned out) is held — its result is recorded
 * but NOT routed — until EVERY worker in the group has finished, at which
 * point ONE aggregate routing to the originator fires. This prevents the
 * observed bug: N workers each handoff back to Atlas → Atlas is summoned
 * N times for the same "wrap-up", producing duplicate summary runs.
 *
 * Workers that hand off to a DIFFERENT agent (not the originator) are not
 * held — they route normally. Workers that end without a handoff also
 * count as completed (they just contribute no held handoff).
 */
type FanOutGroup = {
  traceId: string;
  roomId: string;
  originator: string;
  targets: Set<string>;
  completed: Set<string>;
  /** Held handoff to the originator from the FIRST completed worker (its
   *  summary task becomes the aggregate's taskSummary). */
  heldHandoff: HandoffDirectiveV2 | null;
  results: Array<{ agent: string; content: string }>;
  fired: boolean;
  createdAt: number;
};
const fanOutGroups = new Map<string, FanOutGroup>();
const FAN_OUT_TTL_MS = 10 * 60 * 1000; // 10 min safety net against leaks

function registerFanOutGroup(traceId: string, roomId: string, originator: string, targets: string[]) {
  if (targets.length < 2) return;
  const existing = fanOutGroups.get(traceId);
  if (existing) return;
  fanOutGroups.set(traceId, {
    traceId,
    roomId,
    originator,
    targets: new Set(targets),
    completed: new Set(),
    heldHandoff: null,
    results: [],
    fired: false,
    createdAt: Date.now(),
  });
  // Opportunistic cleanup of stale groups.
  for (const [k, g] of fanOutGroups) {
    if (Date.now() - g.createdAt > FAN_OUT_TTL_MS && !g.fired) fanOutGroups.delete(k);
  }
}

/**
 * Record a worker's completion against its fan-out group. Returns:
 *   - { status: "fired", directive } — barrier released, route the aggregate
 *     wrap-up NOW.
 *   - { status: "held" } — worker's handoff was absorbed into the group;
 *     do NOT route it (the originator gets one summary when ALL workers are
 *     done).
 *   - { status: "none" } — no fan-out group applies; route normally.
 */
function fanOutOnWorkerDone(opts: {
  traceId: string;
  roomId: string;
  worker: string;
  content: string;
  handoff: HandoffDirectiveV2 | null;
}): { status: "fired" | "held" | "none"; directive?: HandoffDirectiveV2 } {
  const group = fanOutGroups.get(opts.traceId);
  if (!group || group.fired) return { status: "none" };
  if (!group.targets.has(opts.worker)) return { status: "none" };

  group.completed.add(opts.worker);
  group.results.push({ agent: opts.worker, content: opts.content });

  // If this worker handed back to the ORIGINATOR, hold the handoff until
  // the whole group completes — don't summon the originator yet.
  const handoffToOriginator = opts.handoff && opts.handoff.to.some((t) => t.id === group.originator);
  if (handoffToOriginator && !group.heldHandoff) {
    group.heldHandoff = opts.handoff;
  }

  const allDone = [...group.targets].every((t) => group.completed.has(t));
  if (!allDone) return { status: "held" };

  // Barrier released — fire ONE aggregate handoff to the originator.
  group.fired = true;
  fanOutGroups.delete(opts.traceId);
  if (!group.heldHandoff) return { status: "held" }; // nobody asked to wrap up — nothing to route

  const workerSummary = group.results
    .map((r) => `[${r.agent}]: ${r.content.slice(0, 400).replace(/\n/g, " ")}`)
    .join("\n");
  return {
    status: "fired",
    directive: {
      ...group.heldHandoff,
      taskSummary: `${group.heldHandoff.taskSummary}\n\n[fan-in 聚合 — 全部 ${group.targets.size} 个 worker 已完成]\n${workerSummary}`,
    },
  };
}

function queueKey(roomId: string, agentId: string): string {
  return `${roomId}:${agentId}`;
}

function drainQueue(roomId: string, agentId: string) {
  const key = queueKey(roomId, agentId);
  const q = agentQueues.get(key);
  if (!q || q.length === 0) {
    runningAgents.delete(key);
    // Agent may still be running in ANOTHER room — only mark idle when no
    // (room, agent) slot is active anywhere.
    const stillBusy = [...runningAgents.keys()].some((k) => k !== key && k.endsWith(`:${agentId}`));
    if (!stillBusy) setAgentStatus(agentId, "idle");
    return;
  }
  const next = q.shift()!;
  void next();
}

export function isAgentFlooding(roomId: string, agentId: string): boolean {
  const rows = db.prepare(`
    SELECT author_id FROM messages
    WHERE room_id = ? ORDER BY timestamp DESC LIMIT ?
  `).all(roomId, FLOOD_WINDOW) as Array<{ author_id: string }>;
  const count = rows.filter((r) => r.author_id === agentId).length;
  return count >= FLOOD_THRESHOLD;
}

export function isAgentRunning(roomId: string, agentId: string): boolean {
  return runningAgents.has(queueKey(roomId, agentId));
}

type TriggerParams = {
  roomId: string;
  authorId: string;
  content: string;
  parentMessageId?: string;
  source?: "user" | "agent" | "self-talk";
  /**
   * Explicit routing targets from a parsed handoff v2 block. Required for
   * agent→agent routing. When omitted, agent replies do NOT trigger
   * anything (prose @mentions are descriptive only — see triggerOnMessage
   * comment for industry rationale).
   */
  handoff?: HandoffDirectiveV2;
};

/**
 * Routes a message to the next agent(s).
 *
 * Two legitimate routing sources:
 *  - USER message: @mention in the text triggers the named agents
 *  - AGENT reply: a v2 ```handoff``` JSON block (schemaVersion "2.0", one
 *    or more per reply for parallel fan-out) with explicit "to" triggers;
 *    prose @mentions are descriptive and ignored
 *
 * Anything else (prose mentions in agent replies, magic tags) does NOT route.
 * Industry consensus (OpenAI Agents SDK, LangGraph Command(goto=), AutoGen
 * HandoffMessage, SW4RM, Google A2A protocol) — routing must be a
 * structured signal, not parsed from natural language. Parsing prose is
 * fragile and causes false positives.
 */
export async function triggerOnMessage(params: TriggerParams): Promise<void> {
  let targets: Array<{ id: string; name: string }> = [];

  if (params.authorId === "user") {
    // User messages: parse @mentions from text. Simple, unambiguous.
    targets = extractMentions(params.content);
    debugLog("trigger", params.roomId, "user", "user message routed", {
      mentions: targets.map((t) => t.id),
      contentHead: params.content.slice(0, 200),
    });
  } else if (params.handoff && params.handoff.to.length > 0) {
    // Agent→agent: only the structured handoff block drives routing.
    targets = params.handoff.to;
    debugLog("trigger", params.roomId, params.authorId, "agent handoff routed", {
      to: params.handoff.to.map((t) => t.id),
      traceId: params.handoff.traceId,
      taskSummary: params.handoff.taskSummary,
    });
  } else {
    // No legitimate routing source — drop it.
    debugLog("trigger", params.roomId, params.authorId, "reply dropped — no handoff block", {
      contentHead: params.content.slice(0, 200),
      contentLen: params.content.length,
    });
    return;
  }

  // Drop self-mentions (an agent handing off to itself is a no-op).
  targets = targets.filter((m) => m.id !== params.authorId);
  debugLog("trigger", params.roomId, params.authorId, "targets after self-mention filter", {
    targets: targets.map((t) => t.id),
    authorId: params.authorId,
  });

  // Depth guard: real handoff-chain depth (walk parent pointers), not a
  // room-message-count heuristic — parallel traffic in a room must not
  // trip the cap.
  const depth = chainDepth(params.parentMessageId);
  debugLog("trigger", params.roomId, params.authorId, "chain depth", { depth, max: MAX_HANDOFF_DEPTH, parentMessageId: params.parentMessageId });
  if (depth > MAX_HANDOFF_DEPTH) {
    debugLog("trigger", params.roomId, params.authorId, "depth cap hit — routing dropped", { depth });
    sendAll("system.warning", { roomId: params.roomId, reason: "depth-cap", depth });
    return;
  }

  if (targets.length === 0) return;

  // Any agent actually invoked in this room (user @mention OR handoff target)
  // becomes a member — otherwise the Agents panel never shows agents that
  // arrived via handoff (room.agent_ids is only seeded at creation/invite).
  ensureAgentsInRoom(params.roomId, targets.map((t) => t.id));

  // Fan-out: invoke all targets in parallel (Promise.allSettled so a single
  // failure doesn't abort the others). Each agent maintains its own
  // (room, agentId) running slot — the same agent is queued, not duplicated.
  //
  // Industry consensus: LangGraph's Send API, OpenAI Swarm/Agents SDK's
  // asyncio.gather / Promise.all, CrewAI's Process.parallel — all default to
  // parallel fan-out. The trade-off is N× tokens + potential rate-limit
  // storms; we cap with MAX_PARALLEL_AGENTS below.
  //
  // SEMANTIC CONTRACT: a multi-target `to` array is ALWAYS parallel — there
  // is no ordering between the targets. Sequential intent must be expressed
  // as single-target hops (A → B → C), where the receiver emits its own
  // handoff for the next hop. Broadcast the fan-out for observability so a
  // mistaken multi-target "sequential" handoff is visible in the logs/UI
  // instead of silently misbehaving.
  if (params.handoff && params.handoff.to.length > 1) {
    sendAll("system.info", {
      roomId: params.roomId,
      reason: "parallel-fanout",
      from: params.authorId,
      targets: params.handoff.to.map((t) => t.id),
      traceId: params.handoff.traceId,
      note: "multi-target handoff — dispatched in parallel (no ordering)",
      timestamp: Date.now(),
    });
    // Fan-in barrier: remember this fan-out so worker handoffs back to the
    // originator are coalesced into a single wrap-up (see fanOutOnWorkerDone).
    registerFanOutGroup(params.handoff.traceId, params.roomId, params.authorId, params.handoff.to.map((t) => t.id));
  }
  const filtered = targets
    .slice(0, MAX_PARALLEL_AGENTS);
  if (filtered.length < targets.length) {
    sendAll("system.warning", {
      roomId: params.roomId,
      reason: "concurrency-cap",
      requested: targets.length,
      invoked: filtered.length,
    });
  }

  // Per-target trailer + directive: each fanned-out agent sees its OWN
  // taskSummary and requiredOutputSchema (per-target overrides the shared
  // ones) — the directive passed to invokeAgentAsync must also be the
  // per-target copy, because the worker's completion is validated against
  // ITS handoff.requiredOutputSchema. Sharing the top-level schema across
  // different-artifact workers (Forge: result_block / Lens: review_block /
  // Scout: research_brief) wrongly fails everyone except the first.
  const perTargetDirective = (m: { id: string }): HandoffDirectiveV2 | undefined => {
    if (!params.handoff) return undefined;
    const target = params.handoff.to.find((t) => t.id === m.id);
    if (!target) return params.handoff;
    if (!target.taskSummary && !target.requiredOutputSchema) return params.handoff;
    return {
      ...params.handoff,
      taskSummary: target.taskSummary ?? params.handoff.taskSummary,
      requiredOutputSchema: target.requiredOutputSchema ?? params.handoff.requiredOutputSchema,
    };
  };
  const promptFor = (m: { id: string }): string => {
    if (!params.handoff) return params.content;
    const directive = perTargetDirective(m);
    if (!directive) return params.content;
    const trailer = formatHandoffTaskTrailer(directive);
    return trailer ? `${params.content}\n\n${trailer}` : params.content;
  };

  await Promise.allSettled(
    filtered.map((m) =>
      invokeAgentAsync({
        roomId: params.roomId,
        agentId: m.id,
        prompt: promptFor(m),
        parentMessageId: params.parentMessageId,
        source: params.source,
        handoff: perTargetDirective(m),
      })
    )
  );
}

/**
 * Real handoff-chain depth: walk the parent chain from the message being
 * routed, counting consecutive agent-authored hops. Unlike the old
 * message-count heuristic, this is unaffected by parallel traffic in the
 * room — two independent chains running at once can't push each other
 * over the cap. Bounded by the visited set so malformed parent pointers
 * can't loop forever.
 */
function chainDepth(parentMessageId: string | undefined): number {
  let depth = 0;
  let current = parentMessageId ?? null;
  const visited = new Set<string>();
  while (current && !visited.has(current)) {
    visited.add(current);
    const row = db.prepare(`
      SELECT author_id, parent_id FROM messages WHERE id = ?
    `).get(current) as { author_id: string; parent_id: string | null } | undefined;
    if (!row) break;
    if (row.author_id !== "user") depth++;
    current = row.parent_id;
  }
  return depth;
}

async function invokeAgentAsync(opts: {
  roomId: string;
  agentId: string;
  prompt: string;
  parentMessageId?: string;
  source?: "user" | "agent" | "self-talk";
  signal?: AbortSignal;
  handoff?: HandoffDirectiveV2;
}): Promise<void> {
  const key = queueKey(opts.roomId, opts.agentId);
  const runId = nanoid();

  const task = async () => {
    runningAgents.add(key);
    setAgentStatus(opts.agentId, "online");
    const startedAt = Date.now();
    const ts = () => Date.now();

    try {
      sendAll("agent.thinking", {
        roomId: opts.roomId,
        agentId: opts.agentId,
        runId,
        message: "Reading room context…",
        timestamp: ts(),
      });
      const result = await withGlobalSlot(() =>
        invokeAgent({
          agentId: opts.agentId,
          roomId: opts.roomId,
          prompt: opts.prompt,
          signal: opts.signal,
          runId,
          onEvent: (event) => {
          switch (event.type) {
            case "text_delta":
              sendAll("agent.text_delta", {
                roomId: opts.roomId,
                agentId: opts.agentId,
                runId,
                delta: event.delta,
                timestamp: ts(),
              });
              break;
            case "tool_use":
              sendAll("agent.tool_call", {
                roomId: opts.roomId,
                agentId: opts.agentId,
                runId,
                tool: event.tool,
                input: event.input,
                timestamp: ts(),
              });
              break;
            case "step_start":
              sendAll("agent.thinking", {
                roomId: opts.roomId,
                agentId: opts.agentId,
                runId,
                message: event.step,
                timestamp: ts(),
              });
              break;
            case "step_finish":
              sendAll("agent.step_done", {
                roomId: opts.roomId,
                agentId: opts.agentId,
                runId,
                reason: event.reason,
                timestamp: ts(),
              });
              break;
            case "error":
              sendAll("agent.error", {
                roomId: opts.roomId,
                agentId: opts.agentId,
                runId,
                error: event.message,
                timestamp: ts(),
              });
              break;
          }
        },
        })
      );

      const id = nanoid();
      const finishedAt = ts();
      const tags = extractTags(result.content);
      const cancelled = Boolean(result.cancelled);
      const runFailed = !result.success && !result.cancelled;
      if (runFailed) {
        debugLog("run-failed", opts.roomId, opts.agentId, "opencode run failed", {
          error: result.error,
          contentLen: result.content.length,
          contentHead: result.content.slice(0, 300),
        });
      }

      // Routing targets come from the structured ```handoff``` block — see
      // parseHandoff. EXACTLY ONE handoff object per reply is the contract:
      // parallel fan-out uses a multi-target `to` array (optionally with
      // per-target taskSummary), never multiple JSON objects. Prose
      // @mentions are still extracted for display purposes (UI shows
      // "@Lens" pills) but never drive routing.
      const emittedHandoff = parseHandoff(result.content, agentLocator);
      const mentionedAgents = emittedHandoff ? emittedHandoff.to : extractMentions(result.content);
      debugLog("handoff-parse", opts.roomId, opts.agentId, "parsed handoff from reply", {
        emittedHandoff: emittedHandoff
          ? {
              to: emittedHandoff.to.map((t) => t.id),
              perTargetTasks: emittedHandoff.to.map((t) => t.taskSummary ? `${t.id}: ${t.taskSummary.slice(0, 80)}` : undefined).filter(Boolean),
              taskSummary: emittedHandoff.taskSummary,
              requiredOutputSchema: emittedHandoff.requiredOutputSchema,
              intent: emittedHandoff.intent,
              provenance: emittedHandoff.provenance,
            }
          : null,
        mentionedAgents: mentionedAgents.map((m) => m.id),
        contentLen: result.content.length,
      });
      if (!emittedHandoff && !runFailed && mentionedAgents.length > 0) {
        // The agent clearly TRIED to route (prose @mentions) but no valid
        // handoff JSON was found — surface why instead of dying silently.
        const diag = diagnoseHandoffFailure(result.content, agentLocator);
        if (diag) {
          sendAll("system.warning", {
            roomId: opts.roomId,
            reason: "handoff-parse-failed",
            agentId: opts.agentId,
            detail: diag,
            mentioned: mentionedAgents.map((m) => m.id),
          });
          debugLog("handoff-parse-failed", opts.roomId, opts.agentId, diag, { mentioned: mentionedAgents.map((m) => m.id) });
        }
      }

      // Output-schema validation. The INVOKER's requiredOutputSchema — the
      // directive that brought THIS agent into the chain (opts.handoff) —
      // is what this reply is validated against, NOT the schema the agent
      // declares for its own next handoff. (The old code validated against
      // the emitted block, so a well-behaved Forge→Lens handoff — Forge
      // emits [RESULT] but declares review_block for Lens — was wrongly
      // flagged as a schema mismatch and hijacked by echo.)
      //
      // failurePolicy decides the outcome:
      //   fallback_echo → hand the task to echo (default)
      //   retry         → re-invoke this agent with feedback after backoff
      //   escalate      → warn + stop
      // Only fallback_echo REPLACES routing. retry/escalate BLOCK the
      // invalid output from fanning out to the agents it asked for.
      const requiredSchema = opts.handoff?.requiredOutputSchema;
      const failurePolicy = opts.handoff?.failurePolicy ?? {
        onInvalidOutput: "retry" as const,
        onTimeout: "fallback_echo" as const,
        maxRetries: 1,
      };      let echoFallback: HandoffDirectiveV2 | null = null;
      let validationFailed = false;
      let retryScheduled = false;
      const nextDirectives: HandoffDirectiveV2[] = [];
      // A cancelled run (Stop button) is a deliberate user interrupt, not a
      // failure — skip schema validation entirely so it doesn't trigger an
      // echo fallback (which would make the stop look like a crash).
      if (runFailed) {
        // opencode 进程失败（超时/退出码非零/无输出）——按 failurePolicy.onTimeout 处理
        validationFailed = true;
        const policy = failurePolicy.onTimeout ?? "fallback_echo";
        if (policy === "fallback_echo") {
          echoFallback = buildEchoFallback({
            from: opts.agentId,
            parentTraceId: opts.handoff?.traceId ?? "unknown",
            parentContent: result.content,
            expectedSchema: requiredSchema ?? "answer_text",
            originalTaskSummary: opts.handoff?.taskSummary,
            failureType: "timeout",
          });
        } else if (policy === "retry" && failurePolicy.maxRetries > 0) {
          // Retry: re-invoke the same agent with the ORIGINAL prompt (context
          // is preserved), after exponential backoff. attempt 累计在 traceId
          // 上，重试可被 Stop 取消（透传 signal）。
          const attempt = bumpRetryAttempt(opts.handoff?.traceId);
          const decision = decideRetry({
            attempt: attempt - 1, // bumpRetryAttempt is 1-based; decideRetry is 0-based
            maxRetries: failurePolicy.maxRetries,
            elapsedMs: retryElapsedMs(opts.handoff?.traceId, startedAt),
            reason: `run failure: ${result.error ?? "timeout"}`,
          });
          if (decision.shouldRetry) {
            retryScheduled = true;
            sendAll("system.info", {
              roomId: opts.roomId,
              reason: "run-retry",
              agentId: opts.agentId,
              traceId: opts.handoff?.traceId,
              retryDelayMs: decision.delayMs,
              remainingRetries: failurePolicy.maxRetries - attempt,
            });
            const retryTrailer =
              `[RETRY #${attempt} — 上次运行失败: ${result.error ?? "timeout"}。请重试，用正确 [TAG] 块 + 裸 JSON handoff 回复。]`;
            void (async () => {
              await sleep(decision.delayMs);
              return invokeAgentAsync({
                roomId: opts.roomId,
                agentId: opts.agentId,
                prompt: `${opts.prompt}\n\n${retryTrailer}`,
                parentMessageId: opts.parentMessageId,
                source: "agent",
                signal: opts.signal,
                handoff: opts.handoff
                  ? { ...opts.handoff, failurePolicy: { ...opts.handoff.failurePolicy, maxRetries: failurePolicy.maxRetries - attempt } }
                  : undefined,
              });
            })().catch((err) => {
              console.error("[triggers] retry-after-timeout failed:", err);
              sendAll("system.warning", {
                roomId: opts.roomId,
                reason: "retry-error",
                agentId: opts.agentId,
                error: err instanceof Error ? err.message : String(err),
              });
            });
          }
        } else {
          // escalate / retries exhausted → route to Atlas with failure context
          sendAll("system.warning", {
            roomId: opts.roomId,
            reason: "run-failed-escalate",
            agentId: opts.agentId,
            error: result.error,
            traceId: opts.handoff?.traceId,
          });
        }
      // Schema validation applies ONLY when the agent actually delivers the
      // requested output. If the reply contains a valid handoff block, the
      // agent is RE-DISPATCHING (ownership transfer) — its deliverable is the
      // routing decision, not the upstream's required schema. Validating it
      // here would kill legit handoffs (e.g. Atlas asked for research_brief,
      // delegates implementation to Forge, and its reply has no [RESEARCH]
      // tag → whole chain dies). The downstream receiver's reply is validated
      // against ITS OWN directive instead.
      } else if (!cancelled && requiredSchema && !emittedHandoff && !validateOutputAgainstSchema(result.content, requiredSchema)) {
        validationFailed = true;
        const vResult = validateOutputAgainstSchemaDetailed(result.content, requiredSchema);
        sendAll("system.warning", {
          roomId: opts.roomId,
          reason: "output-schema-mismatch",
          agentId: opts.agentId,
          expected: requiredSchema,
          detail: vResult.reason ?? undefined,
          traceId: opts.handoff?.traceId,
        });
        if (failurePolicy.onInvalidOutput === "fallback_echo") {
          // hand the task to echo with full context so it can either
          // produce a degraded answer or escalate via [BLOCKER].
          echoFallback = buildEchoFallback({
            from: opts.agentId,
            parentTraceId: opts.handoff?.traceId ?? "unknown",
            parentContent: result.content,
            expectedSchema: requiredSchema,
            originalTaskSummary: opts.handoff?.taskSummary,
          });
        } else if (failurePolicy.onInvalidOutput === "retry" && failurePolicy.maxRetries > 0) {
          // Retry: re-invoke the same agent with schema-mismatch feedback,
          // after an exponential-backoff delay. We decrement maxRetries on
          // the new directive so the chain eventually gives up. The retry
          // re-enters the full pipeline on completion, so the CURRENT
          // (invalid) output must NOT route anywhere below.
          const attempt = bumpRetryAttempt(opts.handoff?.traceId);
          const decision = decideRetry({
            attempt: attempt - 1, // bumpRetryAttempt is 1-based; decideRetry is 0-based
            maxRetries: failurePolicy.maxRetries,
            elapsedMs: retryElapsedMs(opts.handoff?.traceId, startedAt),
            // Format errors are transient — budget only by maxRetries, not
            // wall-clock (the run itself can legitimately take minutes).
            budgetMs: Infinity,
            reason: `schema-mismatch on "${requiredSchema}"`,
          });
          if (decision.shouldRetry) {
            retryScheduled = true;
            sendAll("system.info", {
              roomId: opts.roomId,
              reason: "schema-retry",
              agentId: opts.agentId,
              traceId: opts.handoff?.traceId,
              retryDelayMs: decision.delayMs,
              remainingRetries: failurePolicy.maxRetries - attempt,
            });
            const retryTrailer =
              `[RETRY #${attempt} — 上次回复未通过输出校验：${vResult.reason ?? `缺少 requiredOutputSchema="${requiredSchema}" 要求的 [TAG] 块`}。请修正后重试，用正确 [TAG] 块 + 裸 JSON handoff 回复，不要重复上次的内容。]`;
            void (async () => {
              await sleep(decision.delayMs);
              return invokeAgentAsync({
                roomId: opts.roomId,
                agentId: opts.agentId,
                prompt: `${opts.prompt}\n\n${retryTrailer}`,
                parentMessageId: opts.parentMessageId,
                source: "agent",
                signal: opts.signal,
                handoff: opts.handoff
                  ? { ...opts.handoff, failurePolicy: { ...opts.handoff.failurePolicy, maxRetries: failurePolicy.maxRetries - attempt } }
                  : undefined,
              });
            })().catch((err) => {
              console.error("[triggers] retry-after-schema failed:", err);
              sendAll("system.warning", {
                roomId: opts.roomId,
                reason: "retry-error",
                agentId: opts.agentId,
                error: err instanceof Error ? err.message : String(err),
              });
            });
          } else {
            // Backoff budget or retries exhausted → route to Atlas so the
            // orchestrator can decide the next step (re-pick, adjust, or
            // tell the user) instead of dead-ending or bothering Echo.
            sendAll("system.info", {
              roomId: opts.roomId,
              reason: "route-to-atlas",
              agentId: opts.agentId,
              traceId: opts.handoff?.traceId,
              detail: decision.reason,
            });
          }
        } else if (failurePolicy.onInvalidOutput === "escalate") {
          // failurePolicy.onInvalidOutput = "escalate" → emit [BLOCKER]
          sendAll("system.warning", {
            roomId: opts.roomId,
            reason: "schema-escalate",
            agentId: opts.agentId,
            traceId: opts.handoff?.traceId,
          });
        } else {
          // Default (retry exhausted or unknown action) → route to Atlas
          // so the orchestrator decides what to do next.
          sendAll("system.info", {
            roomId: opts.roomId,
            reason: "route-to-atlas",
            agentId: opts.agentId,
            traceId: opts.handoff?.traceId,
            detail: `schema-mismatch on "${requiredSchema}" — routing to Atlas`,
          });
        }
      }

      // If the agent's reply was ONLY a ```handoff``` block (no prose), the
      // stripped display would be blank — which reads as a silent failure.
      // Fall back to a human-readable dispatch summary so the UI shows
      // something meaningful (and the user can see the task went where).
      let displayContent = stripHandoff(result.content);
      if (runFailed) {
        const reason = result.error ?? "opencode run failed";
        displayContent = `_（运行失败：${reason}）_` + (displayContent ? `\n\n${displayContent}` : "");
        tags.push("error");
      } else if (!displayContent && emittedHandoff) {
        const names = emittedHandoff.to.map((t) => t.name).join(", ");
        displayContent = `[派发 → ${names}]${emittedHandoff.taskSummary ? ` ${emittedHandoff.taskSummary}` : ""}`;
      }
      if (cancelled) {
        const stopped = displayContent ? `\n\n_(已停止 — 回复被中断)_` : `_(已停止 — 回复被中断)_`;
        displayContent = (displayContent ? displayContent : "") + stopped;
      }
      db.prepare(`
        INSERT INTO messages (id, room_id, author_id, content, tags, mentioned_agent_ids, parent_id, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        opts.roomId,
        opts.agentId,
        displayContent,
        JSON.stringify(tags),
        JSON.stringify(mentionedAgents.map((m) => m.id)),
        opts.parentMessageId ?? null,
        finishedAt,
      );

      sendAll("message.created", {
        id,
        roomId: opts.roomId,
        authorId: opts.agentId,
        content: displayContent,
        tags,
        mentionedAgents: mentionedAgents.map((m) => m.id),
        parentId: opts.parentMessageId,
        timestamp: finishedAt,
      });

      // Persist any [MEMORY] block the agent emitted. Only Archivist is
      // allowed to write memory; other agents' blocks are silently
      // dropped with a warning (see runtime.persistAgentMemory).
      const memResult = persistAgentMemory(opts.agentId, opts.roomId, id, result.content);
      if (memResult.written.length > 0) {
        sendAll("system.info", {
          roomId: opts.roomId,
          reason: "memory-written",
          agentId: opts.agentId,
          memoryIds: memResult.written,
        });
      }

      sendAll("agent.completed", {
        roomId: opts.roomId,
        agentId: opts.agentId,
        runId,
        messageId: id,
        elapsedMs: finishedAt - startedAt,
        timestamp: finishedAt,
      });

      // Resolve the next set of targets:
      //   1. Schema validation failed + fallback_echo → echo directive wins.
      //   2. Else if validation passed and the agent emitted an explicit
      //      ```handoff``` block, use it.
      //   3. No handoff block → chain ends naturally. The agent is expected
      //      to produce a ```handoff``` block when it wants to route. No
      //      implicit tag-based rules are evaluated — routing is always
      //      explicit.
      //   4. On validation failure WITHOUT fallback_echo → route to Atlas so
      //      the orchestrator decides the next step (re-pick, adjust, etc.).
      debugLog("routing", opts.roomId, opts.agentId, "deciding next targets", {
        echoFallback: echoFallback?.to.map((t) => t.id) ?? null,
        validationFailed,
        retryScheduled,
        requiredSchema: requiredSchema ?? null,
        emittedHandoff: emittedHandoff ? emittedHandoff.to.map((t) => t.id) : null,
        cancelled,
      });
      if (echoFallback) {
        nextDirectives.push(echoFallback);
      } else if (retryScheduled) {
        // A retry is already in flight for this trace — do NOT route the
        // current (failed/invalid) output anywhere.
        debugLog("routing", opts.roomId, opts.agentId, "retry in flight — skipping routing of failed output");
      } else if (!validationFailed) {
        // Fan-in barrier: if this worker belongs to an active fan-out group
        // and handed back to the originator, HOLD the handoff until all
        // workers complete — then one aggregate wrap-up routes to the
        // originator. Prevents N workers each summoning Atlas for the same
        // summary (duplicate wrap-up runs).
        const barrier = fanOutOnWorkerDone({
          traceId: opts.handoff?.traceId ?? "",
          roomId: opts.roomId,
          worker: opts.agentId,
          content: result.content,
          handoff: emittedHandoff,
        });
        if (barrier.status === "fired" && barrier.directive) {
          nextDirectives.push(barrier.directive);
        } else if (barrier.status === "held") {
          debugLog("routing", opts.roomId, opts.agentId, "handoff held by fan-in barrier — waiting for remaining workers");
        } else if (emittedHandoff) {
          // Parallel fan-out stays a SINGLE handoff with a multi-target `to`
          // array — triggerOnMessage dispatches all targets concurrently
          // (Promise.allSettled) and per-target taskSummary is applied there.
          nextDirectives.push(emittedHandoff);
        }
        // else: no handoff, chain ends. The agent either concluded or
        // forgot to hand off — either way, no routing.
      } else if (validationFailed && !echoFallback) {
        // Route to Atlas with failure context so it can re-pick/adjust —
        // BUT if this worker belongs to a fan-out group, the failure is a
        // worker completion too: hand it to the barrier so it's folded into
        // the single aggregate wrap-up instead of summoning Atlas early.
        const atlas = getAgentByName("atlas");
        if (atlas) {
          const failDirective: HandoffDirectiveV2 = {
            schemaVersion: "2.0",
            traceId: opts.handoff?.traceId ?? `fail_${Date.now().toString(36)}`,
            rawTraceId: "",
            to: [{ id: atlas.id, name: atlas.name, rawName: "atlas" }],
            taskSummary: `上一步 agent "${opts.agentId}" 输出未通过 schema 校验（期望 ${requiredSchema}），请评估后决定下一步：换人、调整任务描述、或告知用户`,
            requiredOutputSchema: "answer_text",
            failurePolicy: { onInvalidOutput: "escalate" as const, onTimeout: "fallback_echo" as const, maxRetries: 0 },
            provenance: { parentAgent: opts.agentId, parentMessageId: id },
          };
          const barrier = fanOutOnWorkerDone({
            traceId: opts.handoff?.traceId ?? "",
            roomId: opts.roomId,
            worker: opts.agentId,
            content: result.content,
            handoff: failDirective,
          });
          if (barrier.status === "fired" && barrier.directive) {
            nextDirectives.push(barrier.directive);
          } else if (barrier.status === "held") {
            debugLog("routing", opts.roomId, opts.agentId, "failed worker absorbed by fan-in barrier — waiting for remaining workers");
          } else {
            nextDirectives.push(failDirective);
          }
        }
      }

      // Forward ONLY on explicit structured handoff in the agent's reply
      // (or implicit-rule-derived fallback / echo takeover). Prose @mentions
      // no longer drive routing (see triggerOnMessage).
      debugLog("routing", opts.roomId, opts.agentId, "forwarding directives", {
        directives: nextDirectives.map((d) => ({
          to: d.to.map((t) => t.id),
          traceId: d.traceId,
          taskSummary: d.taskSummary,
          requiredOutputSchema: d.requiredOutputSchema,
        })),
      });
      for (const d of nextDirectives) {
        await triggerOnMessage({
          roomId: opts.roomId,
          authorId: opts.agentId,
          content: result.content,
          parentMessageId: id,
          source: opts.source ?? "agent",
          handoff: d,
        });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      sendAll("agent.error", {
        roomId: opts.roomId,
        agentId: opts.agentId,
        runId,
        error: errMsg,
        elapsedMs: ts() - startedAt,
        timestamp: ts(),
      });
      sendAll("system.warning", { roomId: opts.roomId, reason: "agent-error", agentId: opts.agentId, error: errMsg });
    } finally {
      drainQueue(opts.roomId, opts.agentId);
    }
  };

  if (runningAgents.has(key)) {
    const q = agentQueues.get(key) ?? [];
    q.push(task);
    agentQueues.set(key, q);
    sendAll("agent.thinking", {
      roomId: opts.roomId,
      agentId: opts.agentId,
      runId,
      message: "Queued — waiting for previous turn",
      pending: true,
      timestamp: Date.now(),
    });
  } else {
    await task();
  }
}

export async function triggerOnSelfTalkTick(roomId: string): Promise<void> {
  const room = db.prepare("SELECT status, agent_ids FROM rooms WHERE id = ?").get(roomId) as { status: string; agent_ids: string } | undefined;
  if (!room || room.status !== "self-talk") return;
  const agents: string[] = JSON.parse(room.agent_ids || "[]");
  for (const aId of agents) {
    const key = queueKey(roomId, aId);
    if (runningAgents.has(key)) continue;
    const lastRow = db.prepare(`
      SELECT content FROM messages WHERE room_id = ? ORDER BY timestamp DESC LIMIT 1
    `).get(roomId) as { content: string } | undefined;
    if (!lastRow) break;
    sendAll("self_talk.tick", { roomId, agentId: aId, timestamp: Date.now() });
    await invokeAgentAsync({
      roomId,
      agentId: aId,
      prompt: `${lastRow.content}\n\n(self-talk tick — continue the conversation)`,
      source: "self-talk",
    });
    break;
  }
}