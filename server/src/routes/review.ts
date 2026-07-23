import type { FastifyInstance } from "fastify";
import { config } from "../config.js";

export async function routes(app: FastifyInstance) {
  app.get("/api/review/health", async () => {
    try {
      const r = await fetch(`${config.proserpinaUrl}/health`);
      return await r.json();
    } catch (err) {
      return { status: "unavailable", error: String(err) };
    }
  });

  app.post<{ Body: { document: string; panel?: string; context?: string; roomId?: string } }>("/api/review", async (req, reply) => {
    try {
      const r = await fetch(`${config.proserpinaUrl}/critique`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          document: req.body.document,
          panel: req.body.panel ?? "default",
          context: req.body.context ?? "",
        }),
      });
      return await r.json();
    } catch (err) {
      reply.code(502);
      return { error: "proserpina unavailable", detail: String(err) };
    }
  });
}