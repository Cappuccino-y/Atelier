import type { WebSocket } from "@fastify/websocket";
import { nanoid } from "nanoid";
import { db } from "./db.js";

const sockets = new Set<WebSocket>();

const ACTIVITY_EVENTS = new Set([
  "agent.thinking",
  "agent.tool_call",
  "agent.step_done",
  "agent.error",
  "agent.completed",
  "agent.handoff",
]);

export function registerSocket(ws: WebSocket) {
  sockets.add(ws);
  ws.on("close", () => sockets.delete(ws));
}

export function sendAll(event: string, payload: unknown) {
  const msg = JSON.stringify({ event, payload, ts: Date.now() });
  for (const ws of sockets) {
    if (ws.readyState === 1) {
      try { ws.send(msg); } catch {}
    }
  }

  if (ACTIVITY_EVENTS.has(event) && payload && typeof payload === "object") {
    persistActivity(event, payload as Record<string, unknown>);
  }
}

function persistActivity(event: string, p: Record<string, unknown>) {
  try {
    const id = nanoid(12);
    const roomId = String(p.roomId ?? "");
    const agentId = p.agentId ? String(p.agentId) : null;
    const message = p.message ? String(p.message).slice(0, 200) : null;
    const meta = JSON.stringify({
      tool: p.tool,
      elapsedMs: p.elapsedMs,
      runId: p.runId,
    });
    const timestamp = typeof p.timestamp === "number" ? p.timestamp : Date.now();
    db.prepare(
      "INSERT OR IGNORE INTO activities (id, room_id, kind, agent_id, message, meta, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(id, roomId, event, agentId, message, meta, timestamp);
  } catch {
    // activity persistence is best-effort; never crash the broadcast
  }
}
