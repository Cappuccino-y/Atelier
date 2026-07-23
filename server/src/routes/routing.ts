import type { FastifyInstance } from "fastify";
import { triggerOnSelfTalkTick, extractMentions, extractTags } from "../agents/triggers.js";
import { resolveConflict } from "../agents/arbiter.js";
import { sendAll } from "../broadcast.js";

export async function routes(app: FastifyInstance) {
  app.post<{ Body: { roomId: string; agentId: string; content: string } }>("/api/route-to", async (req, reply) => {
    const { roomId, agentId, content } = req.body;
    if (!roomId || !agentId || !content) return reply.code(400).send({ error: "missing fields" });
    // route to specific agent
    const { triggerOnMessage } = await import("../agents/triggers.js");
    triggerOnMessage({ roomId, authorId: "user", content, source: "user" }).catch(console.error);
    sendAll("routing.route", { roomId, agentId, content });
    return { ok: true };
  });

  app.post<{ Body: { roomId: string; agentId: string } }>("/api/invite", async (req, reply) => {
    const { roomId, agentId } = req.body;
    if (!roomId || !agentId) return reply.code(400).send({ error: "missing fields" });
    // insert agent into room
    const { db } = await import("../db.js");
    const row = db.prepare("SELECT agent_ids FROM rooms WHERE id = ?").get(roomId) as any;
    if (!row) return reply.code(404).send({ error: "room not found" });
    const ids: string[] = JSON.parse(row.agent_ids || "[]");
    if (!ids.includes(agentId)) ids.push(agentId);
    db.prepare("UPDATE rooms SET agent_ids = ? WHERE id = ?").run(JSON.stringify(ids), roomId);
    sendAll("room.updated", { id: roomId, agentIds: ids });
    return { ok: true, agentIds: ids };
  });

  app.post<{ Body: { roomId: string; from?: string; to?: string } }>("/api/self-talk", async (req, reply) => {
    const { roomId } = req.body;
    if (!roomId) return reply.code(400).send({ error: "roomId required" });
    triggerOnSelfTalkTick(roomId).catch(console.error);
    return { ok: true };
  });

  app.post<{ Body: { roomId: string } }>("/api/tick", async (req, reply) => {
    const { roomId } = req.body;
    if (!roomId) return reply.code(400).send({ error: "roomId required" });
    triggerOnSelfTalkTick(roomId).catch(console.error);
    return { ok: true };
  });

  app.post<{ Body: { content: string } }>("/api/resolve-mentions", async (req, reply) => {
    const mentions = extractMentions(req.body.content);
    const tags = extractTags(req.body.content);
    const decision = resolveConflict(mentions, req.body.content);
    return { mentions, tags, decision };
  });
}