import { db } from "../db.js";
import { config } from "../config.js";
import { runOpenCodeAgent, type AgentRunResult } from "./process-agent.js";
import { buildSystemPrompt } from "./prompts.js";

const HISTORY_LIMIT = 30;
const CONTENT_TRUNCATE = 800;

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type Row = { author_id: string; content: string; timestamp: number };

export function loadRoomThread(roomId: string, agentId: string): ChatMessage[] {
  const rows = db.prepare(`
    SELECT author_id, content, timestamp FROM messages
    WHERE room_id = ?
    ORDER BY timestamp DESC LIMIT ?
  `).all(roomId, HISTORY_LIMIT) as Row[];

  return rows.reverse().map((m) => ({
    role: m.author_id === agentId ? "assistant" : "user",
    content: `[${m.author_id} ${formatTime(m.timestamp)}]\n${truncate(m.content, CONTENT_TRUNCATE)}`,
  }));
}

export function enrichForHandoff(roomId: string, agentId: string, basePrompt: string): string {
  const thread = loadRoomThread(roomId, agentId);
  const historyText = thread
    .map((m) => `${m.role === "assistant" ? "[ASSISTANT]" : "[USER]"}\n${m.content}`)
    .join("\n\n");
  return `${basePrompt}\n\n[HISTORY]\n${historyText}\n\n[END HISTORY]\n`;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

export async function invokeAgent(opts: {
  agentId: string;
  roomId: string;
  prompt: string;
}): Promise<AgentRunResult & { enrichedPrompt: string }> {
  const basePrompt = buildSystemPrompt(opts.agentId);
  const enriched = enrichForHandoff(opts.roomId, opts.agentId, `${basePrompt}\n\n${opts.prompt}`);
  const ocAgent = config.agentMapping[opts.agentId] ?? opts.agentId;
  const result = await runOpenCodeAgent({
    agentName: opts.agentId,
    opencodeAgent: ocAgent,
    prompt: enriched,
  });
  return { ...result, enrichedPrompt: enriched };
}
