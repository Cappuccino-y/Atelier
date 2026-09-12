import { mkdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { nanoid } from "nanoid";
import { config } from "./config.js";

/**
 * Image attachments for chat messages.
 *
 * Files live under `<agentWorkspace>/rooms/<roomId>/uploads/` — the SAME
 * directory tree that agent runs use as their cwd (see process-agent.ts),
 * so a prompt can reference `uploads/<file>` relatively and any agent with
 * the read tool can view the image with its multimodal model.
 */
export type Attachment = {
  id: string;
  /** original filename, for display */
  name: string;
  mime: string;
  size: number;
  /** served URL: /uploads/<roomId>/<storedName> */
  url: string;
};

const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const ROOM_ID_RE = /^[A-Za-z0-9_-]+$/;
const FILE_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/;

export function uploadsDirFor(roomId: string): string {
  return join(config.agentWorkspace, "rooms", roomId, "uploads");
}

function safeDisplayName(name: string): string {
  const cleaned = name.replace(/[\\/]/g, "_").trim();
  return cleaned.slice(0, 120) || "image";
}

/** Persist an uploaded image; returns the attachment descriptor. */
export function saveImageAttachment(
  roomId: string,
  name: string,
  mime: string,
  buf: Buffer,
): Attachment {
  const ext = IMAGE_EXT[mime];
  if (!ext) throw new Error(`unsupported image type: ${mime}`);
  if (!ROOM_ID_RE.test(roomId)) throw new Error("invalid room id");
  const dir = uploadsDirFor(roomId);
  mkdirSync(dir, { recursive: true });
  const id = nanoid();
  const file = `${id}.${ext}`;
  writeFileSync(join(dir, file), buf);
  return {
    id,
    name: safeDisplayName(name),
    mime,
    size: buf.length,
    url: `/uploads/${roomId}/${file}`,
  };
}

/** Resolve a served file to an on-disk path, or null when unsafe/missing. */
export function resolveUploadFile(roomId: string, file: string): string | null {
  if (!ROOM_ID_RE.test(roomId) || !FILE_RE.test(file)) return null;
  const base = resolve(uploadsDirFor(roomId));
  const p = resolve(base, file);
  if (!p.startsWith(base)) return null;
  return existsSync(p) ? p : null;
}

/** `uploads/<file>` — path relative to the agent's cwd, for prompt refs. */
export function attachmentRelPath(url: string): string | null {
  const m = /^\/uploads\/([^/]+)\/([^/]+)$/.exec(url);
  return m && ROOM_ID_RE.test(m[1]) && FILE_RE.test(m[2]) ? `uploads/${m[2]}` : null;
}

/** Best-effort cleanup when a message carrying attachments is deleted. */
export function deleteAttachmentFile(roomId: string, url: string): void {
  const m = /^\/uploads\/([^/]+)\/([^/]+)$/.exec(url ?? "");
  if (!m || m[1] !== roomId) return;
  const p = resolveUploadFile(m[1], m[2]);
  if (p) {
    try { unlinkSync(p); } catch { /* already gone */ }
  }
}
