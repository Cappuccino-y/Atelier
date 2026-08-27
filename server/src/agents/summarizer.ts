/**
 * summarizer.ts — Per-(room, role) rolling summarization checkpoints.
 *
 * Purpose. Long agent chains blow through `loadRoomThread`'s 60K-char
 * budget and the oldest turns get hard-truncated (or dropped). That loses
 * earlier reasoning. Industry practice (LangGraph MemoryStore, OpenAI
 * Sessions, MemGPT "system" working memory): summarize older history into
 * a compact checkpoint, keep the last few turns as raw messages, inject
 * both. The model still sees "what happened" without paying for the
 * verbatim tokens.
 *
 * Trigger. `maybeSummarize` is called fire-and-forget after each agent
 * run (see triggers.ts). It only fires when:
 *   - there are > `keepLastN` (default 5) un-summarized messages, AND
 *   - the last summary for this room+profile is older than
 *     `minIntervalMs` (default 10 minutes — agent runs are bursty; we
 *     don't want to summarize on every single hop).
 *
 * Cost. One cheap LLM call (atlas + glm-5.3-flash) producing <= 800 chars
 * of prose. Background, never blocks the agent chain.
 *
 * Storage. Append-only to `message_summaries` keyed on (room_id,
 * profile_key). Multiple profiles per room (one per role profile that
 * actually gets invoked) accumulate independently — cheap because each
 * summary is bounded at 800 chars.
 */
import { db } from "../db.js";
import { nanoid } from "nanoid";
import { debugLog } from "./debug.js";
import { getRoleProfile } from "./runtime.js";
import { runOpenCodeAgent } from "./process-agent.js";
import { resolveAgentModel, config } from "../config.js";

/** Keep these last N raw messages verbatim; everything older gets summarized. */
export const KEEP_LAST_N = 5;
/** Floor: don't bother summarizing unless there are at least this many
 *  un-summarized messages. Avoids compressing noise. */
export const MIN_UNSUMMARIZED = 10;
/** Don't run summarizer for the same (room, profile) twice within this
 *  window. Agent chains issue many sequential writes — frequent
 *  summarization just burns tokens. */
export const MIN_INTERVAL_MS = 10 * 60 * 1000; // 10 min
/** Cap on what gets summarized in one pass. */
const MAX_INPUT_CHARS = 30_000;
/** Target output length for the LLM. */
const TARGET_SUMMARY_CHARS = 800;

type SummaryRow = {
  id: string;
  room_id: string;
  profile_key: string;
  up_to_message_id: string;
  up_to_timestamp: number;
  summary: string;
  covered_count: number;
  created_at: number;
};

type CandidateMsg = {
  id: string;
  author_id: string;
  content: string;
  tags: string[];
  timestamp: number;
};

/**
 * Find the last summary for (roomId, profileKey), or null. Latest by
 * timestamp.
 */
export function getLatestSummary(roomId: string, profileKey: string): SummaryRow | null {
  const row = db.prepare(`
    SELECT * FROM message_summaries
    WHERE room_id = ? AND profile_key = ?
    ORDER BY up_to_timestamp DESC LIMIT 1
  `).get(roomId, profileKey) as SummaryRow | undefined;
  return row ?? null;
}

/**
 * List all summaries for a room (any profile). Used by the UI / API for
 * transparency.
 */
export function listSummariesForRoom(roomId: string): SummaryRow[] {
  return db.prepare(`
    SELECT * FROM message_summaries WHERE room_id = ?
    ORDER BY profile_key, up_to_timestamp DESC
  `).all(roomId) as SummaryRow[];
}

/**
 * Persist a summary. Returns the new id.
 */
function persistSummary(opts: {
  roomId: string;
  profileKey: string;
  upToMessageId: string;
  upToTimestamp: number;
  summary: string;
  coveredCount: number;
}): string {
  const id = `sum_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(`
    INSERT INTO message_summaries
      (id, room_id, profile_key, up_to_message_id, up_to_timestamp, summary, covered_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    opts.roomId,
    opts.profileKey,
    opts.upToMessageId,
    opts.upToTimestamp,
    opts.summary,
    opts.coveredCount,
    Date.now(),
  );
  return id;
}

/**
 * Count un-summarized messages: messages newer than the latest
 * (room, profile) summary's `up_to_timestamp`. Used by `maybeSummarize` to
 * decide whether to fire.
 */
