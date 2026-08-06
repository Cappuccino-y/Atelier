/**
 * routes/memory.ts — REST API for the long-term memory subsystem.
 *
 * Endpoints:
 *   GET    /api/memory/list            — list all entries (optionally filtered)
 *   GET    /api/memory/stats           — counts by scope / category / confidence
 *   GET    /api/memory/search?q=...    — keyword + tag search with scoring
 *   POST   /api/memory/deprecate       — mark an entry deprecated
 *                                       body: { memoryId, scopeKind }
 *   GET    /api/memory/path            — server.data/memory dir path (for ops)
 */

import type { FastifyInstance } from "fastify";
import {
  listAllMemory,
  memoryStats,
  loadRelevantMemory,
  deprecateMemoryEntry,
  parseScope,
  type MemoryScope,
} from "../agents/memory.js";
import { walkProvenanceChain } from "../agents/retry.js";

export async function routes(app: FastifyInstance) {
  app.get("/api/memory/list", async (req) => {
    const q = req.query as { scope?: string; limit?: string; includeDeprecated?: string };
    const limit = q.limit ? parseInt(q.limit, 10) : 200;
    const includeDeprecated = q.includeDeprecated === "true";
    let entries = listAllMemory({ limit });
    if (q.scope) {
      const wantedScope = parseScope(q.scope);
      if (wantedScope) entries = entries.filter((e) => scopeMatches(e.scope, wantedScope));
    }
    if (!includeDeprecated) {
      // Cheap deprecation check by title/content prefix.
      entries = entries.filter((e) => !e.entry.title.startsWith("[MEMORY:DEPRECATE]"));
    }
    return {
      count: entries.length,
      entries: entries.map((e) => ({
        memoryId: e.id,
        scope: scopeToString(e.scope),
        timestamp: e.ts,
        category: e.entry.category,
        title: e.entry.title,
        tags: e.entry.tags,
        confidence: e.entry.confidence,
        source: e.entry.source,
        content: e.entry.content.slice(0, 280),
        contentTruncated: e.entry.content.length > 280,
      })),
    };
  });

  app.get("/api/memory/stats", async () => {
    return memoryStats();
  });

  app.get<{ Querystring: { q?: string; agentId?: string; limit?: string } }>(
    "/api/memory/search",
    async (req) => {
      const q = req.query.q ?? "";
      const agentId = req.query.agentId ?? "atlas";
      const limit = req.query.limit ? parseInt(req.query.limit, 10) : 10;
      // For search, we want ALL scopes (room + global + agent + project)
      // weighted equally, scored against `q`. We approximate by scanning
      // each scope's entries and ranking.
      const candidates = listAllMemory({ limit: 1000 });
      const tokens = q.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/i).filter((t) => t.length >= 2);
      const scored = candidates.map((c) => {
        let score = 0;
        const t = c.entry.title.toLowerCase();
        const body = c.entry.content.toLowerCase();
        const tags = c.entry.tags.map((x) => x.toLowerCase());
        for (const tok of tokens) {
          if (tags.includes(tok)) score += 3;
          else if (t.includes(tok)) score += 2;
          else if (body.includes(tok)) score += 1;
        }
        return { ...c, score };
      }).filter((c) => c.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      return {
        query: q,
        count: scored.length,
        entries: scored.map((c) => ({
          memoryId: c.id,
          scope: scopeToString(c.scope),
          score: c.score,
          title: c.entry.title,
          tags: c.entry.tags,
          content: c.entry.content.slice(0, 280),
          contentTruncated: c.entry.content.length > 280,
        })),
      };
    },
  );

  app.post<{ Body: { memoryId?: string; scopeKind?: string; roomId?: string; agentId?: string; projectName?: string } }>(
    "/api/memory/deprecate",
    async (req, reply) => {
      const body = req.body ?? {};
      if (!body.memoryId) return reply.code(400).send({ error: "memoryId required" });
      let scope: MemoryScope | null = null;
      if (body.scopeKind === "global") scope = { kind: "global" };
      else if (body.scopeKind === "room" && body.roomId) scope = { kind: "room", roomId: body.roomId };
      else if (body.scopeKind === "agent" && body.agentId) scope = { kind: "agent", agentId: body.agentId };
      else if (body.scopeKind === "project" && body.projectName) scope = { kind: "project", name: body.projectName };
      if (!scope) {
        return reply.code(400).send({
          error: "must provide scopeKind + roomId|agentId|projectName",
        });
      }
      const ok = deprecateMemoryEntry(body.memoryId, scope);
      return ok ? { ok: true } : reply.code(404).send({ error: "memoryId not found in given scope" });
    },
  );

  app.get("/api/memory/path", async () => {
    const { MEMORY_DIR_PATH } = await import("../agents/memory.js");
    return { path: MEMORY_DIR_PATH };
  });

  /**
   * Walk the provenance chain for a given messageId. Used by the UI
   * to render "show full handoff tree" for a task.
   */
  app.get<{ Params: { messageId: string }; Querystring: { maxDepth?: string } }>(
    "/api/runtime/handoff-chain/:messageId",
    async (req, reply) => {
      const { messageId } = req.params;
      const maxDepth = req.query.maxDepth ? parseInt(req.query.maxDepth, 10) : 50;
      if (!messageId) return reply.code(400).send({ error: "messageId required" });
      const chain = walkProvenanceChain(messageId, maxDepth);
      return { messageId, depth: chain.length, chain };
    },
  );
}

function scopeToString(s: MemoryScope): string {
  switch (s.kind) {
    case "global": return "global";
    case "room":   return `room:${s.roomId}`;
    case "agent":  return `agent:${s.agentId}`;
    case "project": return `project:${s.name}`;
  }
}

function scopeMatches(actual: MemoryScope, wanted: MemoryScope): boolean {
  if (wanted.kind === "global") return actual.kind === "global";
  if (wanted.kind === "room") return actual.kind === "room" && actual.roomId === wanted.roomId;
  if (wanted.kind === "agent") return actual.kind === "agent" && actual.agentId === wanted.agentId;
  if (wanted.kind === "project") return actual.kind === "project" && actual.name === wanted.name;
  return false;
}