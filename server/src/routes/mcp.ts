import type { FastifyInstance } from "fastify";
import { db } from "../db.js";

export async function routes(app: FastifyInstance) {
  app.get("/mcp/rooms", async () => {
    const rows = db.prepare("SELECT id, name, topic, status FROM rooms ORDER BY last_activity DESC").all() as any[];
    return { rooms: rows };
  });

  app.get<{ Params: { id: string } }>("/mcp/rooms/:id/members", async (req, reply) => {
    const row = db.prepare("SELECT agent_ids FROM rooms WHERE id = ?").get(req.params.id) as any;
    if (!row) return reply.code(404).send({ error: "not found" });
    const ids: string[] = JSON.parse(row.agent_ids || "[]");
    if (ids.length === 0) return { members: [] };
    const placeholders = ids.map(() => "?").join(",");
    const members = db.prepare(`SELECT id, name, role, color, status FROM agents WHERE id IN (${placeholders})`).all(...ids) as any[];
    return { members };
  });
}