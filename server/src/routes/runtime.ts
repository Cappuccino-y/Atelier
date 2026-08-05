import type { FastifyInstance } from "fastify";
import { writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config, resolveAgentModel, reloadAgentModelsConfig, type AgentModelsConfig } from "../config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const AGENT_MODELS_PATH = join(__dirname, "..", "agent-models.json");

/**
 * Strip schema/notes keys (not part of the runtime shape) before persisting.
 * Anything the user has under `_comment` or `notes` is preserved as-is so we
 * don't lose documentation when round-tripping.
 */
function sanitizeForPersist(parsed: Record<string, unknown>): AgentModelsConfig & Record<string, unknown> {
  const out: Record<string, unknown> = { ...parsed };
  if (!out.default || typeof out.default !== "string") {
    out.default = config.opencodeModel;
  }
  if (!out.models || typeof out.models !== "object") out.models = {};
  if (!out.presets || typeof out.presets !== "object") out.presets = {};
  return out as AgentModelsConfig & Record<string, unknown>;
}

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

  /**
   * Returns the current per-agent model config + the resolved model for
   * each known agent. The resolved field is what runtime.ts will actually
   * pass to opencode — handy for debugging without restarting the server.
   */
  app.get("/api/runtime/agent-models", async () => {
    const cfg = reloadAgentModelsConfig();
    const knownAgents = [
      ...Object.keys(cfg.models),
      ...Object.keys(config.agentMapping),
    ].filter((v, i, a) => a.indexOf(v) === i).sort();

    const resolved: Record<string, string> = {};
    for (const id of knownAgents) {
      resolved[id] = resolveAgentModel(id, cfg);
    }
    return {
      path: AGENT_MODELS_PATH,
      exists: existsSync(AGENT_MODELS_PATH),
      config: cfg,
      resolved,
    };
  });

  /**
   * Replace the per-agent model config on disk. Body:
   *   { config: { default, models, presets, notes? } }
   *
   * Note: this writes to disk atomically (tmp + rename) but does NOT
   * modify the in-memory `config.opencodeModel` (env-bound). Subsequent
   * requests will re-read agent-models.json on next agent invocation
   * via `resolveAgentModel()`.
   */
  app.put<{ Body: { config: Record<string, unknown> } }>(
    "/api/runtime/agent-models",
    async (req, reply) => {
      const body = req.body;
      if (!body || typeof body !== "object" || !body.config || typeof body.config !== "object") {
        return reply.code(400).send({ error: "body.config must be an object" });
      }
      const cleaned = sanitizeForPersist(body.config);
      const tmp = AGENT_MODELS_PATH + ".tmp";
      writeFileSync(tmp, JSON.stringify(cleaned, null, 2) + "\n", "utf8");
      // rename is atomic on same volume
      const { renameSync } = await import("node:fs");
      renameSync(tmp, AGENT_MODELS_PATH);
      const reloaded = reloadAgentModelsConfig();
      return { ok: true, config: reloaded };
    },
  );

  /**
   * Lightweight proxy to refresh in-memory caches. Currently a no-op since
   * `resolveAgentModel` reads from disk on every call, but exposed for
   * symmetry / future use.
   */
  app.post("/api/runtime/agent-models/reload", async () => {
    const reloaded = reloadAgentModelsConfig();
    return { ok: true, config: reloaded };
  });
}