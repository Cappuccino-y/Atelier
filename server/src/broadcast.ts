import type { WebSocket } from "@fastify/websocket";

const sockets = new Set<WebSocket>();

export function registerSocket(ws: WebSocket) {
  sockets.add(ws);
  ws.on("close", () => sockets.delete(ws));
}

export function sendAll(event: string, payload: unknown) {
  const msg = JSON.stringify({ event, payload, ts: Date.now() });
  for (const ws of sockets) {
    if (ws.readyState === 1) {
      try {
        ws.send(msg);
      } catch {}
    }
  }
}
