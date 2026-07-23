import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { db } from "../db.js";

export async function routes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>("/api/rooms/:id/events", async (req) => {
    const rows = db.prepare("SELECT * FROM events WHERE room_id = ? ORDER BY timestamp ASC LIMIT 1000").all(req.params.id) as any[];
    return rows.map(normalize);
  });

  app.get("/api/events", async () => {
    const rows = db.prepare("SELECT * FROM events ORDER BY timestamp DESC LIMIT 500").all() as any[];
    return rows.map(normalize);
  });
}

export function recordEvent(roomId: string, type: string, payload: any) {
  const id = nanoid();
  const ts = Date.now();
  db.prepare("INSERT INTO events (id, room_id, type, payload, timestamp) VALUES (?, ?, ?, ?, ?)")
    .run(id, roomId, type, JSON.stringify(payload ?? {}), ts);
}

function normalize(e: any) {
  return {
    id: e.id, roomId: e.room_id, type: e.type,
    payload: JSON.parse(e.payload || "{}"),
    timestamp: e.timestamp,
  };
}