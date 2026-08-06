/**
 * memory.ts — Long-term knowledge skeleton for Atelier v2.
 *
 * Scope of this module (Phase 1, deliberately conservative):
 *   1. Append-only markdown log per scope, written to server/data/memory/
 *   2. Read API that returns structured MemoryEntry records
 *   3. Format helper that produces the [MEMORY] injection block that
 *      runtime.ts prepends to every agent invocation
 *
 * Explicitly out-of-scope (Phase 4):
 *   - Vector index / semantic search (just substring match for now)
 *   - Graph store / entity linking
 *   - Automatic extraction (Archivist does that manually via [MEMORY] tag)
 *   - Conflict resolution / supersession enforcement (handled by humans)
 *
 * Industry backing: Oracle's "persistent memory + derived context" pattern
 * — persistent memory is the source of truth (markdown files), derived
 * context (the [MEMORY] block) is computed lazily and never written back.
 *
 * Failure mode design: if memory files are corrupt or missing, we log a
 * warning and return an empty block. Memory is an enhancement, never a
 * dependency — agents must still produce useful output without it.
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { MemoryEntry } from "./handoff.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MEMORY_DIR = join(__dirname, "..", "..", "data", "memory");

/**
 * Scope tokens. The first word in [MEMORY] scope: field.
 *   - room:<roomId>     — per-room private memory
 *   - global            — workspace-wide, all agents see it
 *   - project:<name>    — scoped to a named project
 *   - agent:<id>        — only injected when matching agent invoked
 */
export type MemoryScope =
  | { kind: "room"; roomId: string }
  | { kind: "global" }
  | { kind: "project"; name: string }
  | { kind: "agent"; agentId: string };

const SCOPE_FILENAME_SEP = "__";

function scopeToFilename(scope: MemoryScope): string {
  switch (scope.kind) {
    case "room":   return `room_${scope.roomId}.md`;
    case "global": return "global.md";
    case "project": return `project_${scope.name.replace(/[^a-zA-Z0-9_-]/g, "_")}.md`;
    case "agent":   return `agent_${scope.agentId}.md`;
  }
}

function scopeToLabel(scope: MemoryScope): string {
  switch (scope.kind) {
    case "room":   return `room:${scope.roomId}`;
    case "global": return "global";
    case "project": return `project:${scope.name}`;
    case "agent":   return `agent:${scope.agentId}`;
  }
}

export function parseScope(raw: string): MemoryScope | null {
  const s = raw.trim();
  if (s === "global") return { kind: "global" };
  if (s.startsWith("room:")) return { kind: "room", roomId: s.slice("room:".length).trim() };
  if (s.startsWith("project:")) return { kind: "project", name: s.slice("project:".length).trim() };
  if (s.startsWith("agent:")) return { kind: "agent", agentId: s.slice("agent:".length).trim() };
  return null;
}

function ensureDir(): void {
  if (!existsSync(MEMORY_DIR)) {
    mkdirSync(MEMORY_DIR, { recursive: true });
  }
}

/**
 * Serialize a MemoryEntry to its on-disk markdown form. Appended with a
 * divider line. Designed to be human-readable AND parseable.
 */
function serializeEntry(entry: MemoryEntry, id: string, ts: number): string {
  const date = new Date(ts).toISOString();
  const tags = entry.tags.length > 0 ? `[${entry.tags.join(", ")}]` : "[]";
  const srcMsg = entry.source.messageIds.length > 0 ? entry.source.messageIds.join(", ") : "—";
  const srcAgent = entry.source.agentIds.length > 0 ? entry.source.agentIds.join(", ") : "—";
  const supersedes = entry.supersedes ? `\nsupersedes: ${entry.supersedes}` : "";
  return `---
memoryId: ${id}
timestamp: ${date}
scope: ${entry.scope}
category: ${entry.category}
title: ${entry.title}
tags: ${tags}
confidence: ${entry.confidence}
source.messageIds: ${srcMsg}
source.agentIds: ${srcAgent}${supersedes}

${entry.content}
---

`;
}

