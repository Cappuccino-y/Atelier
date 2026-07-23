import { db } from "../db.js";
import { sendAll } from "../broadcast.js";
import { invokeAgent } from "./runtime.js";
import { nanoid } from "nanoid";

const TAG_RE = /\[(DECISION|TODO|STATUS|RESULT|REVIEW|QUESTION|BLOCKER)\]/g;
const MENTION_RE = /@(!?)([\w一-鿿]+)/g;
const MAX_HANDOFF_DEPTH = 50;
const FLOOD_WINDOW = 10;
const FLOOD_THRESHOLD = 5;

type AgentRow = { id: string; name: string };
const agentCache = new Map<string, AgentRow>();

function getAgentByName(name: string): AgentRow | null {
  const key = name.toLowerCase();
  if (agentCache.has(key)) return agentCache.get(key)!;
  const row = db.prepare("SELECT id, name FROM agents WHERE LOWER(name) = ?").get(key) as AgentRow | undefined;
  if (row) agentCache.set(key, row);
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

export function extractTags(content: string): string[] {
  const tags = new Set<string>();
  for (const m of content.matchAll(TAG_RE)) tags.add(m[1]);
  return Array.from(tags);
}

const runningAgents = new Set<string>();
const agentQueues = new Map<string, Array<() => Promise<void>>>();
/** Active AbortControllers keyed by roomId:agentId — lets the Stop-all button
 *  actually cancel in-flight work instead of just hiding UI state. */
const activeSignals = new Map<string, AbortController>();

function queueKey(roomId: string, agentId: string): string {
  return `${roomId}:${agentId}`;
}

function drainQueue(roomId: string, agentId: string) {
  const key = queueKey(roomId, agentId);
  const q = agentQueues.get(key);
  // always clear the abort handle when this turn ends (success or cancel)
  activeSignals.delete(key);
  if (!q || q.length === 0) {
    runningAgents.delete(key);
    return;
  }
  const next = q.shift()!;
  void next();
}

/** Cancel every in-flight agent turn in a room. The run's promise rejects with
 *  an AbortError-like failure which surfaces to clients as `agent.error`. */
export function cancelRoomAgents(roomId: string): { cancelled: number } {
  let cancelled = 0;
  const prefix = `${roomId}:`;
  for (const [key, controller] of activeSignals) {
    if (!key.startsWith(prefix)) continue;
    try {
      controller.abort();
      cancelled++;
    } catch {}
  }
  return { cancelled };
}

/** Cancel every in-flight agent turn across every room. */
export function cancelAllAgents(): { cancelled: number } {
  let cancelled = 0;
  for (const controller of activeSignals.values()) {
    try {
      controller.abort();
      cancelled++;
    } catch {}
  }
  return { cancelled };
}

/** Cancel a single (roomId, agentId) turn if it is currently running. */
export function cancelAgent(roomId: string, agentId: string): boolean {
  const key = queueKey(roomId, agentId);
  const controller = activeSignals.get(key);
  if (!controller) return false;
  try {
    controller.abort();
    return true;
  } catch {
    return false;
  }
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
};

export async function triggerOnMessage(params: TriggerParams): Promise<void> {
  const allMentions = extractMentions(params.content);
  const mentions = allMentions.filter((m) => m.id !== params.authorId);

  const depth = currentDepth(params.roomId);
  if (depth > MAX_HANDOFF_DEPTH) {
    sendAll("system.warning", { roomId: params.roomId, reason: "depth-cap", depth });
    return;
  }

  if (mentions.length === 0) {
    const tags = extractTags(params.content);
    if (tags.length === 0) return;
    await implicitHandoff(params.roomId, params.authorId, params.content, tags);
    return;
  }

  for (const m of mentions) {
    if (isAgentFlooding(params.roomId, m.id)) {
      sendAll("system.warning", { roomId: params.roomId, reason: "flood", agentId: m.id });
      continue;
    }
    await invokeAgentAsync({
      roomId: params.roomId,
      agentId: m.id,
      prompt: params.content,
      parentMessageId: params.parentMessageId,
      source: params.source,
    });
  }
}

function currentDepth(roomId: string): number {
  const row = db.prepare(`
    SELECT COUNT(*) as c FROM messages
    WHERE room_id = ? AND author_id != 'user' AND timestamp > ?
  `).get(roomId, Date.now() - 60_000) as { c: number };
  return row.c;
}

async function implicitHandoff(roomId: string, authorId: string, content: string, tags: string[]) {
  if (tags.includes("RESULT") && authorId !== "lens") {
    sendAll("agent.handoff", { roomId, from: authorId, to: "lens", reason: "RESULT" });
    await invokeAgentAsync({
      roomId,
      agentId: "lens",
      prompt: `${content}\n\n(Implicit review handoff from ${authorId})`,
      source: "agent",
    });
  }
  if (tags.includes("REVIEW") && /critical|major/i.test(content) && authorId !== "forge") {
    sendAll("agent.handoff", { roomId, from: authorId, to: "forge", reason: "REWORK" });
    await invokeAgentAsync({
      roomId,
      agentId: "forge",
      prompt: `${content}\n\n(Implicit rework handoff from ${authorId})`,
      source: "agent",
    });
  }
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
    // expose an AbortController so Stop-all can actually interrupt the run.
    // chain with any caller-provided signal so a parent cancellation propagates.
    const controller = new AbortController();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    activeSignals.set(key, controller);

    // emit thinking event up front so UI can start streaming indicator
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
          // re-emit each opencode event as a typed WS event for live activity
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
      // If the run was cancelled by the Stop-all button, surface it as an error
      // event (not a completed message) so the live activity panel and the
      // outstanding-agent set correctly mark the agent as no longer running.
      if (result.cancelled) {
        sendAll("agent.error", {
          roomId: opts.roomId,
          agentId: opts.agentId,
          runId,
          error: result.error ?? "aborted by user",
          cancelled: true,
          elapsedMs: finishedAt - startedAt,
          timestamp: finishedAt,
        });
        sendAll("system.warning", {
          roomId: opts.roomId,
          reason: "agent-cancelled",
          agentId: opts.agentId,
        });
        return;
      }

      const tags = extractTags(result.content);
      const mentionedAgents = extractMentions(result.content);
      db.prepare(`
        INSERT INTO messages (id, room_id, author_id, content, tags, mentioned_agent_ids, parent_id, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        opts.roomId,
        opts.agentId,
        result.content,
        JSON.stringify(tags),
        JSON.stringify(mentionedAgents.map((m) => m.id)),
        opts.parentMessageId ?? null,
        finishedAt,
      );

      sendAll("message.created", {
        id,
        roomId: opts.roomId,
        authorId: opts.agentId,
        content: result.content,
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

      // forward to next agent if message contains @-mentions or implicit tags
      await triggerOnMessage({
        roomId: opts.roomId,
        authorId: opts.agentId,
        content: result.content,
        parentMessageId: id,
        source: opts.source ?? "agent",
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