import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function parseMapping(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of s.split(",")) {
    const [k, v] = pair.split(":");
    if (k && v) out[k.trim()] = v.trim();
  }
  return out;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type AgentModelsConfig = {
  /** Model key used when an agent id has no entry in `models`. */
  default: string;
  /** Per-agent overrides: agent id -> opencode model key. */
  models: Record<string, string>;
  /** Named model aliases. Values starting with "preset:" are resolved against this map. */
  presets: Record<string, string>;
};

const DEFAULT_AGENT_MODELS: AgentModelsConfig = {
  default: "custom-saas/minimax-MiniMax-M3-cp",
  models: {},
  presets: {},
};

function loadAgentModelsConfig(): AgentModelsConfig {
  const candidates = [
    process.env.AGENT_MODELS_FILE,
    join(__dirname, "..", "agent-models.json"),
    join(process.cwd(), "agent-models.json"),
  ].filter(Boolean) as string[];

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw) as Partial<AgentModelsConfig> & {
        $schema?: string;
        notes?: unknown;
      };
      // strip schema/notes which are not part of the runtime shape
      const { $schema: _schema, notes: _notes, ...rest } = parsed;
      return {
        default: typeof rest.default === "string" && rest.default.length > 0
          ? rest.default
          : DEFAULT_AGENT_MODELS.default,
        models: (rest.models && typeof rest.models === "object") ? rest.models : {},
        presets: (rest.presets && typeof rest.presets === "object") ? rest.presets : {},
      };
    } catch (err) {
      console.warn(`[config] failed to parse ${path}:`, err);
      // fall through to next candidate
    }
  }
  return DEFAULT_AGENT_MODELS;
}

const _envOpencodeModel = process.env.OPENCODE_MODEL ?? "minimax2/MiniMax-M3";

export const config = {
  port: parseInt(process.env.PORT ?? "8787", 10),
  host: process.env.HOST ?? "127.0.0.1",
  agentRuntime: process.env.AGENT_RUNTIME ?? "opencode",
  /**
   * Default model when no per-agent override and no `default` in agent-models.json.
   * Backed by OPENCODE_MODEL env var for backwards compatibility.
   */
  opencodeModel: _envOpencodeModel,
  opencodeTimeout: parseInt(process.env.OPENCODE_TIMEOUT ?? "600000", 10),
  opencodeHandoffDepth: parseInt(process.env.OPENCODE_HANDOFF_DEPTH ?? "50", 10),
  agentMapping: parseMapping(process.env.AGENT_MAPPING ?? "atlas:atlas,forge:build,lens:lens,echo:echo"),
  proserpinaUrl: process.env.PROSERPINA_URL ?? "http://127.0.0.1:8765",
  dbPath: process.env.DB_PATH ?? "./data/atelier.db",
  logDir: process.env.LOG_DIR ?? "../logs",
};

/**
 * Resolve the model key for a given agent id.
 *
 * Lookup order (first match wins):
 *   1. agent-models.json `models[agentId]`
 *   2. agent-models.json `default`
 *   3. config.opencodeModel (env-backed fallback)
 *
 * Supports the `preset:<name>` shorthand: if the configured value starts
 * with `preset:`, the suffix is looked up in `presets`.
 */
export function resolveAgentModel(
  agentId: string,
  agentModels: AgentModelsConfig = loadAgentModelsConfig(),
): string {
  const lookup = (raw: string | undefined): string | undefined => {
    if (!raw) return undefined;
    if (raw.startsWith("preset:")) {
      const presetName = raw.slice("preset:".length).trim();
      return lookup(agentModels.presets[presetName]);
    }
    return raw;
  };
  return lookup(agentModels.models[agentId])
    ?? lookup(agentModels.default)
    ?? config.opencodeModel;
}

/**
 * Re-read agent-models.json from disk. Useful after the file is edited —
 * callers can hold the previous config for one request while fetching the
 * new one for the next.
 */
export function reloadAgentModelsConfig(): AgentModelsConfig {
  return loadAgentModelsConfig();
}