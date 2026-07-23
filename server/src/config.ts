import "dotenv/config";

function parseMapping(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of s.split(",")) {
    const [k, v] = pair.split(":");
    if (k && v) out[k.trim()] = v.trim();
  }
  return out;
}

export const config = {
  port: parseInt(process.env.PORT ?? "8787", 10),
  host: process.env.HOST ?? "127.0.0.1",
  agentRuntime: process.env.AGENT_RUNTIME ?? "opencode",
  opencodeModel: process.env.OPENCODE_MODEL ?? "minimax2/MiniMax-M3",
  opencodeTimeout: parseInt(process.env.OPENCODE_TIMEOUT ?? "600000", 10),
  opencodeHandoffDepth: parseInt(process.env.OPENCODE_HANDOFF_DEPTH ?? "50", 10),
  agentMapping: parseMapping(process.env.AGENT_MAPPING ?? "atlas:atlas,forge:build,lens:lens,echo:echo"),
  proserpinaUrl: process.env.PROSERPINA_URL ?? "http://127.0.0.1:8765",
  dbPath: process.env.DB_PATH ?? "./data/atelier.db",
  logDir: process.env.LOG_DIR ?? "../logs",
};
