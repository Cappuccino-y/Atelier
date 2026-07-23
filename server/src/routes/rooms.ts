import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { db } from "../db.js";

export async function routes(app: FastifyInstance) {
  app.get("/api/rooms", async () => {
    const rows = db.prepare("SELECT * FROM rooms ORDER BY last_activity DESC").all() as any[];
    return rows.map(normalizeRoom);
  });

  app.get<{ Params: { id: string } }>("/api/rooms/:id", async (req, reply) => {
    const row = db.prepare("SELECT * FROM rooms WHERE id = ?").get(req.params.id) as any;
    if (!row) return reply.code(404).send({ error: "not found" });
    return normalizeRoom(row);
  });

  app.post<{ Body: { name: string; topic?: string; projectId?: string } }>("/api/rooms", async (req, reply) => {
    const { name, topic, projectId } = req.body;
    if (!name) return reply.code(400).send({ error: "name required" });
    const id = nanoid();
    const now = Date.now();
    db.prepare(`INSERT INTO rooms (id, name, topic, status, unread, last_activity, agent_ids, created_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)`)
      .run(id, name, topic ?? "", "active", now, JSON.stringify(["atlas","forge","lens","echo"]), now);
    if (projectId) {
      db.prepare("UPDATE rooms SET project_id = ? WHERE id = ?").run(projectId, id);
    }
    const row = db.prepare("SELECT * FROM rooms WHERE id = ?").get(id) as any;
    return normalizeRoom(row);
  });

  app.patch<{ Params: { id: string }; Body: any }>("/api/rooms/:id", async (req, reply) => {
    const fields: string[] = [];
    const vals: any[] = [];
    const body = req.body as Record<string, any>;
    for (const k of ["name","topic","status","notes"]) {
      if (k in body) { fields.push(`${k} = ?`); vals.push(body[k]); }
    }
    if ("agentIds" in body) { fields.push("agent_ids = ?"); vals.push(JSON.stringify(body.agentIds)); }
    if (fields.length === 0) return reply.code(400).send({ error: "no fields" });
    vals.push(req.params.id);
    db.prepare(`UPDATE rooms SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
    const row = db.prepare("SELECT * FROM rooms WHERE id = ?").get(req.params.id) as any;
    if (!row) return reply.code(404).send({ error: "not found" });
    return normalizeRoom(row);
  });

  app.delete<{ Params: { id: string } }>("/api/rooms/:id", async (req, reply) => {
    db.prepare("DELETE FROM messages WHERE room_id = ?").run(req.params.id);
    db.prepare("DELETE FROM tasks WHERE room_id = ?").run(req.params.id);
    db.prepare("DELETE FROM events WHERE room_id = ?").run(req.params.id);
    db.prepare("DELETE FROM rooms WHERE id = ?").run(req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/rooms/:id/clear", async (req, reply) => {
    db.prepare("DELETE FROM messages WHERE room_id = ?").run(req.params.id);
    return { ok: true };
  });

  app.get("/api/projects", async () => {
    const rows = db.prepare("SELECT * FROM projects ORDER BY created_at").all() as any[];
    return rows.map(p => ({ ...p, roomIds: JSON.parse(p.room_ids || "[]") }));
  });
}

function normalizeRoom(r: any) {
  return {
    id: r.id, name: r.name, topic: r.topic ?? "", status: r.status,
    unread: r.unread ?? 0, lastActivity: r.last_activity,
    agentIds: JSON.parse(r.agent_ids || "[]"),
    notes: r.notes ?? "",
    createdAt: r.created_at,
    projectId: r.project_id,
  };
}