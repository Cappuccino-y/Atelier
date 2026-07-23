import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { db } from "../db.js";
import { sendAll } from "../broadcast.js";

export async function routes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>("/api/rooms/:id/tasks", async (req) => {
    const rows = db.prepare("SELECT * FROM tasks WHERE room_id = ? ORDER BY created_at DESC").all(req.params.id) as any[];
    return rows.map(normalize);
  });

  app.post<{ Params: { id: string }; Body: { title: string; assigneeId?: string; status?: string } }>("/api/rooms/:id/tasks", async (req, reply) => {
    const { title, assigneeId, status } = req.body;
    if (!title) return reply.code(400).send({ error: "title required" });
    const id = nanoid();
    const ts = Date.now();
    db.prepare("INSERT INTO tasks (id, room_id, title, assignee_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, req.params.id, title, assigneeId ?? null, status ?? "todo", ts);
    const task = normalize(db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as any);
    sendAll("task.created", task);
    return task;
  });

  app.patch<{ Params: { id: string }; Body: any }>("/api/tasks/:id", async (req, reply) => {
    const fields: string[] = [];
    const vals: any[] = [];
    const body = req.body as Record<string, any>;
    for (const k of ["title","assignee_id","status"]) {
      const camel = k.replace(/_(\w)/, (_, c) => c.toUpperCase());
      if (camel in body) { fields.push(`${k} = ?`); vals.push(body[camel]); }
    }
    if (fields.length === 0) return reply.code(400).send({ error: "no fields" });
    vals.push(req.params.id);
    db.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id) as any;
    if (!row) return reply.code(404).send({ error: "not found" });
    const task = normalize(row);
    sendAll("task.updated", task);
    return task;
  });

  app.delete<{ Params: { id: string } }>("/api/tasks/:id", async (req, reply) => {
    db.prepare("DELETE FROM tasks WHERE id = ?").run(req.params.id);
    sendAll("task.deleted", { id: req.params.id });
    return { ok: true };
  });
}

function normalize(t: any) {
  return {
    id: t.id, roomId: t.room_id, title: t.title,
    assigneeId: t.assignee_id, status: t.status,
    createdAt: t.created_at,
  };
}