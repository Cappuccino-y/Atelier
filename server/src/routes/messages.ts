import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { db } from "../db.js";
import { triggerOnMessage, extractMentions, extractTags } from "../agents/triggers.js";
import { sendAll } from "../broadcast.js";
import { deleteAttachmentFile, type Attachment } from "../uploads.js";
import { abortRun, listRuns } from "../agents/process-agent.js";

export async function routes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>("/api/rooms/:id/messages", async (req) => {
    const rows = db.prepare("SELECT * FROM messages WHERE room_id = ? ORDER BY timestamp ASC").all(req.params.id) as any[];
    return rows.map(normalizeMessage);
  });

  app.post<{ Params: { id: string }; Body: { content?: string; authorId?: string; mentionedAgentIds?: string[]; attachments?: Array<Partial<Attachment>> } }>("/api/rooms/:id/messages", async (req, reply) => {
    const content = typeof req.body.content === "string" ? req.body.content : "";
    const authorId = req.body.authorId ?? "user";
    // Attachments must reference this room's own uploads (no arbitrary URLs).
    const attachments: Attachment[] = Array.isArray(req.body.attachments)
      ? req.body.attachments
          .filter((a): a is Attachment =>
            Boolean(a && typeof a.url === "string" && a.url.startsWith(`/uploads/${req.params.id}/`)))
          .slice(0, 6)
          .map((a) => ({
            id: String(a.id ?? nanoid()),
            name: String(a.name ?? "image"),
            mime: String(a.mime ?? "image/*"),
            size: Number(a.size) || 0,
            url: String(a.url),
          }))
      : [];
    if (!content.trim() && attachments.length === 0) {
      return reply.code(400).send({ error: "content required" });
    }

    const id = nanoid();
    const ts = Date.now();
    const tags = extractTags(content);
    // Explicit mention list (from the Composer's parsed mentions) wins; fall
    // back to parsing the text so plain "@Forge hi" still routes correctly.
    const mentions = Array.isArray(req.body.mentionedAgentIds) && req.body.mentionedAgentIds.length > 0
      ? req.body.mentionedAgentIds.map((aId) => ({ id: aId, name: aId }))
      : extractMentions(content);

    db.prepare(`INSERT INTO messages (id, room_id, author_id, content, tags, mentioned_agent_ids, attachments, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, req.params.id, authorId, content, JSON.stringify(tags), JSON.stringify(mentions.map(m => m.id)), JSON.stringify(attachments), ts);

    db.prepare("UPDATE rooms SET last_activity = ? WHERE id = ?").run(ts, req.params.id);

    const msg = normalizeMessage(db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as any);
    sendAll("message.created", msg);

    // trigger agents async
    triggerOnMessage({
      roomId: req.params.id,
      authorId,
      content,
      parentMessageId: id,
      source: "user",
      mentionedAgentIds: mentions.map((m) => m.id),
    }).catch(err => {
      console.error("trigger error", err);
    });

    return msg;
  });

  /**
   * Interrupt-and-steer: abort every live run in the room, then route the
   * user's correction + an interrupt report (what was running, for how long,
   * last command) to the mentioned agent (default: atlas). The aborted runs
   * settle as cancelled:true — clean, no failure branches.
   */
  app.post<{ Params: { id: string }; Body: { content?: string; mentionedAgentIds?: string[] } }>("/api/rooms/:id/interrupt-steer", async (req, reply) => {
    const roomId = req.params.id;
    const userText = typeof req.body.content === "string" ? req.body.content.trim() : "";
    if (!userText) return reply.code(400).send({ error: "content required" });

    // 1. snapshot live runs BEFORE aborting (for the report)
    const live = listRuns().filter(r => r.roomId === roomId);

    // 2. abort all runs in this room (cancelled:true semantics)
    let aborted = 0;
    for (const run of live) {
      if (abortRun(run.runId)) aborted++;
    }

    // 3. build the interrupt report
    const now = Date.now();
    const reportLines: string[] = [];
    if (live.length === 0) {
      reportLines.push("（没有正在运行的 agent——直接处理下面的纠偏指示。）");
    } else {
      reportLines.push(`已中断 ${aborted} 个正在运行的任务：`);
      for (const run of live) {
        const elapsed = Math.max(1, Math.round((now - run.startedAt) / 1000));
        const tool = run.lastTool ? `，最后在执行 \`${run.lastTool}\`${run.lastInput ? `: ${run.lastInput}` : ""}` : "，尚未开始工具调用";
        reportLines.push(`- @${run.agentId} 已运行 ${elapsed}s${tool}`);
      }
    }
    const report = reportLines.join("\n");

    // 4. route to the mentioned agent — explicit mentions win, else atlas
    const mentions = Array.isArray(req.body.mentionedAgentIds) && req.body.mentionedAgentIds.length > 0
      ? req.body.mentionedAgentIds.map((aId) => ({ id: aId, name: aId }))
      : extractMentions(userText);
    const targetIds = mentions.length > 0 ? mentions.map(m => m.id) : ["atlas"];

    const prompt = [
      "[用户中断纠偏] 上面的任务已被人工中断，以下是现场状态和新的指示。",
      "",
      report,
      "",
      "请基于中断前的进度和用户的新指示，重新规划或直接执行。不要重复已完成的步骤。",
      "",
      `用户指示：${userText}`,
    ].join("\n");

    // 5. persist as a user message (visible in the room timeline)
    const id = nanoid();
    const ts = Date.now();
    const content = `⏸ [中断纠偏] ${userText}`;
    const tags = extractTags(content);
    db.prepare(`INSERT INTO messages (id, room_id, author_id, content, tags, mentioned_agent_ids, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, roomId, "user", content, JSON.stringify(tags), JSON.stringify(targetIds), ts);
    db.prepare("UPDATE rooms SET last_activity = ? WHERE id = ?").run(ts, roomId);
    const msg = normalizeMessage(db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as any);
    sendAll("message.created", msg);

    // 6. trigger the target agent(s) with the steering prompt
    for (const t of targetIds) {
      triggerOnMessage({
        roomId,
        authorId: "user",
        content: prompt,
        parentMessageId: id,
        source: "user",
        mentionedAgentIds: [t],
      }).catch(err => console.error("interrupt-steer trigger error", err));
    }

    return { ok: true, aborted, runs: live.map(r => ({ agentId: r.agentId, runId: r.runId })), messageId: id };
  });

  app.post<{ Params: { roomId: string; messageId: string }; Body: { emoji: string; userId?: string } }>(
    "/api/rooms/:roomId/messages/:messageId/reactions",
    async (req, reply) => {
      const { emoji } = req.body;
      const userId = req.body.userId ?? "user";
      if (!emoji) return reply.code(400).send({ error: "emoji required" });

      const row = db.prepare("SELECT * FROM messages WHERE id = ?").get(req.params.messageId) as any;
      if (!row) return reply.code(404).send({ error: "message not found" });

      // Toggle semantics — each user gets at most one vote per emoji.
      // reactor ids are stored alongside the count so we can both dedupe
      // and (later) render per-user highlight in the UI.
      const reactions = JSON.parse(row.reactions || "{}") as Record<string, { count: number; reactors: string[] }>;
      const existing = reactions[emoji];
      if (existing) {
        const reactors = existing.reactors ?? [];
        const idx = reactors.indexOf(userId);
        if (idx >= 0) {
          reactors.splice(idx, 1);
        } else {
          reactors.push(userId);
        }
        existing.count = reactors.length;
        if (existing.count === 0) delete reactions[emoji];
      } else {
        reactions[emoji] = { count: 1, reactors: [userId] };
      }

      db.prepare("UPDATE messages SET reactions = ? WHERE id = ?")
        .run(JSON.stringify(reactions), req.params.messageId);

      const updated = normalizeMessage(db.prepare("SELECT * FROM messages WHERE id = ?").get(req.params.messageId) as any);
      sendAll("message.updated", updated);
      return updated;
    }
  );

  // Delete a single message from the room history (user housekeeping —
  // removes noise like zombie/error rows). Broadcasts message.deleted so
  // every connected client drops it from its list.
  app.delete<{ Params: { roomId: string; messageId: string } }>(
    "/api/rooms/:roomId/messages/:messageId",
    async (req, reply) => {
      const row = db.prepare("SELECT id, attachments FROM messages WHERE id = ? AND room_id = ?")
        .get(req.params.messageId, req.params.roomId) as { id: string; attachments: string } | undefined;
      if (!row) return reply.code(404).send({ error: "message not found" });
      db.prepare("DELETE FROM messages WHERE id = ?").run(req.params.messageId);
      // Best-effort: remove uploaded files this message owned.
      try {
        const atts = JSON.parse(row.attachments || "[]") as Array<{ url?: string }>;
        for (const a of atts) if (a?.url) deleteAttachmentFile(req.params.roomId, a.url);
      } catch { /* ignore malformed attachments */ }
      sendAll("message.deleted", {
        roomId: req.params.roomId,
        messageId: req.params.messageId,
      });
      return { ok: true };
    }
  );

  // Finding lifecycle — accept/reject a single finding (by index) or all at
  // once. Persists the decision on the message row so it survives reloads and
  // re-broadcasts the findings state to every connected client.
  app.patch<{ Params: { roomId: string; messageId: string }; Body: { index: number | "all"; decision: "accepted" | "rejected" } }>(
    "/api/rooms/:roomId/messages/:messageId/findings",
    async (req, reply) => {
      const { decision } = req.body;
      const index = req.body.index;
      if (decision !== "accepted" && decision !== "rejected") {
        return reply.code(400).send({ error: "decision must be accepted|rejected" });
      }

      const row = db.prepare("SELECT * FROM messages WHERE id = ?").get(req.params.messageId) as any;
      if (!row) return reply.code(404).send({ error: "message not found" });

      let findings: any[] = [];
      try { findings = JSON.parse(row.findings || "[]"); } catch { findings = []; }
      if (findings.length === 0) return reply.code(409).send({ error: "message has no findings" });

      if (index === "all") {
        for (const f of findings) f.decision = decision;
      } else {
        if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= findings.length) {
          return reply.code(400).send({ error: `index out of range (0..${findings.length - 1})` });
        }
        findings[index].decision = decision;
      }

      db.prepare("UPDATE messages SET findings = ? WHERE id = ?")
        .run(JSON.stringify(findings), req.params.messageId);

      const updated = normalizeMessage(db.prepare("SELECT * FROM messages WHERE id = ?").get(req.params.messageId) as any);
      sendAll(decision === "accepted" ? "finding.accepted" : "finding.rejected", {
        roomId: req.params.roomId,
        messageId: req.params.messageId,
        index,
      });
      sendAll("message.updated", updated);
      return updated;
    }
  );
}

function normalizeMessage(m: any) {
  return {
    id: m.id, roomId: m.room_id, authorId: m.author_id,
    content: m.content,
    tags: JSON.parse(m.tags || "[]"),
    findings: m.findings ? JSON.parse(m.findings) : null,
    parentId: m.parent_id,
    mentionedAgentIds: JSON.parse(m.mentioned_agent_ids || "[]"),
    reactions: JSON.parse(m.reactions || "{}"),
    attachments: JSON.parse(m.attachments || "[]"),
    timestamp: m.timestamp,
  };
}