export function countUnsummarized(roomId: string, profileKey: string): {
  count: number;
  lastSummaryTs: number | null;
} {
  const last = getLatestSummary(roomId, profileKey);
  const lastTs = last?.up_to_timestamp ?? null;
  // Branch on whether we have a checkpoint so the SQL is explicit and
  // doesn't rely on SQLite evaluating `? IS NULL` against a JS-null bind
  // (works but obscures intent).
  const row = lastTs == null
    ? db.prepare(`
        SELECT COUNT(*) as n, MAX(timestamp) as max_ts FROM messages
        WHERE room_id = ?
      `).get(roomId) as { n: number; max_ts: number | null }
    : db.prepare(`
        SELECT COUNT(*) as n, MAX(timestamp) as max_ts FROM messages
        WHERE room_id = ? AND timestamp > ?
      `).get(roomId, lastTs) as { n: number; max_ts: number | null };
  return { count: row.n, lastSummaryTs: lastTs };
}

/**
 * Fetch candidate messages (older than the kept tail) for summarization.
 * Applies the role profile's allowedAuthors filter so per-profile
 * summaries only cover that role's relevant scope — matches the
 * industry "scoped context" pattern (Atlas sees everything, specialists
 * see their slice).
 */
function fetchCandidates(roomId: string, profileKey: string, limit: number): CandidateMsg[] {
  const last = getLatestSummary(roomId, profileKey);
  const lastTs = last?.up_to_timestamp ?? 0;
  const profile = getRoleProfile(profileKey);
  const allowed = profile.allowedAuthors === "all"
    ? null
    : new Set(profile.allowedAuthors.map(a => a.toLowerCase()));

  const rows = db.prepare(`
    SELECT id, author_id, content, tags, timestamp FROM messages
    WHERE room_id = ? AND timestamp > ?
    ORDER BY timestamp ASC LIMIT ?
  `).all(roomId, lastTs, limit) as CandidateMsg[];

  // Apply author filter; keep the agent's OWN messages even if outside scope
  // (same rule as loadRoomThread so summaries match what the agent sees).
  const filtered = rows.filter(m => {
    const a = m.author_id.toLowerCase();
    if (!allowed) return true;
    return allowed.has(a) || a === profileKey.toLowerCase();
  });

  // Strip tags array parsing from each row (it's already an array from
  // better-sqlite3; tags JSON is small).
  return filtered.map(m => ({
    ...m,
    tags: Array.isArray(m.tags) ? m.tags : (typeof m.tags === "string" ? JSON.parse(m.tags || "[]") : []),
  }));
}

/**
 * Build a compressed text representation of the candidate messages, ready
 * to be passed to the summarizing LLM. Each message gets a short header
 * (author + timestamp + tags) and a truncated body.
 */
function buildInputForLlm(messages: CandidateMsg[]): string {
  const lines: string[] = [];
  let total = 0;
  for (const m of messages) {
    const head = `[${m.author_id} ${new Date(m.timestamp).toISOString().slice(11, 16)} ${m.tags.join(",")}]`;
    // Truncate per-message to keep the whole input bounded.
    const bodyCap = Math.max(200, Math.floor(MAX_INPUT_CHARS / Math.max(messages.length, 1)));
    const body = m.content.length > bodyCap
      ? m.content.slice(0, bodyCap) + "...[truncated]"
      : m.content;
    const entry = `${head}\n${body}\n`;
    if (total + entry.length > MAX_INPUT_CHARS) break;
    lines.push(entry);
    total += entry.length;
  }
  return lines.join("\n");
}

/**
 * Run the summarizing LLM (atlas + default flash model). Returns the
 * summary text, or null on failure.
 */
