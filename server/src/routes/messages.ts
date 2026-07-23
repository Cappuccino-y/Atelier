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

  app.post<{ Params: { id: string }; Body: { content: string; authorId?: string } }>("/api/rooms/:id/messages", async (req, reply) => {
    const { content } = req.body;
    const authorId = req.body.authorId ?? "user";
    if (!content || !content.trim()) return reply.code(400).send({ error: "content required" });

    const id = nanoid();
    const ts = Date.now();
    const tags = extractTags(content);
    const mentions = extractMentions(content);

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
}

function normalizeMessage(m: any) {
  return {
    id: m.id, roomId: m.room_id, authorId: m.author_id,
    content: m.content,
    tags: JSON.parse(m.tags || "[]"),
    findings: m.findings ? JSON.parse(m.findings) : null,
    parentId: m.parent_id,
    mentionedAgentIds: JSON.parse(m.mentioned_agent_ids || "[]"),
    timestamp: m.timestamp,
  };
}