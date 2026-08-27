import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { db } from "../db.js";
import { triggerOnMessage, extractMentions, extractTags } from "../agents/triggers.js";
import { sendAll } from "../broadcast.js";

export async function routes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>("/api/rooms/:id/messages", async (req) => {
    const rows = db.prepare("SELECT * FROM messages WHERE room_id = ? ORDER BY timestamp ASC").all(req.params.id) as any[];
    return rows.map(normalizeMessage);
  });

  app.post<{ Params: { id: string }; Body: { content: string; authorId?: string; mentionedAgentIds?: string[] } }>("/api/rooms/:id/messages", async (req, reply) => {
    const { content } = req.body;
    const authorId = req.body.authorId ?? "user";
    if (!content || !content.trim()) return reply.code(400).send({ error: "content required" });

    const id = nanoid();
    const ts = Date.now();
    const tags = extractTags(content);
    // Explicit mention list (from the Composer's parsed mentions) wins; fall
    // back to parsing the text so plain "@Forge hi" still routes correctly.
    const mentions = Array.isArray(req.body.mentionedAgentIds) && req.body.mentionedAgentIds.length > 0
      ? req.body.mentionedAgentIds.map((aId) => ({ id: aId, name: aId }))
      : extractMentions(content);

    db.prepare(`INSERT INTO messages (id, room_id, author_id, content, tags, mentioned_agent_ids, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, req.params.id, authorId, content, JSON.stringify(tags), JSON.stringify(mentions.map(m => m.id)), ts);

    db.prepare("UPDATE rooms SET last_activity = ? WHERE id = ?").run(ts, req.params.id);

    const msg = normalizeMessage(db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as any);
    sendAll("message.created", msg);

    // trigger agents async
    triggerOnMessage({ roomId: req.params.id, authorId, content, parentMessageId: id, source: "user" }).catch(err => {
      console.error("trigger error", err);
    });

    return msg;
  });

  app.post<{ Params: { roomId: string; messageId: string }; Body: { emoji: string; userId?: string } }>(
    "/api/rooms/:roomId/messages/:messageId/reactions",
    async (req, reply) => {
      const { emoji } = req.body;
      const userId = req.body.userId ?? "user";
      if (!emoji) return reply.code(400).send({ error: "emoji required" });

      const row = db.prepare("SELECT * FROM messages WHERE id = ?").get(req.params.messageId) as any;
      if (!row) return reply.code(404).send({ error: "message not found" });

      // Toggle semantics — each user gets at most one vote per emoji.
      // reactor ids are stored alongside the count so we can both dedupe
      // and (later) render per-user highlight in the UI.
      const reactions = JSON.parse(row.reactions || "{}") as Record<string, { count: number; reactors: string[] }>;
      const existing = reactions[emoji];
      if (existing) {
        const reactors = existing.reactors ?? [];
        const idx = reactors.indexOf(userId);
        if (idx >= 0) {
          reactors.splice(idx, 1);
        } else {
          reactors.push(userId);
        }
        existing.count = reactors.length;
        if (existing.count === 0) delete reactions[emoji];
      } else {
        reactions[emoji] = { count: 1, reactors: [userId] };
      }

      db.prepare("UPDATE messages SET reactions = ? WHERE id = ?")
        .run(JSON.stringify(reactions), req.params.messageId);

      const updated = normalizeMessage(db.prepare("SELECT * FROM messages WHERE id = ?").get(req.params.messageId) as any);
      sendAll("message.updated", updated);
      return updated;
    }
  );

  // Finding lifecycle — accept/reject a single finding (by index) or all at
  // once. Persists the decision on the message row so it survives reloads and
  // re-broadcasts the findings state to every connected client.
  app.patch<{ Params: { roomId: string; messageId: string }; Body: { index: number | "all"; decision: "accepted" | "rejected" } }>(
    "/api/rooms/:roomId/messages/:messageId/findings",
    async (req, reply) => {
      const { decision } = req.body;
      const index = req.body.index;
      if (decision !== "accepted" && decision !== "rejected") {
        return reply.code(400).send({ error: "decision must be accepted|rejected" });
      }

      const row = db.prepare("SELECT * FROM messages WHERE id = ?").get(req.params.messageId) as any;
      if (!row) return reply.code(404).send({ error: "message not found" });

      let findings: any[] = [];
      try { findings = JSON.parse(row.findings || "[]"); } catch { findings = []; }
      if (findings.length === 0) return reply.code(409).send({ error: "message has no findings" });

      if (index === "all") {
        for (const f of findings) f.decision = decision;
      } else {
        if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= findings.length) {
          return reply.code(400).send({ error: `index out of range (0..${findings.length - 1})` });
        }
        findings[index].decision = decision;
      }

      db.prepare("UPDATE messages SET findings = ? WHERE id = ?")
        .run(JSON.stringify(findings), req.params.messageId);

      const updated = normalizeMessage(db.prepare("SELECT * FROM messages WHERE id = ?").get(req.params.messageId) as any);
      sendAll(decision === "accepted" ? "finding.accepted" : "finding.rejected", {
        roomId: req.params.roomId,
        messageId: req.params.messageId,
        index,
      });
      sendAll("message.updated", updated);
      return updated;
    }
  );
}

function normalizeMessage(m: any) {
  return {
    id: m.id, roomId: m.room_id, authorId: m.author_id,
    content: m.content,
    tags: JSON.parse(m.tags || "[]"),
    findings: m.findings ? JSON.parse(m.findings) : null,
    parentId: m.parent_id,
    mentionedAgentIds: JSON.parse(m.mentioned_agent_ids || "[]"),
    reactions: JSON.parse(m.reactions || "{}"),
    timestamp: m.timestamp,
  };
}