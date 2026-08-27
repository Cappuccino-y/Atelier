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
import { debugLog } from "./debug.js";
import { formatSummaryBlock } from "./summarizer.js";

const HISTORY_LIMIT = 30;
const OTHER_TRUNCATE = 800;
// Total character budget for the injected [HISTORY] block. A long
// multi-round task with full tool outputs (screenshots, file reads) can
// otherwise balloon past the model's context window — a 39-message chain
// hit 312KB / 141K tokens, overflowing the agent's configured model window and killing the
// run before it could emit [RESULT]. ~60K chars ≈ 15K tokens keeps the
// window comfortable while still preserving recent rounds intact.
const HISTORY_BUDGET = 60_000;

/**
 * Role-aware history slice profiles.
 *
 * Industry practice (LangGraph multi-agent docs, OpenAI Agents SDK
 * input_filter pattern, Anthropic context engineering): not every agent
 * needs every message. Atlas is the only agent that benefits from a full
 * room view; specialists (Forge / Scout / Writer / etc.) waste tokens on
 * intermediate reasoning from agents outside their workflow. Each profile
 * pins:
 *
 *   - historyLimit    — max messages to load for this role
 *   - allowedAuthors  — "all" to keep current behavior, or an explicit
 *                       agent-id whitelist to filter out noise. Empty array
 *                       means "only user".
 *   - otherTruncate   — per-message char cap for messages NOT authored by
 *                       this agent (own messages stay whole).
 *   - keepIntermediate — if false, STATUS-only / tool-heavy messages get
 *                        their intermediate reasoning stripped before
 *                        injection (see extractFinalResult).
 *
 * Tweak the table here as roles evolve; tests don't depend on exact
 * values, only on "atlas gets more than echo" type invariants.
 */
export type RoleContextProfile = {
  historyLimit: number;
  allowedAuthors: "all" | string[];
  otherTruncate: number;
  keepIntermediate: boolean;
};

export const ROLE_CONTEXT_PROFILE: Record<string, RoleContextProfile> = {
  // Orchestrator needs the full picture to route + summarize.
  atlas:     { historyLimit: 30, allowedAuthors: "all",                                      otherTruncate: 800,  keepIntermediate: true  },
  // Implementer cares about user intent + own progress + Lens feedback.
  // Other research/analysis threads are noise (Lens will surface them via
  // its [REVIEW] block if relevant).
  forge:     { historyLimit: 16, allowedAuthors: ["user","forge","lens","atlas"],            otherTruncate: 500,  keepIntermediate: false },
  // Reviewer wants everything (full context = fair review) but can absorb
  // bigger excerpts since decisions hinge on nuance.
  lens:      { historyLimit: 20, allowedAuthors: "all",                                      otherTruncate: 1500, keepIntermediate: true  },
  // Fallback — short fallback replies; aggressive trim is fine.
  echo:      { historyLimit: 8,  allowedAuthors: "all",                                      otherTruncate: 400,  keepIntermediate: false },
  // Researcher — user intent + Atlas dispatch + own previous progress.
  scout:     { historyLimit: 18, allowedAuthors: ["user","atlas","scout"],                  otherTruncate: 600,  keepIntermediate: false },
  // Trainer — feedback from Archivist + Atlas (workflow context).
  trainer:   { historyLimit: 12, allowedAuthors: ["archivist","atlas"],                    otherTruncate: 600,  keepIntermediate: false },
  // Analyst — full context but with substantial excerpts preserved.
  analyst:   { historyLimit: 20, allowedAuthors: "all",                                      otherTruncate: 1200, keepIntermediate: true  },
  // Writer — sees the upstream pipeline (research → analysis), not the
  // implementation chatter.
  writer:    { historyLimit: 20, allowedAuthors: ["user","atlas","scout","analyst"],        otherTruncate: 1000, keepIntermediate: false },
  // Archivist — needs the most context to spot evergreen patterns.
  archivist: { historyLimit: 25, allowedAuthors: "all",                                      otherTruncate: 800,  keepIntermediate: true  },
};

export function getRoleProfile(agentId: string): RoleContextProfile {
  return ROLE_CONTEXT_PROFILE[agentId.toLowerCase()]
    ?? { historyLimit: HISTORY_LIMIT, allowedAuthors: "all", otherTruncate: OTHER_TRUNCATE, keepIntermediate: true };
}

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type Row = { author_id: string; content: string; timestamp: number; reactions: string; tags: string };

