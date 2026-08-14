import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { killRun, killRunByKey } from "../agents/process-agent.js";

export async function routes(app: FastifyInstance) {
  app.get("/api/agents", async () => {
    const rows = db.prepare("SELECT * FROM agents ORDER BY name").all() as any[];
    return rows.map(normalize);
  });

  app.post<{ Body: { id: string; name: string; role?: string; color?: string; avatar?: string; model?: string } }>("/api/agents", async (req, reply) => {
    const { id, name, role, color, avatar, model } = req.body;
    if (!id || !name) return reply.code(400).send({ error: "id and name required" });
    db.prepare(`INSERT OR REPLACE INTO agents (id, name, role, color, avatar, model, status, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, name, role ?? "agent", color ?? "#888", avatar ?? "", model ?? "", "offline", Date.now());
    return normalize(db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as any);
  });

  app.patch<{ Params: { id: string }; Body: { status?: string } }>("/api/agents/:id/status", async (req, reply) => {
    const { status } = req.body;
    db.prepare("UPDATE agents SET status = ?, last_seen = ? WHERE id = ?").run(status, Date.now(), req.params.id);
    const row = db.prepare("SELECT * FROM agents WHERE id = ?").get(req.params.id) as any;
    if (!row) return reply.code(404).send({ error: "not found" });
    return normalize(row);
  });

  app.post<{ Body: { roomId: string; agentId?: string; runId?: string } }>("/api/agents/stop", async (req) => {
    const { roomId, agentId, runId } = req.body ?? ({} as any);
    // Exact runId first, then room/agent alias keys — both are now registered
    // for every live run, so a Stop without runId actually works.
    let killed = 0;
    if (runId) {
      if (killRun(runId)) killed = 1;
    } else if (agentId && roomId) {
      const candidates = [`${roomId}:${agentId}`, agentId];
      for (const key of candidates) {
        if (killRunByKey(key)) killed++;
      }
    } else {
      return { ok: false, error: "roomId + agentId (or runId) required" } as any;
    }
    return { ok: true, killed };
  });
}

function normalize(a: any) {
  return {
    id: a.id, name: a.name, role: a.role,
    color: a.color, avatar: a.avatar, model: a.model,
    status: a.status, lastSeen: a.last_seen,
  };
}