/**
 * Parse a memory file back into structured entries. Tolerant of
 * hand-edited / partial files.
 *
 * A single entry's free-text content can itself contain a literal `---`
 * line, so naive split-per-token parsing would truncate the entry at the
 * first embedded separator. Instead we re-join fragments that belong to
 * the same entry: the fragment carrying `memoryId:` starts a new entry,
 * subsequent non-empty fragments are appended back onto it.
 */
export function parseMemoryFile(content: string): Array<{ id: string; ts: number; entry: MemoryEntry }> {
  const out: Array<{ id: string; ts: number; entry: MemoryEntry }> = [];

  const tokens = content.split(/^---\s*$/m);
  let rawBlock = "";
  let inBlock = false;
  const flush = () => {
    if (!inBlock) return;
    const parsed = parseMemoryBlock(rawBlock);
    if (parsed) out.push(parsed);
    rawBlock = "";
    inBlock = false;
  };
  for (const token of tokens) {
    if (token.trim().startsWith("memoryId:")) {
      flush();
      rawBlock = token;
      inBlock = true;
    } else if (inBlock && token.trim().length > 0) {
      rawBlock += "\n---\n" + token;
    }
  }
  flush();
  return out;
}

/**
 * Parse a single `---`-delimited memory entry block (may span multiple
 * fragments when the content body contains literal `---` lines).
 */
function parseMemoryBlock(block: string): { id: string; ts: number; entry: MemoryEntry } | null {
  const trimmed = block.trim();
  if (!trimmed.startsWith("memoryId:")) return null;
  const idLine = trimmed.match(/^memoryId:\s*(\S+)/m);
  const tsLine = trimmed.match(/^timestamp:\s*(\S+)/m);
  const scopeLine = trimmed.match(/^scope:\s*(\S+)/m);
  const catLine = trimmed.match(/^category:\s*(\S+)/m);
  const titleLine = trimmed.match(/^title:\s*(.+)$/m);
  const tagsLine = trimmed.match(/^tags:\s*\[([^\]]*)\]/m);
  const confLine = trimmed.match(/^confidence:\s*(\S+)/m);
  const srcMsgLine = trimmed.match(/^source\.messageIds:\s*(.+)$/m);
  const srcAgentLine = trimmed.match(/^source\.agentIds:\s*(.+)$/m);
  if (!idLine || !scopeLine || !catLine || !titleLine) return null;

  const bodyStart = trimmed.indexOf("\n\n");
  const body = bodyStart >= 0 ? trimmed.slice(bodyStart).trim() : "";

  const scope = parseScope(scopeLine[1]);
  if (!scope) return null;
  const confidenceRaw = confLine?.[1] ?? "medium";
  const confidence = (confidenceRaw === "high" || confidenceRaw === "medium" || confidenceRaw === "low")
    ? confidenceRaw
    : "medium";

  const tags = (tagsLine?.[1] ?? "")
    .split(",").map((t) => t.trim()).filter(Boolean);

  const entry: MemoryEntry = {
    scope: scopeLine[1],
    category: catLine[1],
    title: titleLine[1].trim(),
    content: body,
    tags,
    confidence,
    source: {
      messageIds: (srcMsgLine?.[1] ?? "").split(",").map((s) => s.trim()).filter((s) => s && s !== "—"),
      agentIds: (srcAgentLine?.[1] ?? "").split(",").map((s) => s.trim()).filter((s) => s && s !== "—"),
    },
  };
  const ts = tsLine ? Date.parse(tsLine[1]) : Date.now();
  return { id: idLine[1], ts: Number.isFinite(ts) ? ts : Date.now(), entry };
}

/**
 * Append a memory entry to its scope's file. Idempotent on file write
 * (atomic via appendFileSync). Returns the generated memoryId.
 */