/**
 * Strip intermediate reasoning from a message body, leaving only the
 * conclusion paragraphs (and the final [TAG] block if any). Used to keep
 * STATUS-heavy / tool-spammy messages from polluting downstream agent
 * context.
 */
export function extractFinalResult(content: string, tags: string[]): string {
  if (!content) return "";
  // If the message has no [TAG] markers at all, it's free-form prose —
  // keep the last paragraph + any headings as a sensible tail.
  const tagMatches = content.match(/\[(RESULT|REVIEW|QUESTION|DECISION|BLOCKER|TODO|RESEARCH|ANALYSIS|DOCUMENT|VISUAL|MEMORY|STATUS)\]/gi);
  if (!tagMatches || tagMatches.length === 0) {
    // Free-form prose: keep the last 2 paragraphs (most recent decisions).
    const paras = content.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
    if (paras.length <= 2) return content.trim();
    return paras.slice(-2).join("\n\n");
  }
  // Has [TAG] blocks — keep only the LAST block (the "real" deliverable).
  // We find the last `\[TAG]` token and cut everything before it, then trim
  // any text that comes AFTER the last `\[TAG]` (usually a handoff JSON or
  // `[handoff task]` trailer, which would have been stripped already by
  // stripHandoffBlock at insert time, but be defensive).
  const lastTagIdx = content.lastIndexOf(tagMatches[tagMatches.length - 1]);
  if (lastTagIdx < 0) return content.trim();
  const tail = content.slice(lastTagIdx);
  // The tail may include a handoff JSON block after the [TAG] paragraph —
  // also trim that out so the rendered [HISTORY] doesn't show routing meta.
  const jsonIdx = tail.indexOf("```handoff");
  const bareJsonIdx = tail.indexOf('{"schemaVersion"');
  const cutIdxCandidates = [jsonIdx, bareJsonIdx].filter(i => i >= 0);
  if (cutIdxCandidates.length > 0) {
    return tail.slice(0, Math.min(...cutIdxCandidates)).trim();
  }
  return tail.trim();
}

/**
 * Load recent room messages, filtered and truncated per the calling agent's
 * role profile. The thread that gets rendered into the [HISTORY] block.
 */
export function loadRoomThread(roomId: string, agentId: string, profile?: RoleContextProfile): ChatMessage[] {
  const p = profile ?? getRoleProfile(agentId);
  const allowed = p.allowedAuthors === "all"
    ? null
    : new Set(p.allowedAuthors.map(a => a.toLowerCase()));

  // Pull a slightly bigger candidate pool than the profile cap so author
  // filtering has room to discard messages; limit is reapplied after
  // filtering.
  const candidateLimit = allowed ? p.historyLimit * 3 : p.historyLimit;
  const rows = db.prepare(`
    SELECT author_id, content, timestamp, reactions, tags FROM messages
    WHERE room_id = ?
    ORDER BY timestamp DESC LIMIT ?
  `).all(roomId, candidateLimit) as Row[];

  // Walk newest→oldest, keeping own messages whole until the budget is
  // exhausted; after that even own messages get truncated so the total
  // injected block can never overflow the model window.
  const out: ChatMessage[] = [];
  let budget = HISTORY_BUDGET;
  let totalAdded = 0;
  for (const m of rows) {
    const authorLower = m.author_id.toLowerCase();
    if (allowed && !allowed.has(authorLower) && authorLower !== agentId.toLowerCase()) {
      // Filter: drop messages from agents outside this role's allowed
      // authors list. We still let the agent's OWN messages through even if
      // they're not in the allow-list (atlas might handoff to itself in
      // certain paths, and keeping self-history is always valuable).
      continue;
    }
    if (totalAdded >= p.historyLimit) break;

    const isSelf = m.author_id === agentId;
    const stamp = `[${m.author_id} ${new Date(m.timestamp).toLocaleTimeString()}]\n`;
    const raw = isSelf ? m.content : truncate(m.content, p.otherTruncate);

    // Surface user reactions on agent messages so the agent can self-monitor
    // satisfaction (👍/❤️ → keep doing this, 👎/😢 → consider revising).
    // Cheap to parse; reactions JSON is tiny.
    let reactionLine = "";
    try {
      const reactions = JSON.parse(m.reactions || "{}") as Record<string, { count: number; reactors?: string[] }>;
      const entries = Object.entries(reactions).filter(([, v]) => v.count > 0);
      if (entries.length > 0) {
        reactionLine = ` [reactions: ${entries.map(([e, v]) => `${e}${v.count}`).join(" ")}]`;
      }
    } catch {}

    // Strip intermediate reasoning for noise-prone messages (tool spam,
    // long STATUS streams). `keepIntermediate` is per-profile; roles that
    // need full reasoning for fair reviews (lens / analyst / archivist)
    // keep it.
    const messageTags = (() => {
      try { return JSON.parse(m.tags || "[]") as string[]; } catch { return []; }
    })();
    let body = (p.keepIntermediate || isSelf)
      ? raw
      : extractFinalResult(raw, messageTags);
    body = body + reactionLine;

    const size = stamp.length + body.length;
    if (size > budget) {
      // drop enough so this entry fits the remaining budget
      const keep = Math.max(0, budget - stamp.length - reactionLine.length);
      body = keep > 0 ? truncate(body, keep) : reactionLine;
      if (!body) continue;
    }
    budget -= stamp.length + body.length;
    out.push({
      role: isSelf ? "assistant" : "user",
      content: stamp + body,
    });
    totalAdded++;
    if (budget <= 0) break;
  }
  return out.reverse();
}


