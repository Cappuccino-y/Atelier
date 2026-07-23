import type { FastifyInstance } from "fastify";

export async function routes(app: FastifyInstance) {
  app.post<{ Body: { level?: string; tag?: string; message: string; data?: any } }>("/api/debug/log", async (req) => {
    const { level, tag, message, data } = req.body ?? {};
    const ts = new Date().toISOString();
    // eslint-disable-next-line no-console
    console.log(`[${ts}] [client:${level ?? "info"}] ${tag ?? ""} ${message}`, data ?? "");
    return { ok: true };
  });
}