async function runSummarizerLlm(opts: {
  roomId: string;
  profileKey: string;
  candidatesText: string;
}): Promise<string | null> {
  // Always use atlas + the agent's resolved model. Atlas's persona already
  // includes instructions for high-quality summarization-style output (it's
  // literally the orchestrator role), and routing through atlas lets us
  // emit the summary as a child message with parent_id wiring if we ever
  // want to display it.
  const systemPrompt =
    `You are a summarizer for an agent room. Your job: compress the\n` +
    `provided conversation history into a compact paragraph that\n` +
    `preserves:\n` +
    `  - DECISIONS made (each one bullet, with the deciding agent)\n` +
    `  - FACTS that downstream agents will need (paths, constraints,\n` +
    `    conventions, numeric values)\n` +
    `  - OPEN THREADS / unresolved questions\n` +
    `Drop: small talk, intermediate tool-call chatter, transient\n` +
    `status lines, anything already settled. Output ≤ ${TARGET_SUMMARY_CHARS}\n` +
    `chars. Plain prose, no markdown headings, no preamble. Begin\n` +
    `directly with the decisions.`;
  const userPrompt =
    `Room: ${opts.roomId}\n` +
    `Profile (role) being summarized for: ${opts.profileKey}\n` +
    `Messages (oldest → newest):\n\n${opts.candidatesText}`;

  const model = resolveAgentModel("atlas");
  const ocAgent = config.agentMapping["atlas"] ?? "atlas";

  const result = await runOpenCodeAgent({
    agentName: "atlas",
    opencodeAgent: ocAgent,
    model,
    prompt: userPrompt,
    // No roomId / parentMessageId — this is a system-internal call, not a
    // user-visible agent run.
    runId: `summary_${Date.now().toString(36)}`,
  }).catch((err) => {
    debugLog("summarizer", opts.roomId, opts.profileKey, "llm-call-failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { success: false as const, content: "", cancelled: false, error: String(err), enrichedPrompt: "" };
  });

  if (!result.success || !result.content.trim()) return null;
  // Truncate to the target length as a safety net (model might overshoot).
  return result.content.trim().slice(0, TARGET_SUMMARY_CHARS * 2);
}

/**
 * Fire-and-forget check: if this room+profile has accumulated enough
 * un-summarized messages AND the last summary is old enough, summarize
 * them in the background. Safe to call after every agent run — it no-ops
 * cheaply when conditions aren't met.
 */
export function maybeSummarize(roomId: string, agentId: string): void {
  const profileKey = agentId.toLowerCase();
  const last = getLatestSummary(roomId, profileKey);
  const now = Date.now();
  if (last && now - last.created_at < MIN_INTERVAL_MS) {
    debugLog("summarizer", roomId, profileKey, "skip-too-recent", {
      ageMs: now - last.created_at,
      minIntervalMs: MIN_INTERVAL_MS,
    });
    return;
  }
  const { count } = countUnsummarized(roomId, profileKey);
  if (count < MIN_UNSUMMARIZED) {
    debugLog("summarizer", roomId, profileKey, "skip-too-few", { count });
    return;
  }

  // Fetch candidates up to (count - KEEP_LAST_N) — keep the last N raw,
  // summarize everything older.
  const candidates = fetchCandidates(roomId, profileKey, count);
  const toSummarize = candidates.slice(0, Math.max(0, candidates.length - KEEP_LAST_N));
  if (toSummarize.length < MIN_UNSUMMARIZED) {
    debugLog("summarizer", roomId, profileKey, "skip-after-trim", {
      candidates: candidates.length,
      toSummarize: toSummarize.length,
    });
    return;
  }

  const inputText = buildInputForLlm(toSummarize);
  const lastMsg = toSummarize[toSummarize.length - 1];

  // Background — no await here.
  runSummarizerLlm({ roomId, profileKey, candidatesText: inputText })
    .then((summary) => {
      if (!summary) {
        debugLog("summarizer", roomId, profileKey, "llm-returned-null");
        return;
      }
      persistSummary({
        roomId,
        profileKey,
        upToMessageId: lastMsg.id,
        upToTimestamp: lastMsg.timestamp,
        summary,
        coveredCount: toSummarize.length,
      });
      debugLog("summarizer", roomId, profileKey, "summary-written", {
        covered: toSummarize.length,
        summaryLen: summary.length,
      });
    })
    .catch((err) => {
      debugLog("summarizer", roomId, profileKey, "background-error", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

/**
 * Build the [SUMMARY] block for a (room, profile). Returns empty string if
 * no summary exists yet. Called by runtime.ts when composing the context.
 */
export function formatSummaryBlock(roomId: string, profileKey: string): string {
  const last = getLatestSummary(roomId, profileKey);
  if (!last) return "";
  return `[SUMMARY — ${last.profile_key} profile — covers ${last.covered_count} earlier messages up to ${new Date(last.up_to_timestamp).toISOString()}]\n${last.summary}\n[END SUMMARY]`;
}

/**
 * One-shot test hook: force a summary regardless of timing (used by tests).
 */
export async function forceSummarize(roomId: string, profileKey: string): Promise<string | null> {
  const { count } = countUnsummarized(roomId, profileKey);
  if (count === 0) return null;
  const candidates = fetchCandidates(roomId, profileKey, count);
  const toSummarize = candidates.slice(0, Math.max(0, candidates.length - KEEP_LAST_N));
  if (toSummarize.length === 0) return null;
  const inputText = buildInputForLlm(toSummarize);
  const lastMsg = toSummarize[toSummarize.length - 1];
  const summary = await runSummarizerLlm({ roomId, profileKey, candidatesText: inputText });
  if (!summary) return null;
  return persistSummary({
    roomId, profileKey,
    upToMessageId: lastMsg.id,
    upToTimestamp: lastMsg.timestamp,
    summary,
    coveredCount: toSummarize.length,
  });
}
