import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { db } from "../db.js";
import { sendAll } from "../broadcast.js";

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
    // New rooms default to ALL agents as members (atlas/forge/lens/echo/
    // trainer/scout/analyst/writer/archivist). Agents invoked later via
    // @mention or handoff are auto-added by ensureAgentsInRoom regardless.
    const allAgentIds = (db.prepare("SELECT id FROM agents WHERE id != 'user' ORDER BY name").all() as Array<{ id: string }>).map(a => a.id);
    db.prepare(`INSERT INTO rooms (id, name, topic, status, unread, last_activity, agent_ids, created_at, project_id) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)`)
      .run(id, name, topic ?? "", "active", now, JSON.stringify(allAgentIds), now, projectId ?? null);
    const row = db.prepare("SELECT * FROM rooms WHERE id = ?").get(id) as any;
    sendAll("room.created", normalizeRoom(row));
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
    if ("projectId" in body) { fields.push("project_id = ?"); vals.push(body.projectId ?? null); }
    if (fields.length === 0) return reply.code(400).send({ error: "no fields" });
    vals.push(req.params.id);
    db.prepare(`UPDATE rooms SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
    const row = db.prepare("SELECT * FROM rooms WHERE id = ?").get(req.params.id) as any;
    if (!row) return reply.code(404).send({ error: "not found" });
    sendAll("room.updated", normalizeRoom(row));
    return normalizeRoom(row);
  });

  app.delete<{ Params: { id: string } }>("/api/rooms/:id", async (req, reply) => {
    db.prepare("DELETE FROM messages WHERE room_id = ?").run(req.params.id);
    db.prepare("DELETE FROM tasks WHERE room_id = ?").run(req.params.id);
    db.prepare("DELETE FROM events WHERE room_id = ?").run(req.params.id);
    db.prepare("DELETE FROM rooms WHERE id = ?").run(req.params.id);
    sendAll("room.deleted", { id: req.params.id });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/rooms/:id/clear", async (req, reply) => {
    db.prepare("DELETE FROM messages WHERE room_id = ?").run(req.params.id);
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/api/rooms/:id/activities", async (req, reply) => {
    const rows = db.prepare(
      "SELECT * FROM activities WHERE room_id = ? ORDER BY timestamp DESC LIMIT 100"
    ).all(req.params.id) as any[];
    return rows.map(a => ({
      id: a.id,
      roomId: a.room_id,
      kind: a.kind,
      agentId: a.agent_id,
      message: a.message,
      meta: JSON.parse(a.meta || "{}"),
      timestamp: a.timestamp,
    }));
  });

  app.get("/api/projects", async () => {
    const rows = db.prepare("SELECT * FROM projects ORDER BY created_at").all() as any[];
    return rows.map(p => ({ ...p, roomIds: JSON.parse(p.room_ids || "[]") }));
  });

  app.post<{ Body: { name: string } }>("/api/projects", async (req, reply) => {
    const { name } = req.body;
    if (!name) return reply.code(400).send({ error: "name required" });
    const id = nanoid();
    const now = Date.now();
    db.prepare("INSERT INTO projects (id, name, room_ids, created_at) VALUES (?, ?, '[]', ?)").run(id, name, now);
    const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as any;
    const project = { ...row, roomIds: JSON.parse(row.room_ids || "[]") };
    sendAll("project.updated", project);
    return project;
  });

  app.delete<{ Params: { id: string } }>("/api/projects/:id", async (req, reply) => {
    const rooms = db.prepare("SELECT id FROM rooms WHERE project_id = ?").all(req.params.id) as Array<{ id: string }>;
    for (const room of rooms) {
      db.prepare("DELETE FROM messages WHERE room_id = ?").run(room.id);
      db.prepare("DELETE FROM tasks WHERE room_id = ?").run(room.id);
      db.prepare("DELETE FROM events WHERE room_id = ?").run(room.id);
      db.prepare("DELETE FROM rooms WHERE id = ?").run(room.id);
      sendAll("room.deleted", { id: room.id });
    }
    db.prepare("DELETE FROM projects WHERE id = ?").run(req.params.id);
    sendAll("project.updated", { id: req.params.id, deleted: true });
    return { ok: true };
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