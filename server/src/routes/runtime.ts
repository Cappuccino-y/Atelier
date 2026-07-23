import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { cancelAllAgents, cancelRoomAgents } from "../agents/triggers.js";

export async function routes(app: FastifyInstance) {
  app.get("/api/runtime/status", async () => {
    return {
      runtime: config.agentRuntime,
      model: config.opencodeModel,
      handoffDepth: config.opencodeHandoffDepth,
      proserpinaUrl: config.proserpinaUrl,
      timestamp: Date.now(),
    };
  });

  app.post("/api/runtime/clear", async () => {
    return { ok: true };
  });

  /** Cancel every agent currently running in a room (or globally when roomId omitted). */
  app.post("/api/runtime/stop", async (req) => {
    const body = (req.body ?? {}) as { roomId?: string };
    const result = body.roomId
      ? { ...cancelRoomAgents(body.roomId), roomId: body.roomId }
      : { ...cancelAllAgents(), roomId: null as string | null };
    return { ok: true, ...result };
  });

  app.get("/api/runtime/debug-env", async () => {
    return {
      NODE_ENV: process.env.NODE_ENV,
      PORT: process.env.PORT,
      AGENT_RUNTIME: process.env.AGENT_RUNTIME,
      OPENCODE_MODEL: process.env.OPENCODE_MODEL,
    };
  });
}