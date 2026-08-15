/**
 * retry.ts — Exponential backoff retry helper for handoff chains.
 *
 * Used by the trigger loop when failurePolicy.onInvalidOutput = "retry"
 * (or when an agent times out and failurePolicy.onTimeout = "retry").
 *
 * Algorithm: standard exponential backoff with full jitter (per AWS
 * Architecture Blog "Exponential Backoff And Jitter"). The base delay
 * is 500ms; each retry doubles the cap. Total wall-clock budget is
 * capped at 30s so a flaky downstream doesn't block the room forever.
 */

export type RetryDecision = {
  shouldRetry: boolean;
  delayMs: number;
  attemptNumber: number;
  reason: string;
};

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8_000;
const MAX_TOTAL_BUDGET_MS = 30_000;

/**
 * Decide whether to retry a failed handoff and how long to wait.
 *
 * @param attempt  0-indexed retry attempt count (0 = first retry, 1 = second, etc.)
 * @param maxRetries  Max retries allowed (from failurePolicy.maxRetries)
 * @param elapsedMs   Total wall-clock spent in this handoff chain so far
 * @param reason      Why we're considering a retry (for logging)
 * @param budgetMs    Optional override for MAX_TOTAL_BUDGET_MS. The default
 *                    30s budget is designed for flaky downstream APIs where
 *                    a retry should not linger. But for LONG implementation
 *                    tasks (Forge editing a file for 2-3 min), the elapsed
 *                    wall-clock includes the agent's legitimate work time —
 *                    a run that failed after 168s is NOT "budget exhausted",
 *                    it's a normal-length run that happened to fail. Callers
 *                    that retry on FORMAT errors (schema-mismatch) should
 *                    pass Infinity here and rely on maxRetries alone, which
 *                    is already capped at 3.
 */
export function decideRetry(opts: {
  attempt: number;
  maxRetries: number;
  elapsedMs: number;
  reason: string;
  budgetMs?: number;
}): RetryDecision {
  const budgetMs = opts.budgetMs ?? MAX_TOTAL_BUDGET_MS;
  if (opts.attempt >= opts.maxRetries) {
    return {
      shouldRetry: false,
      delayMs: 0,
      attemptNumber: opts.attempt,
      reason: `maxRetries exhausted (${opts.attempt}/${opts.maxRetries})`,
    };
  }
  if (opts.elapsedMs >= budgetMs) {
    return {
      shouldRetry: false,
      delayMs: 0,
      attemptNumber: opts.attempt,
      reason: `total budget exhausted (${opts.elapsedMs}ms >= ${budgetMs}ms)`,
    };
  }

  // Full jitter: pick a random delay between 0 and the calculated cap.
  // Cap = min(BASE * 2^attempt, MAX_DELAY)
  const cap = Math.min(BASE_DELAY_MS * Math.pow(2, opts.attempt), MAX_DELAY_MS);
  const delayMs = Math.floor(Math.random() * cap);
  return {
    shouldRetry: true,
    delayMs,
    attemptNumber: opts.attempt + 1,
    reason: opts.reason,
  };
}

/**
 * Sleep helper. Returns a promise that resolves after `ms` milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Walk the message tree backward from `messageId` collecting provenance.
 * Used by the runtime.handoff-chain API to show the full chain of a
 * given task trace.
 */
export type MessageChainNode = {
  messageId: string;
  parentId: string | null;
  authorId: string;
  content: string;
  tags: string[];
  timestamp: number;
  handoffSummary?: string;  // [handoff task — ...] trailer if present
};

import { db } from "../db.js";

export function walkProvenanceChain(messageId: string, maxDepth = 50): MessageChainNode[] {
  const out: MessageChainNode[] = [];
  const visited = new Set<string>();
  let current: string | null = messageId;
  let depth = 0;
  while (current && depth < maxDepth) {
    if (visited.has(current)) break;
    visited.add(current);
    const row = db.prepare(`
      SELECT id, parent_id, author_id, content, tags, timestamp
      FROM messages WHERE id = ?
    `).get(current) as {
      id: string; parent_id: string | null; author_id: string; content: string; tags: string; timestamp: number;
    } | undefined;
    if (!row) break;
    let parsedTags: string[] = [];
    try { parsedTags = JSON.parse(row.tags); } catch { /* ignore */ }
    let handoffSummary: string | undefined;
    const trailerMatch = row.content.match(/\[handoff task — [^\]]+\][^\n]*/);
    if (trailerMatch) handoffSummary = trailerMatch[0];
    out.push({
      messageId: row.id,
      parentId: row.parent_id,
      authorId: row.author_id,
      content: row.content,
      tags: parsedTags,
      timestamp: row.timestamp,
      handoffSummary,
    });
    current = row.parent_id;
    depth++;
  }
  return out.reverse(); // root -> leaf order
}