import type { FastifyInstance } from "fastify";
import { config } from "../config.js";

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

  app.get("/api/runtime/debug-env", async () => {
    return {
      NODE_ENV: process.env.NODE_ENV,
      PORT: process.env.PORT,
      AGENT_RUNTIME: process.env.AGENT_RUNTIME,
      OPENCODE_MODEL: process.env.OPENCODE_MODEL,
    };
  });
}