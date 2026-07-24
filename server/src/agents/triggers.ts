import { db } from "../db.js";
import { sendAll } from "../broadcast.js";
import { invokeAgent } from "./runtime.js";
import { nanoid } from "nanoid";

const TAG_RE = /\[(DECISION|TODO|STATUS|RESULT|REVIEW|QUESTION|BLOCKER)\]/g;
const MENTION_RE = /@(!?)([\w一-鿿]+)/g;
const HANDOFF_RE = /```handoff\s*\n([\s\S]*?)```/;
const MAX_HANDOFF_DEPTH = 50;
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

export type HandoffDirective = {
  to: Array<{ id: string; name: string }>;
  task?: string;
};

/**
 * Parses an explicit handoff JSON block from agent output.
 *
 * Format (anywhere in the agent's reply, usually at the end):
 *
 *   ```handoff
 *   {"to": ["forge", "lens"], "task": "review this change"}
 *   ```
 *
 * Returns null if no block found or block is malformed. We deliberately do
 * NOT fall back to @mention regex — that would re-introduce the same
 * false-positive problem we're fixing. Mentioning an agent in prose is
 * descriptive, not actionable.
 */
export function extractHandoff(content: string): HandoffDirective | null {
  const m = content.match(HANDOFF_RE);
  if (!m) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(m[1].trim());
  } catch {
    return null;
  }
  if (!parsed || !Array.isArray(parsed.to)) return null;
  const seen = new Set<string>();
  const targets: Array<{ id: string; name: string }> = [];
  for (const raw of parsed.to) {
    let agent: AgentRow | null = null;
    if (typeof raw === "string") {
      agent = getAgentByName(raw) ?? getAgentById(raw);
    } else if (raw && typeof raw === "object" && typeof raw.id === "string") {
      agent = getAgentByName(raw.id) ?? getAgentById(raw.id) ??
              (typeof raw.name === "string" ? getAgentByName(raw.name) : null);
    }
    if (agent && !seen.has(agent.id)) {
      targets.push({ id: agent.id, name: agent.name });
      seen.add(agent.id);
    }
  }
  if (targets.length === 0) return null;
  return { to: targets, task: typeof parsed.task === "string" ? parsed.task : undefined };
}

/**
 * Strip the ```handoff ... ``` block from content for display. Routing
 * metadata should not pollute the prose the user reads.
 */
export function stripHandoff(content: string): string {
  return content.replace(HANDOFF_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function extractTags(content: string): string[] {
  const tags = new Set<string>();
  for (const m of content.matchAll(TAG_RE)) tags.add(m[1]);
  return Array.from(tags);
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
   * Explicit routing targets, used when an agent's reply contains a
   * structured ```handoff``` block. Required for agent→agent routing.
   * When omitted, agent replies do NOT trigger anything (prose @mentions are
   * descriptive only — see extractHandoff comment).
   */
  explicitTargets?: Array<{ id: string; name: string }>;
  handoffTask?: string;
};

/**
 * Routes a message to the next agent(s).
 *
 * Two legitimate routing sources:
 *   - USER message: @mention in the text triggers the named agents
 *   - AGENT reply: a ```handoff``` JSON block with explicit "to" triggers;
 *     prose @mentions are descriptive and ignored
 *
 * Anything else (prose mentions in agent replies, magic tags) does NOT route.
 * Industry consensus (OpenAI Agents SDK, LangGraph Command(goto=), AutoGen
 * HandoffMessage, SW4RM) — routing must be a structured signal, not parsed
 * from natural language. Parsing prose is fragile and causes false positives.
 */
export async function triggerOnMessage(params: TriggerParams): Promise<void> {
  let targets: Array<{ id: string; name: string }> = [];

  if (params.authorId === "user") {
    // User messages: parse @mentions from text. Simple, unambiguous.
    targets = extractMentions(params.content);
  } else if (params.explicitTargets && params.explicitTargets.length > 0) {
    // Agent→agent: only the structured handoff block drives routing.
    targets = params.explicitTargets;
  } else {
    // No legitimate routing source — drop it.
    return;
  }

  // Drop self-mentions (an agent handing off to itself is a no-op).
  targets = targets.filter((m) => m.id !== params.authorId);

  const depth = currentDepth(params.roomId);
  if (depth > MAX_HANDOFF_DEPTH) {
    sendAll("system.warning", { roomId: params.roomId, reason: "depth-cap", depth });
    return;
  }

  if (targets.length === 0) return;

  // Fan-out: invoke all targets in parallel (Promise.allSettled so a single
  // failure doesn't abort the others). Each agent maintains its own
  // (room, agentId) running slot — the same agent is queued, not duplicated.
  // Completion order is determined by wall-clock, not invocation order.
  //
  // Industry consensus: LangGraph's Send API, OpenAI Swarm/Agents SDK's
  // asyncio.gather / Promise.all, CrewAI's Process.parallel — all default to
  // parallel fan-out. The trade-off is N× tokens + potential rate-limit
  // storms; we cap with MAX_PARALLEL_AGENTS below.
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

  // For agent→agent handoff, append the task description so the next agent
  // knows why they were invoked.
  const prompt = params.handoffTask
    ? `${params.content}\n\n[handoff task — ${params.authorId}]: ${params.handoffTask}`
    : params.content;

  await Promise.allSettled(
    filtered.map((m) =>
      invokeAgentAsync({
        roomId: params.roomId,
        agentId: m.id,
        prompt,
        parentMessageId: params.parentMessageId,
        source: params.source,
      })
    )
  );
}

function currentDepth(roomId: string): number {
  const row = db.prepare(`
    SELECT COUNT(*) as c FROM messages
    WHERE room_id = ? AND author_id != 'user' AND timestamp > ?
  `).get(roomId, Date.now() - 60_000) as { c: number };
  return row.c;
}

async function invokeAgentAsync(opts: {
  roomId: string;
  agentId: string;
  prompt: string;
  parentMessageId?: string;
  source?: "user" | "agent" | "self-talk";
  signal?: AbortSignal;
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
      // Routing targets come from the structured ```handoff``` block — see
      // extractHandoff. Prose @mentions are still extracted for display
      // purposes (UI shows "@Lens" pills) but never drive routing.
      const handoff = extractHandoff(result.content);
      const mentionedAgents = handoff ? handoff.to : extractMentions(result.content);
      // Display content strips the handoff metadata block so the user sees
      // only the agent's prose reply.
      const displayContent = stripHandoff(result.content);
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
        mentionedAgentIds: mentionedAgents.map((m) => m.id),
        parentId: opts.parentMessageId,
        timestamp: finishedAt,
      });

      sendAll("agent.completed", {
        roomId: opts.roomId,
        agentId: opts.agentId,
        runId,
        messageId: id,
        elapsedMs: finishedAt - startedAt,
        timestamp: finishedAt,
      });

      // Forward ONLY on explicit structured handoff in the agent's reply.
      // Prose @mentions no longer drive routing (see triggerOnMessage).
      await triggerOnMessage({
        roomId: opts.roomId,
        authorId: opts.agentId,
        content: result.content,
        parentMessageId: id,
        source: opts.source ?? "agent",
        explicitTargets: handoff?.to,
        handoffTask: handoff?.task,
      });
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