/**
 * Build the [MEMORY] + [HISTORY] blocks that get prepended to the system
 * prompt. v2 agents always see memory first (more evergreen) before the
 * volatile room thread.
 *
 * Includes a [CONTEXT HEADER] that tells the agent exactly what slice it
 * received (profile key, history limit, allowed authors, truncation cap)
 * — important for agents reasoning about what they DON'T have.
 */
function buildContextBlocks(agentId: string, roomId: string): string {
  const memoryEntries = loadRelevantMemory({ agentId, roomId });
  const memoryBlock = formatMemoryBlock(memoryEntries);
  const profile = getRoleProfile(agentId);
  const thread = loadRoomThread(roomId, agentId, profile);
  const historyText = thread
    .map((m) => `${m.role === "assistant" ? "[ASSISTANT]" : "[USER]"}\n${m.content}`)
    .join("\n\n");

  const allowedAuthorsDesc = profile.allowedAuthors === "all"
    ? "all"
    : `only ${profile.allowedAuthors.join(", ")}`;
  const header =
    `[CONTEXT HEADER — your history scope]\n` +
    `profile: role=${agentId}; keep_last=${profile.historyLimit}; ` +
    `authors=${allowedAuthorsDesc}; truncate_other=${profile.otherTruncate}chars; ` +
    `intermediate_kept=${profile.keepIntermediate}\n` +
    `(messages from authors not in your scope are filtered out — ` +
    `do NOT assume you have the full room history. ` +
    `If you need broader context, ask Atlas.)`;

  const blocks = [header];
  if (memoryBlock) blocks.push(memoryBlock);
  // [SUMMARY] precedes [HISTORY] — older turns as compressed prose, the
  // last few rounds as raw. Insertion order matches what agents learn to
  // expect: header → memory → summary → history.
  const summaryBlock = formatSummaryBlock(roomId, agentId);
  if (summaryBlock) blocks.push(summaryBlock);
  blocks.push(`[HISTORY]\n${historyText}\n[END HISTORY]`);
  return blocks.join("\n\n");
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
  debugLog("invoke", opts.roomId, opts.agentId, "invokeAgent", {
    model,
    ocAgent,
    promptLen: opts.prompt.length,
    basePromptLen: basePrompt.length,
    enrichedLen: enriched.length,
    promptHead: opts.prompt.slice(0, 300),
  });
  const result = await runOpenCodeAgent({
    agentName: opts.agentId,
    opencodeAgent: ocAgent,
    model,
    prompt: enriched,
    onEvent: opts.onEvent,
    signal: opts.signal,
    runId: opts.runId,
    roomId: opts.roomId,
  });
  debugLog("invoke-result", opts.roomId, opts.agentId, "raw agent reply (pre-strip)", {
    success: result.success,
    cancelled: result.cancelled,
    error: result.error,
    content: result.content,
  });
  return { ...result, enrichedPrompt: enriched };
}