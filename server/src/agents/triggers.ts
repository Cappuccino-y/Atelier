import { db } from "../db.js";
import { sendAll } from "../broadcast.js";
import { invokeAgent, persistAgentMemory } from "./runtime.js";
import {
  parseHandoff,
  stripHandoffBlock,
  extractAllTags,
  validateOutputAgainstSchema,
  formatHandoffTaskTrailer,
  type HandoffDirectiveV2,
  type AgentLocator,
  type OutputSchema,
} from "./handoff.js";
import {
  evaluateImplicitRules,
  buildEchoFallback,
  type TagKind,
  type ImplicitTarget,
} from "./implicit-handoff.js";
import { decideRetry, sleep } from "./retry.js";
import { nanoid } from "nanoid";

const MENTION_RE = /(?<![\w.@])@(!?)([\w一-鿿]+)/g;
const MAX_HANDOFF_DEPTH = 10;
const FLOOD_WINDOW = 10;
const FLOOD_THRESHOLD = 5;
const MAX_PARALLEL_AGENTS = 4;

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

function queueKey(roomId: string, agentId: string): string {
  return `${roomId}:${agentId}`;
}

function drainQueue(roomId: string, agentId: string) {
  const key = queueKey(roomId, agentId);
  const q = agentQueues.get(key);
  if (!q || q.length === 0) {
    runningAgents.delete(key);
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
 *   - USER message: @mention in the text triggers the named agents
 *   - AGENT reply: a ```handoff``` JSON block (v1 or v2) with explicit
 *     "to" triggers; prose @mentions are descriptive and ignored
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
  } else if (params.handoff && params.handoff.to.length > 0) {
    // Agent→agent: only the structured handoff block drives routing.
    targets = params.handoff.to;
  } else {
    // No legitimate routing source — drop it.
    return;
  }

  // Drop self-mentions (an agent handing off to itself is a no-op).
  targets = targets.filter((m) => m.id !== params.authorId);

  // Depth guard: real handoff-chain depth (walk parent pointers), not a
  // room-message-count heuristic — parallel traffic in a room must not
  // trip the cap.
  const depth = chainDepth(params.parentMessageId);
  if (depth > MAX_HANDOFF_DEPTH) {
    sendAll("system.warning", { roomId: params.roomId, reason: "depth-cap", depth });
    return;
  }

  if (targets.length === 0) return;

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
  }
  const filtered = targets
    .filter((m) => !isAgentFlooding(params.roomId, m.id))
    .slice(0, MAX_PARALLEL_AGENTS);
  if (filtered.length < targets.length) {
    sendAll("system.warning", {
      roomId: params.roomId,
      reason: "concurrency-cap",
      requested: targets.length,
      invoked: filtered.length,
    });
  }

  // Build the trailer once so all fanned-out agents see the same trace id
  // and provenance. Falls back to legacy "[handoff task — authorId]: task"
  // for v1 blocks without requiredOutputSchema.
  const trailer = params.handoff ? formatHandoffTaskTrailer(params.handoff) : "";
  const prompt = trailer ? `${params.content}\n\n${trailer}` : params.content;

  await Promise.allSettled(
    filtered.map((m) =>
      invokeAgentAsync({
        roomId: params.roomId,
        agentId: m.id,
        prompt,
        parentMessageId: params.parentMessageId,
        source: params.source,
        handoff: params.handoff,
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

/**
 * Build synthetic handoff v2 directives from the implicit tag-based rules
 * that fired for an agent's output. Targets are grouped by
 * requiredOutputSchema so each fanned-out receiver is validated against the
 * schema IT was asked to produce (a single shared schema would force every
 * receiver to emit the first rule's tag). Returns [] when no rule fired or
 * nothing resolved to a known agent.
 */
function buildImplicitDirectives(
  roomId: string,
  content: string,
  tags: string[],
  fromAgentId: string,
  parentMessageId: string,
): HandoffDirectiveV2[] {
  const tagKinds = tags as TagKind[];
  const implicit = evaluateImplicitRules({ from: fromAgentId.toLowerCase(), tags: tagKinds, content });
  if (implicit.length === 0) return [];

  const fakeLocator: AgentLocator = (raw: string) => {
    const a = getAgentByName(raw);
    return a ? { id: a.id, name: a.name } : null;
  };

  const groups = new Map<OutputSchema, ImplicitTarget[]>();
  for (const t of implicit) {
    const arr = groups.get(t.requiredOutputSchema) ?? [];
    arr.push(t);
    groups.set(t.requiredOutputSchema, arr);
  }

  const directives: HandoffDirectiveV2[] = [];
  for (const [schema, targets] of groups) {
    const resolved = targets
      .map((t) => fakeLocator(t.agentId))
      .filter((a): a is { id: string; name: string } => a !== null);
    if (resolved.length === 0) continue;
    const traceId = `imp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const taskSummary = targets.map((t) => `[${t.agentId}] ${t.reason}`).join("; ");
    directives.push({
      schemaVersion: "2.0",
      traceId,
      rawTraceId: traceId,
      to: resolved.map((a) => ({ id: a.id, name: a.name, rawName: a.id })),
      taskSummary,
      requiredOutputSchema: schema,
      failurePolicy: {
        onInvalidOutput: "retry",
        onTimeout: "fallback_echo",
        maxRetries: 1,
      },
      provenance: {
        parentAgent: fromAgentId,
        parentMessageId,
      },
    });
  }

  if (directives.length > 0) {
    // Broadcast which implicit rules fired for observability.
    sendAll("system.info", {
      roomId,
      reason: "implicit-handoff",
      from: fromAgentId,
      targets: implicit.map((t) => `${t.agentId}:${t.requiredOutputSchema}`),
      reasons: implicit.map((t) => t.reason),
    });
  }
  return directives;
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
    const startedAt = Date.now();
    const ts = () => Date.now();

    sendAll("agent.thinking", {
      roomId: opts.roomId,
      agentId: opts.agentId,
      runId,
      message: "Reading room context…",
      timestamp: ts(),
    });

    try {
      const result = await invokeAgent({
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
      });

      const id = nanoid();
      const finishedAt = ts();
      const tags = extractTags(result.content);
      const cancelled = Boolean(result.cancelled);

      // Routing targets come from the structured ```handoff``` block — see
      // parseHandoff. Prose @mentions are still extracted for display
      // purposes (UI shows "@Lens" pills) but never drive routing.
      const emittedHandoff = parseHandoff(result.content, agentLocator);
      const mentionedAgents = emittedHandoff ? emittedHandoff.to : extractMentions(result.content);

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
      };
      let echoFallback: HandoffDirectiveV2 | null = null;
      let validationFailed = false;
      // A cancelled run (Stop button) is a deliberate user interrupt, not a
      // failure — skip schema validation entirely so it doesn't trigger an
      // echo fallback (which would make the stop look like a crash).
      if (!cancelled && requiredSchema && !validateOutputAgainstSchema(result.content, requiredSchema)) {
        validationFailed = true;
        sendAll("system.warning", {
          roomId: opts.roomId,
          reason: "output-schema-mismatch",
          agentId: opts.agentId,
          expected: requiredSchema,
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
          const decision = decideRetry({
            attempt: 0,
            maxRetries: failurePolicy.maxRetries,
            elapsedMs: Date.now() - startedAt,
            reason: `schema-mismatch on "${requiredSchema}"`,
          });
          if (decision.shouldRetry) {
            sendAll("system.info", {
              roomId: opts.roomId,
              reason: "schema-retry",
              agentId: opts.agentId,
              traceId: opts.handoff?.traceId,
              retryDelayMs: decision.delayMs,
              remainingRetries: failurePolicy.maxRetries - 1,
            });
            const retryTrailer =
              `${opts.handoff?.taskSummary ?? ""}\n\n[RETRY — your previous reply did not produce the required output tag for schema "${requiredSchema}". Please re-emit with the correct [TAG] block.]`;
            void (async () => {
              await sleep(decision.delayMs);
              return invokeAgentAsync({
                roomId: opts.roomId,
                agentId: opts.agentId,
                prompt: `${result.content}\n\n${retryTrailer}`,
                parentMessageId: opts.parentMessageId,
                source: "agent",
                handoff: opts.handoff
                  ? { ...opts.handoff, failurePolicy: { ...opts.handoff.failurePolicy, maxRetries: failurePolicy.maxRetries - 1 } }
                  : undefined,
              });
            })();
          } else {
            // Backoff budget or retries exhausted → escalate to user.
            sendAll("system.warning", {
              roomId: opts.roomId,
              reason: "schema-escalate",
              agentId: opts.agentId,
              traceId: opts.handoff?.traceId,
              detail: decision.reason,
            });
          }
        } else {
          // failurePolicy.onInvalidOutput = "escalate" → emit [BLOCKER]
          // so the user sees that the chain gave up.
          sendAll("system.warning", {
            roomId: opts.roomId,
            reason: "schema-escalate",
            agentId: opts.agentId,
            traceId: opts.handoff?.traceId,
          });
        }
      }

      // If the agent's reply was ONLY a ```handoff``` block (no prose), the
      // stripped display would be blank — which reads as a silent failure.
      // Fall back to a human-readable dispatch summary so the UI shows
      // something meaningful (and the user can see the task went where).
      let displayContent = stripHandoff(result.content);
      if (!displayContent && emittedHandoff) {
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
      //   3. Else (validation passed, no handoff block) evaluate implicit
      //      tag-based rules (Phase 2), grouped per requiredOutputSchema so
      //      each fanned-out receiver is validated against ITS schema.
      //   4. On validation failure with retry/escalate, NOTHING routes — the
      //      invalid output is terminal for this hop (retry handles it).
      const nextDirectives: HandoffDirectiveV2[] = [];
      if (echoFallback) {
        nextDirectives.push(echoFallback);
      } else if (!validationFailed) {
        if (emittedHandoff) {
          nextDirectives.push(emittedHandoff);
        } else {
          nextDirectives.push(...buildImplicitDirectives(opts.roomId, result.content, tags, opts.agentId, id));
        }
      }

      // Forward ONLY on explicit structured handoff in the agent's reply
      // (or implicit-rule-derived fallback / echo takeover). Prose @mentions
      // no longer drive routing (see triggerOnMessage).
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