import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { nanoid } from "nanoid";
import { config } from "./config.js";

if (config.dbPath !== ":memory:") {
  mkdirSync(dirname(resolve(config.dbPath)), { recursive: true });
}

export const db = new Database(config.dbPath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    color TEXT NOT NULL,
    avatar TEXT NOT NULL,
    model TEXT NOT NULL,
    status TEXT NOT NULL,
    last_seen INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    topic TEXT NOT NULL,
    status TEXT NOT NULL,
    unread INTEGER NOT NULL DEFAULT 0,
    last_activity INTEGER NOT NULL,
    agent_ids TEXT NOT NULL DEFAULT '[]',
    notes TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    author_id TEXT NOT NULL,
    content TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    findings TEXT NOT NULL DEFAULT '[]',
    parent_id TEXT,
    mentioned_agent_ids TEXT NOT NULL DEFAULT '[]',
    timestamp INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    assignee_id TEXT,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    timestamp INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    room_ids TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_events_room ON events(room_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_tasks_room ON tasks(room_id);
`);

type CountRow = { count: number };

type SeedMessage = {
  id: string;
  roomId: string;
  authorId: string;
  content: string;
  tags: string[];
  findings: unknown[];
  parentId: string | null;
  mentionedAgentIds: string[];
  timestamp: number;
};

function seedDatabase() {
  const now = Date.now();
  const insertAgent = db.prepare(`
    INSERT OR IGNORE INTO agents (id, name, role, color, avatar, model, status, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertRoom = db.prepare(`
    INSERT OR IGNORE INTO rooms (id, name, topic, status, unread, last_activity, agent_ids, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertProject = db.prepare(`
    INSERT OR IGNORE INTO projects (id, name, room_ids, created_at)
    VALUES (?, ?, ?, ?)
  `);
  const insertMessage = db.prepare(`
    INSERT OR IGNORE INTO messages
      (id, room_id, author_id, content, tags, findings, parent_id, mentioned_agent_ids, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const seed = db.transaction(() => {
    const agents = [
      ["atlas", "Atlas", "orchestrator", "#8B5CF6", "A", config.opencodeModel, "online", now],
      ["forge", "Forge", "implementer", "#F97316", "F", config.opencodeModel, "idle", now],
      ["lens", "Lens", "reviewer", "#06B6D4", "L", config.opencodeModel, "idle", now],
      ["echo", "Echo", "support", "#22C55E", "E", config.opencodeModel, "idle", now],
      ["user", "You", "user", "#64748B", "U", "human", "online", now],
    ];
    for (const agent of agents) insertAgent.run(...agent);

    const rooms = [
      ["general", "General", "anything goes", "active", 0, now - 1 * 60_000, JSON.stringify(["atlas", "forge", "lens", "echo", "user"]), "", now],
      ["build-review", "Build Review", "code review", "active", 0, now - 4 * 60_000, JSON.stringify(["atlas", "forge", "lens", "user"]), "", now],
      ["research", "Research", "investigation", "active", 0, now - 2 * 60_000, JSON.stringify(["atlas", "echo", "user"]), "", now],
    ];
    for (const room of rooms) insertRoom.run(...room);

    const projects = [
      ["atelier-core", "Atelier Core", JSON.stringify(["general", "build-review"]), now],
      ["side-investigations", "Side Investigations", JSON.stringify(["research"]), now],
    ];
    for (const project of projects) insertProject.run(...project);

    const messages: SeedMessage[] = [
      {
        id: nanoid(),
        roomId: "general",
        authorId: "user",
        content: "Welcome to Atelier. Let’s coordinate the first build here. @Atlas",
        tags: ["QUESTION"],
        findings: [],
        parentId: null,
        mentionedAgentIds: ["atlas"],
        timestamp: now - 8 * 60_000,
      },
      {
        id: nanoid(),
        roomId: "general",
        authorId: "atlas",
        content: "I’ll route implementation work to @Forge and keep the room aligned.",
        tags: ["STATUS"],
        findings: [],
        parentId: null,
        mentionedAgentIds: ["forge"],
        timestamp: now - 7 * 60_000,
      },
      {
        id: nanoid(),
        roomId: "build-review",
        authorId: "user",
        content: "Please review the backend foundation and flag anything risky. @Lens",
        tags: ["TODO"],
        findings: [],
        parentId: null,
        mentionedAgentIds: ["lens"],
        timestamp: now - 6 * 60_000,
      },
      {
        id: nanoid(),
        roomId: "build-review",
        authorId: "forge",
        content: "The initial server foundation is in place. @Lens, please review the setup.",
        tags: ["RESULT"],
        findings: [],
        parentId: null,
        mentionedAgentIds: ["lens"],
        timestamp: now - 5 * 60_000,
      },
      {
        id: nanoid(),
        roomId: "build-review",
        authorId: "lens",
        content: "I’ll check schema constraints, startup behavior, and route loading. @Forge",
        tags: ["REVIEW"],
        findings: [],
        parentId: null,
        mentionedAgentIds: ["forge"],
        timestamp: now - 4 * 60_000,
      },
      {
        id: nanoid(),
        roomId: "research",
        authorId: "user",
        content: "Investigate a lightweight event model for room activity. @Echo",
        tags: ["TODO"],
        findings: [],
        parentId: null,
        mentionedAgentIds: ["echo"],
        timestamp: now - 3 * 60_000,
      },
      {
        id: nanoid(),
        roomId: "research",
        authorId: "echo",
        content: "The events table can keep typed JSON payloads while remaining easy to replay. @Atlas",
        tags: ["RESULT", "DECISION"],
        findings: [],
        parentId: null,
        mentionedAgentIds: ["atlas"],
        timestamp: now - 2 * 60_000,
      },
      {
        id: nanoid(),
        roomId: "general",
        authorId: "atlas",
        content: "The initial rooms are ready. We can continue with route implementations next.",
        tags: ["STATUS"],
        findings: [],
        parentId: null,
        mentionedAgentIds: [],
        timestamp: now - 1 * 60_000,
      },
    ];
    for (const message of messages) {
      insertMessage.run(
        message.id,
        message.roomId,
        message.authorId,
        message.content,
        JSON.stringify(message.tags),
        JSON.stringify(message.findings),
        message.parentId,
        JSON.stringify(message.mentionedAgentIds),
        message.timestamp,
      );
    }
  });

  seed();
}

const roomCount = db.prepare("SELECT COUNT(*) AS count FROM rooms").get() as CountRow;
if (roomCount.count === 0) seedDatabase();
