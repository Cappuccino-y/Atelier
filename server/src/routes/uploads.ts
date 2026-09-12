import type { FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { saveImageAttachment, resolveUploadFile } from "../uploads.js";

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export async function routes(app: FastifyInstance) {
  /**
   * Accept a base64-encoded image (no multipart dependency) and store it in
   * the room's workspace. Returns the attachment descriptor to embed in a
   * message via POST /api/rooms/:id/messages { attachments }.
   */
  app.post<{ Params: { id: string }; Body: { name?: string; mime?: string; dataB64?: string } }>(
    "/api/rooms/:id/uploads",
    { bodyLimit: 15 * 1024 * 1024 },
    async (req, reply) => {
      const { name, mime, dataB64 } = req.body ?? {};
      if (!mime || !dataB64) {
        return reply.code(400).send({ error: "mime and dataB64 required" });
      }
      if (!mime.startsWith("image/")) {
        return reply.code(415).send({ error: "only image uploads are supported" });
      }
      const raw = dataB64.includes(",") ? dataB64.slice(dataB64.indexOf(",") + 1) : dataB64;
      let buf: Buffer;
      try {
        buf = Buffer.from(raw, "base64");
      } catch {
        return reply.code(400).send({ error: "invalid base64 payload" });
      }
      if (buf.length === 0) return reply.code(400).send({ error: "empty upload" });
      if (buf.length > MAX_UPLOAD_BYTES) {
        return reply.code(413).send({ error: "image too large (max 10MB)" });
      }
      try {
        return saveImageAttachment(req.params.id, name ?? "image", mime, buf);
      } catch (err) {
        return reply.code(415).send({ error: err instanceof Error ? err.message : "upload failed" });
      }
    }
  );

  /** Serve stored uploads (chat rendering + agent-side references). */
  app.get<{ Params: { roomId: string; file: string } }>(
    "/uploads/:roomId/:file",
    async (req, reply) => {
      const p = resolveUploadFile(req.params.roomId, req.params.file);
      if (!p) return reply.code(404).send({ error: "not found" });
      const ext = extname(p).slice(1).toLowerCase();
      reply.header("Content-Type", MIME_BY_EXT[ext] ?? "application/octet-stream");
      reply.header("Cache-Control", "public, max-age=31536000, immutable");
      return reply.send(readFileSync(p));
    }
  );
}
