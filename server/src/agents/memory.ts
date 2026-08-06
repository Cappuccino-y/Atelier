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

import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
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
 */
export function parseMemoryFile(content: string): Array<{ id: string; ts: number; entry: MemoryEntry }> {
  const out: Array<{ id: string; ts: number; entry: MemoryEntry }> = [];
  const blocks = content.split(/^---\s*$/m);
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed.startsWith("memoryId:")) continue;
    const idLine = trimmed.match(/^memoryId:\s*(\S+)/m);
    const tsLine = trimmed.match(/^timestamp:\s*(\S+)/m);
    const scopeLine = trimmed.match(/^scope:\s*(\S+)/m);
    const catLine = trimmed.match(/^category:\s*(\S+)/m);
    const titleLine = trimmed.match(/^title:\s*(.+)$/m);
    const tagsLine = trimmed.match(/^tags:\s*\[([^\]]*)\]/m);
    const confLine = trimmed.match(/^confidence:\s*(\S+)/m);
    const srcMsgLine = trimmed.match(/^source\.messageIds:\s*(.+)$/m);
    const srcAgentLine = trimmed.match(/^source\.agentIds:\s*(.+)$/m);
    if (!idLine || !scopeLine || !catLine || !titleLine) continue;

    const bodyStart = trimmed.indexOf("\n\n");
    const body = bodyStart >= 0 ? trimmed.slice(bodyStart).trim() : "";

    const scope = parseScope(scopeLine[1]);
    if (!scope) continue;
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
    out.push({ id: idLine[1], ts: Number.isFinite(ts) ? ts : Date.now(), entry });
  }
  return out;
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
 * Capped at MAX_INJECT_ENTRIES total to avoid bloating prompts.
 */
const MAX_INJECT_ENTRIES = 12;

export function loadRelevantMemory(opts: {
  agentId: string;
  roomId?: string;
  limit?: number;
}): Array<{ id: string; ts: number; entry: MemoryEntry }> {
  const limit = opts.limit ?? MAX_INJECT_ENTRIES;
  const seen = new Set<string>();
  const out: Array<{ id: string; ts: number; entry: MemoryEntry }> = [];

  const collect = (entries: Array<{ id: string; ts: number; entry: MemoryEntry }>) => {
    for (const e of entries) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(e);
      if (out.length >= limit) return true;
    }
    return false;
  };

  // 1. room-scoped first (most contextually relevant)
  if (opts.roomId) {
    if (collect(loadScopeMemory({ kind: "room", roomId: opts.roomId }))) return out;
  }
  // 2. agent-scoped
  if (collect(loadScopeMemory({ kind: "agent", agentId: opts.agentId }))) return out;
  // 3. global
  if (collect(loadScopeMemory({ kind: "global" }))) return out;

  return out;
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
    lines.push(entry.content);
    if (entry.tags.length > 0) lines.push(`tags: [${entry.tags.join(", ")}]`);
    lines.push("---");
  }
  lines.push("[END MEMORY]");
  return lines.join("\n");
}

export const MEMORY_DIR_PATH = MEMORY_DIR;