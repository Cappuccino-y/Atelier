import { appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ENABLED = process.env.AGENT_DEBUG !== "0";
const LOG_FILE = process.env.AGENT_DEBUG_FILE ?? join(__dirname, "../../../logs/agent-debug.log");

export function debugLog(
  section: string,
  roomId: string | undefined,
  agentId: string | undefined,
  message: string,
  extra?: unknown,
): void {
  if (!ENABLED) return;
  const line = [
    new Date().toISOString(),
    `[${section}]`,
    roomId ? `room=${roomId}` : "room=-",
    agentId ? `agent=${agentId}` : "agent=-",
    message,
    extra === undefined ? "" : JSON.stringify(extra),
  ]
    .filter(Boolean)
    .join(" ");
  try {
    appendFileSync(LOG_FILE, line + "\n", "utf8");
  } catch {
    /* debug logging must never break the runtime */
  }
  console.log(line);
}