export function appendMemory(entry: MemoryEntry): { id: string; path: string } {
  ensureDir();
  const scope = parseScope(entry.scope);
  if (!scope) throw new Error(`invalid memory scope: ${entry.scope}`);
  const file = join(MEMORY_DIR, scopeToFilename(scope));
  const id = `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const ts = Date.now();
  const md = serializeEntry(entry, id, ts);
  try {
    appendFileSync(file, md, "utf8");
  } catch (err) {
    console.error(`[memory] failed to append to ${file}:`, err);
    throw err;
  }
  return { id, path: file };
}

/**
 * Load memory entries from a single scope file. Returns an empty array
 * if the file doesn't exist or fails to parse.
 */
export function loadScopeMemory(scope: MemoryScope, opts?: { limit?: number; tags?: string[] }): Array<{ id: string; ts: number; entry: MemoryEntry }> {
  const file = join(MEMORY_DIR, scopeToFilename(scope));
  if (!existsSync(file)) return [];
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch (err) {
    console.warn(`[memory] failed to read ${file}:`, err);
    return [];
  }
  let entries = parseMemoryFile(content);
  if (opts?.tags && opts.tags.length > 0) {
    const want = new Set(opts.tags);
    entries = entries.filter((e) => e.entry.tags.some((t) => want.has(t)));
  }
  // newest first
  entries.sort((a, b) => b.ts - a.ts);
  if (opts?.limit && entries.length > opts.limit) {
    entries = entries.slice(0, opts.limit);
  }
  return entries;
}

/**
 * Load memory entries that should be injected for a given agent
 * invocation. Combines:
 *   - room-scoped (per-room private notes)
 *   - global (workspace-wide)
 *   - agent-tagged (entries whose tags include the agent id)
 *
 * Phase 4: scoring + supersession filtering + dedup. Older entries that
 * have been superseded by `[MEMORY:DEPRECATE]` or by a newer entry
 * pointing at them via `supersedes:` are excluded by default.
 *
 * Capped at MAX_INJECT_ENTRIES total to avoid bloating prompts.
 */
const MAX_INJECT_ENTRIES = 12;

export function loadRelevantMemory(opts: {
  agentId: string;
  roomId?: string;
  limit?: number;
  query?: string;            // optional query string for relevance scoring
  includeDeprecated?: boolean; // default false — exclude superseded entries
}): Array<{ id: string; ts: number; entry: MemoryEntry; score: number }> {
  const limit = opts.limit ?? MAX_INJECT_ENTRIES;
  const includeDeprecated = opts.includeDeprecated ?? false;
  const seen = new Set<string>();
  const out: Array<{ id: string; ts: number; entry: MemoryEntry; score: number }> = [];

  // Collect all candidates first, then filter + score + dedup + sort.
  const candidates: Array<{ id: string; ts: number; entry: MemoryEntry }> = [];
  const collect = (entries: Array<{ id: string; ts: number; entry: MemoryEntry }>) => {
    for (const e of entries) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      candidates.push(e);
    }
    return false;
  };

  // 1. room-scoped first (most contextually relevant)
  if (opts.roomId) collect(loadScopeMemory({ kind: "room", roomId: opts.roomId }));
  // 2. agent-scoped
  collect(loadScopeMemory({ kind: "agent", agentId: opts.agentId }));
  // 3. global
  collect(loadScopeMemory({ kind: "global" }));

  // Build a set of memoryIds that have been deprecated.
  const deprecatedIds = new Set<string>();
  if (!includeDeprecated) {
    for (const c of candidates) {
      if (isDeprecated(c.entry)) deprecatedIds.add(c.id);
      if (typeof c.entry.supersedes === "string" && c.entry.supersedes.length > 0) {
        deprecatedIds.add(c.entry.supersedes);
      }
    }
  }

  // Filter, score, dedup.
  const queryTokens = tokenize(opts.query ?? "");
  for (const c of candidates) {
    if (deprecatedIds.has(c.id)) continue;
    const score = scoreMemory(c.entry, queryTokens, opts.agentId);
    out.push({ ...c, score });
  }
  // Newest-first tiebreaker after score.
  out.sort((a, b) => (b.score - a.score) || (b.ts - a.ts));
  return out.slice(0, limit);
}

/**
 * Heuristic: was this entry deprecated via [MEMORY:DEPRECATE]?
 * Matches both the title prefix (case-insensitive) and the
 * supersedes: chain — anything that has been replaced by a newer entry.
 */
export function isDeprecated(entry: MemoryEntry): boolean {
  const t = entry.title.toLowerCase();
  if (t.startsWith("[memory:deprecate]")) return true;
  if (/\bdeprecated\b/.test(t)) return true;
  if (/已废弃|已弃用/.test(entry.title)) return true;
  // NOTE: an entry that carries `supersedes` is the NEWER replacement for an
  // older entry — it is NOT deprecated itself. The older entry it replaces
  // is excluded via the supersedes chain in loadRelevantMemory (the caller
  // adds `c.entry.supersedes` to deprecatedIds), not here.
  return false;
}

/**
 * TF-IDF-like scoring: tag hits weigh most, title next, content body
 * last. When no query is given, returns 1.0 for everything (newest-first
 * sort still applies via the tiebreaker).
 */
export function scoreMemory(entry: MemoryEntry, queryTokens: string[], agentId: string): number {
  if (queryTokens.length === 0) return 1;

  let score = 0;
  const titleLower = entry.title.toLowerCase();
  const contentLower = entry.content.toLowerCase();
  const tagsLower = entry.tags.map((t) => t.toLowerCase());

  for (const tok of queryTokens) {
    if (tagsLower.includes(tok)) score += 3;      // tag match = strongest signal
    else if (titleLower.includes(tok)) score += 2;
    else if (contentLower.includes(tok)) score += 1;
  }

  // Mild bonus for entries tagged with this agent id — they were
  // explicitly written for this agent's consumption.
  if (tagsLower.includes(agentId.toLowerCase())) score += 0.5;

  return score;
}

function tokenize(s: string): string[] {
  return s.toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/i)
    .filter((t) => t.length >= 2);
}

/**
 * Detect near-duplicate entries based on tag Jaccard similarity +
 * title fuzzy match. Used at append time to warn the caller (and at
 * compaction time to merge duplicates).
 */
export function findDuplicate(
  candidate: MemoryEntry,
  existing: Array<{ id: string; ts: number; entry: MemoryEntry }>,
  threshold = 0.6,
): { id: string; similarity: number } | null {
  let best: { id: string; similarity: number } | null = null;
  const candTags = new Set(candidate.tags.map((t) => t.toLowerCase()));
  const candTitleWords = new Set(candidate.title.toLowerCase().split(/\s+/).filter((w) => w.length >= 3));

  for (const e of existing) {
    if (e.entry.title === candidate.title) {
      // Exact title match → almost certainly a dup.
      return { id: e.id, similarity: 1 };
    }
    const eTags = new Set(e.entry.tags.map((t) => t.toLowerCase()));
    let inter = 0;
    for (const t of candTags) if (eTags.has(t)) inter++;
    const union = candTags.size + eTags.size - inter;
    const jaccardTags = union === 0 ? 0 : inter / union;

    const eTitleWords = new Set(e.entry.title.toLowerCase().split(/\s+/).filter((w) => w.length >= 3));
    let titleInter = 0;
    for (const w of candTitleWords) if (eTitleWords.has(w)) titleInter++;
    const titleUnion = candTitleWords.size + eTitleWords.size - titleInter;
    const jaccardTitle = titleUnion === 0 ? 0 : titleInter / titleUnion;

    const similarity = 0.6 * jaccardTags + 0.4 * jaccardTitle;
    if (similarity >= threshold && (best === null || similarity > best.similarity)) {
      best = { id: e.id, similarity };
    }
  }
  return best;
}

/**
 * Mark an entry as deprecated by appending `[MEMORY:DEPRECATE]` to its
 * title. Used when a newer entry supersedes an older one or when a user
 * explicitly asks for deprecation via the REST API.
 */
export function deprecateMemoryEntry(memoryId: string, scopeKind: MemoryScope): boolean {
  // Read raw file, find the entry block by id, prepend DEPRECATE marker
  // to the title line.
  const file = join(MEMORY_DIR, scopeToFilename(scopeKind));
  if (!existsSync(file)) return false;
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return false;
  }

  const idMarker = `memoryId: ${memoryId}`;
  const idx = content.indexOf(idMarker);
  if (idx < 0) return false;

  // Find the title line that follows this memoryId marker.
  const afterMarker = content.slice(idx);
  const titleMatch = afterMarker.match(/^title:\s*(.+)$/m);
  if (!titleMatch) return false;

  const oldTitle = titleMatch[0];
  const newTitle = oldTitle.replace(/^title:\s*/, "title: [MEMORY:DEPRECATE] ");
  // Replace only the FIRST occurrence (which is the one after our marker).
  const updated = content.slice(0, idx) + content.slice(idx).replace(oldTitle, newTitle);

  try {
    writeFileSync(file, updated, "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * List all memory entries across all scopes. Used by the REST API and
 * by compaction. Sorts by timestamp descending.
 */
export function listAllMemory(opts?: { limit?: number }): Array<{
  scope: MemoryScope; id: string; ts: number; entry: MemoryEntry;
}> {
  const out: Array<{ scope: MemoryScope; id: string; ts: number; entry: MemoryEntry }> = [];
  if (!existsSync(MEMORY_DIR)) return out;

  for (const file of readdirSync(MEMORY_DIR)) {
    if (!file.endsWith(".md")) continue;
    let raw: string;
    try { raw = readFileSync(join(MEMORY_DIR, file), "utf8"); } catch { continue; }
    const scope = filenameToScope(file);
    if (!scope) continue;
    for (const { id, ts, entry } of parseMemoryFile(raw)) {
      out.push({ scope, id, ts, entry });
    }
  }
  out.sort((a, b) => b.ts - a.ts);
  if (opts?.limit && out.length > opts.limit) return out.slice(0, opts.limit);
  return out;
}

function filenameToScope(filename: string): MemoryScope | null {
  if (filename === "global.md") return { kind: "global" };
  if (filename.startsWith("room_") && filename.endsWith(".md")) {
    return { kind: "room", roomId: filename.slice("room_".length, -".md".length) };
  }
  if (filename.startsWith("project_") && filename.endsWith(".md")) {
    return { kind: "project", name: filename.slice("project_".length, -".md".length) };
  }
  if (filename.startsWith("agent_") && filename.endsWith(".md")) {
    return { kind: "agent", agentId: filename.slice("agent_".length, -".md".length) };
  }
  return null;
}

/**
 * Per-scope entry count stats for the /api/memory/stats endpoint.
 */
export function memoryStats(): {
  total: number;
  deprecated: number;
  byScope: Record<string, number>;
  byCategory: Record<string, number>;
  byConfidence: Record<string, number>;
} {
  const all = listAllMemory();
  const stats = {
    total: all.length,
    deprecated: 0,
    byScope: {} as Record<string, number>,
    byCategory: {} as Record<string, number>,
    byConfidence: {} as Record<string, number>,
  };
  for (const { entry, scope } of all) {
    if (isDeprecated(entry)) stats.deprecated++;
    const scopeKey = scopeToLabel(scope);
    stats.byScope[scopeKey] = (stats.byScope[scopeKey] ?? 0) + 1;
    stats.byCategory[entry.category] = (stats.byCategory[entry.category] ?? 0) + 1;
    stats.byConfidence[entry.confidence] = (stats.byConfidence[entry.confidence] ?? 0) + 1;
  }
  return stats;
}

/**
 * Format loaded memory entries into the [MEMORY] injection block that
 * runtime.ts prepends to the system prompt.
 *
 * Format (kept stable so agents can learn to read it):
 *
 *   [MEMORY]
 *   ## scope: room:abc123
 *   ### title (category / confidence)
 *   content body
 *   tags: [tag1, tag2]
 *   ---
 *   ## scope: global
 *   ...
 *   [END MEMORY]
 */
export function formatMemoryBlock(entries: Array<{ id: string; ts: number; entry: MemoryEntry }>): string {
  if (entries.length === 0) return "";
  const lines: string[] = ["[MEMORY] (read-only — server-injected from server/data/memory/)"];
  for (const { entry, ts } of entries) {
    const date = new Date(ts).toISOString().slice(0, 10);
    lines.push(`## ${scopeToLabel(parseScope(entry.scope) ?? { kind: "global" })} (${date}, ${entry.category}, ${entry.confidence})`);
    lines.push(`### ${entry.title}`);
    lines.push(truncate(entry.content, MAX_INJECT_CONTENT));
    if (entry.tags.length > 0) lines.push(`tags: [${entry.tags.join(", ")}]`);
    lines.push("---");
  }
  lines.push("[END MEMORY]");
  return lines.join("\n");
}

/** Cap per-entry content in the injected block so KB growth can't blow up prompts. */
const MAX_INJECT_CONTENT = 600;

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export const MEMORY_DIR_PATH = MEMORY_DIR;