import { db } from "../db.js";
import { config, resolveAgentModel } from "../config.js";
import { runOpenCodeAgent, type AgentEvent, type AgentRunResult } from "./process-agent.js";
import { buildSystemPrompt } from "./prompts.js";
import {
  loadRelevantMemory,
  formatMemoryBlock,
  appendMemory,
} from "./memory.js";
import { parseMemoryEntry } from "./handoff.js";

const HISTORY_LIMIT = 30;
const OTHER_TRUNCATE = 800;
// Total character budget for the injected [HISTORY] block. A long
// multi-round task with full tool outputs (screenshots, file reads) can
// otherwise balloon past the model's context window — a 39-message chain
// hit 312KB / 141K tokens, overflowing deepseek-v4-flash and killing the
// run before it could emit [RESULT]. ~60K chars ≈ 15K tokens keeps the
// window comfortable while still preserving recent rounds intact.
const HISTORY_BUDGET = 60_000;

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type Row = { author_id: string; content: string; timestamp: number };

export function loadRoomThread(roomId: string, agentId: string): ChatMessage[] {
  const rows = db.prepare(`
    SELECT author_id, content, timestamp FROM messages
    WHERE room_id = ?
    ORDER BY timestamp DESC LIMIT ?
  `).all(roomId, HISTORY_LIMIT) as Row[];

  // Walk newest→oldest, keeping own messages whole until the budget is
  // exhausted; after that even own messages get truncated so the total
  // injected block can never overflow the model window.
  const out: ChatMessage[] = [];
  let budget = HISTORY_BUDGET;
  for (const m of rows) {
    const isSelf = m.author_id === agentId;
    const stamp = `[${m.author_id} ${new Date(m.timestamp).toLocaleTimeString()}]\n`;
    const raw = isSelf ? m.content : truncate(m.content, OTHER_TRUNCATE);
    const size = stamp.length + raw.length;
    let body = raw;
    if (size > budget) {
      // drop enough so this entry fits the remaining budget
      const keep = Math.max(0, budget - stamp.length);
      body = keep > 0 ? truncate(raw, keep) : "";
      if (!body) continue;
    }
    budget -= stamp.length + body.length;
    out.push({
      role: isSelf ? "assistant" : "user",
      content: stamp + body,
    });
    if (budget <= 0) break;
  }
  return out.reverse();
}

/**
 * Build the [MEMORY] + [HISTORY] blocks that get prepended to the system
 * prompt. v2 agents always see memory first (more evergreen) before the
 * volatile room thread.
 */
function buildContextBlocks(agentId: string, roomId: string): string {
  const memoryEntries = loadRelevantMemory({ agentId, roomId });
  const memoryBlock = formatMemoryBlock(memoryEntries);
  const thread = loadRoomThread(roomId, agentId);
  const historyText = thread
    .map((m) => `${m.role === "assistant" ? "[ASSISTANT]" : "[USER]"}\n${m.content}`)
    .join("\n\n");

  if (memoryBlock) {
    return `${memoryBlock}\n\n[HISTORY]\n${historyText}\n\n[END HISTORY]\n`;
  }
  return `[HISTORY]\n${historyText}\n\n[END HISTORY]\n`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

export function enrichForHandoff(roomId: string, agentId: string, basePrompt: string): string {
  const ctx = buildContextBlocks(agentId, roomId);
  return `${basePrompt}\n\n${ctx}`;
}

/**
 * Persist memory entries emitted by Archivist. Called after a successful
 * agent invocation. Returns the list of memoryIds that were written, or
 * an empty array if the agent didn't emit any [MEMORY] block (or wasn't
 * the archivist).
 *
 * Only Archivist is allowed to write memory; any other agent's
 * [MEMORY] block is dropped with a console warning to keep the trust
 * boundary clear (SHARED_RULES already enforces this in prompt).
 */
export function persistAgentMemory(
  agentId: string,
  roomId: string,
  messageId: string | undefined,
  replyContent: string,
): { written: string[]; skipped: string[] } {
  const written: string[] = [];
  const skipped: string[] = [];

  if (agentId.toLowerCase() !== "archivist") {
    if (/\[MEMORY\]/i.test(replyContent)) {
      console.warn(`[memory] non-archivist agent "${agentId}" emitted [MEMORY] block — dropped`);
      skipped.push("non-archivist-author");
    }
    return { written, skipped };
  }

  const entry = parseMemoryEntry(replyContent);
  if (!entry) {
    if (/\[MEMORY\]/i.test(replyContent)) {
      skipped.push("malformed");
    }
    return { written, skipped };
  }

  // Default scope to room:<id> when archivist omits it (the common case).
  if (!entry.scope || entry.scope.trim() === "") {
    entry.scope = `room:${roomId}`;
  }

  // Backfill source.agentIds if archivist didn't include itself.
  if (entry.source.agentIds.length === 0) {
    entry.source.agentIds = ["archivist"];
  }
  if (messageId && !entry.source.messageIds.includes(messageId)) {
    entry.source.messageIds.push(messageId);
  }

  try {
    const result = appendMemory(entry);
    written.push(result.id);
  } catch (err) {
    console.error(`[memory] append failed:`, err);
    skipped.push("append-error");
  }

  return { written, skipped };
}

export async function invokeAgent(opts: {
  agentId: string;
  roomId: string;
  prompt: string;
  onEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;
  runId?: string;
}): Promise<AgentRunResult & { enrichedPrompt: string }> {
  const basePrompt = buildSystemPrompt(opts.agentId);
  const enriched = enrichForHandoff(opts.roomId, opts.agentId, `${basePrompt}\n\n${opts.prompt}`);
  const ocAgent = config.agentMapping[opts.agentId] ?? opts.agentId;
  const model = resolveAgentModel(opts.agentId);
  const result = await runOpenCodeAgent({
    agentName: opts.agentId,
    opencodeAgent: ocAgent,
    model,
    prompt: enriched,
    onEvent: opts.onEvent,
    signal: opts.signal,
    runId: opts.runId,
  });
  return { ...result, enrichedPrompt: enriched };
}