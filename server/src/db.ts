import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { nanoid } from "nanoid";
import { config, resolveAgentModel } from "./config.js";

if (config.dbPath !== ":memory:") {
  mkdirSync(dirname(resolve(config.dbPath)), { recursive: true });
}

export const db = new Database(config.dbPath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

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
    reactions TEXT NOT NULL DEFAULT '{}',
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

  CREATE TABLE IF NOT EXISTS activities (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    agent_id TEXT,
    message TEXT,
    meta TEXT NOT NULL DEFAULT '{}',
    timestamp INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_events_room ON events(room_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_tasks_room ON tasks(room_id);
  CREATE INDEX IF NOT EXISTS idx_activities_room ON activities(room_id, timestamp DESC);
`);

// Summarization checkpoints — per-(room, profile) rolling LLM summaries of
// older history. Loaded by runtime.ts alongside raw messages to keep the
// injected context window bounded without losing prior reasoning. Replaces
// the "drop everything past the budget" hard cutoff that the previous
// implementation used (which simply lost earlier turns entirely).
db.exec(`
  CREATE TABLE IF NOT EXISTS message_summaries (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    profile_key TEXT NOT NULL,
    up_to_message_id TEXT NOT NULL,
    up_to_timestamp INTEGER NOT NULL,
    summary TEXT NOT NULL,
    covered_count INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_summaries_lookup
    ON message_summaries(room_id, profile_key, up_to_timestamp DESC);
`);

// Additive migrations — older DB files predated these columns and CREATE
// TABLE IF NOT EXISTS won't add them. Try/catch so already-migrated DBs
// don't blow up on startup.
try { db.exec("ALTER TABLE messages ADD COLUMN reactions TEXT NOT NULL DEFAULT '{}'"); } catch {}
try { db.exec("ALTER TABLE rooms ADD COLUMN project_id TEXT"); } catch {}

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
    // v2 roster: 10 agents (5 existing + 5 new specialists) + user.
    // model field is the opencode model key — resolved from agent-models.json
    // (with env fallback) so the DB always reflects what actually runs.
    const agents: Array<[string, string, string, string, string, string, string, number]> = [
      ["atlas",     "Atlas",     "orchestrator", "#8B5CF6", "A", resolveAgentModel("atlas"),     "online", now],
      ["forge",     "Forge",     "implementer",  "#F97316", "F", resolveAgentModel("forge"),     "idle",   now],
      ["lens",      "Lens",      "reviewer",     "#06B6D4", "L", resolveAgentModel("lens"),      "idle",   now],
      ["echo",      "Echo",      "support",      "#22C55E", "E", resolveAgentModel("echo"),      "idle",   now],
      ["trainer",   "Trainer",   "kb-curator",   "#A855F7", "T", resolveAgentModel("trainer"),   "idle",   now],
      ["scout",     "Scout",     "researcher",   "#10B981", "S", resolveAgentModel("scout"),     "idle",   now],
      ["analyst",   "Analyst",   "analyst",      "#F59E0B", "Y", resolveAgentModel("analyst"),   "idle",   now],
      ["writer",    "Writer",    "writer",       "#3B82F6", "W", resolveAgentModel("writer"),    "idle",   now],
      ["archivist", "Archivist", "archivist",    "#6366F1", "R", resolveAgentModel("archivist"), "idle",   now],
      ["user",      "You",       "user",         "#64748B", "U", "human",                       "online", now],
    ];
    for (const agent of agents) insertAgent.run(...agent);

    // Rooms with full agent rosters. Each room shows the specialists
    // most relevant to its topic in the sidebar invite dropdown.
    const rooms = [
      ["general",       "General",       "anything goes", "active", 0, now - 1 * 60_000, JSON.stringify(["atlas","forge","lens","echo","scout","analyst","writer","user"]), "", now],
      ["build-review",  "Build Review",  "code review",   "active", 0, now - 4 * 60_000, JSON.stringify(["atlas","forge","lens","user"]), "", now],
      ["research",      "Research",      "investigation", "active", 0, now - 2 * 60_000, JSON.stringify(["atlas","scout","analyst","writer","echo","user"]), "", now],
      ["kb-curation",   "KB Curation",   "memory writes", "active", 0, now - 1 * 60_000, JSON.stringify(["atlas","archivist","trainer","echo","user"]), "", now],
      ["visual-review", "Visual Review", "screenshots",   "active", 0, now - 1 * 60_000, JSON.stringify(["atlas","lens","writer","analyst","user"]), "", now],
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

    // Roster migration: every room should roster all agents except "user".
    // New rooms do this at creation; this backfills older rooms so the
    // Agents panel doesn't hide agents that merely weren't seeded.
    const rosterAgents = agents.filter((a) => a[0] !== "user").map((a) => a[0]);
    const roomRows = db.prepare("SELECT id, agent_ids FROM rooms").all() as Array<{ id: string; agent_ids: string }>;
    for (const room of roomRows) {
      const ids: string[] = JSON.parse(room.agent_ids || "[]");
      let changed = false;
      for (const id of rosterAgents) {
        if (!ids.includes(id)) { ids.push(id); changed = true; }
      }
      if (changed) {
        db.prepare("UPDATE rooms SET agent_ids = ? WHERE id = ?").run(JSON.stringify(ids), room.id);
      }
    }
  });

  seed();
}

const roomCount = db.prepare("SELECT COUNT(*) AS count FROM rooms").get() as CountRow;
const seeded = db.prepare("SELECT value FROM meta WHERE key = 'seed_db'").get() as { value: string } | undefined;
if (!seeded && roomCount.count === 0) seedDatabase();
// Mark the first-time seed as done even if it was skipped (rooms already
// existed) so a user deleting ALL rooms does not resurrect the preset rooms
// on the next start. The seed is a one-time initialization, not a migration
// that re-runs on every boot.
if (!seeded) db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('seed_db', '1')").run();

/**
 * Migration: ensure all v2 agents exist in the agents table, even on
 * databases that were seeded with the v1 (4-agent) roster. Runs on
 * every server start; uses INSERT OR IGNORE so it's idempotent.
 *
 * Each entry: [id, name, role, color, avatar]. The model is resolved via
 * resolveAgentModel() (agent-models.json, env fallback) so the DB column
 * always reflects what actually runs — same source of truth as the seed.
 */
const V2_AGENT_DEFAULTS: Array<[string, string, string, string, string]> = [
  ["atlas",     "Atlas",     "orchestrator", "#8B5CF6", "A"],
  ["forge",     "Forge",     "implementer",  "#F97316", "F"],
  ["lens",      "Lens",      "reviewer",     "#06B6D4", "L"],
  ["echo",      "Echo",      "support",      "#22C55E", "E"],
  ["trainer",   "Trainer",   "kb-curator",   "#A855F7", "T"],
  ["scout",     "Scout",     "researcher",   "#10B981", "S"],
  ["analyst",   "Analyst",   "analyst",      "#F59E0B", "Y"],
  ["writer",    "Writer",    "writer",       "#3B82F6", "W"],
  ["archivist", "Archivist", "archivist",    "#6366F1", "R"],
];

function migrateAgentsV2(): void {
  const now = Date.now();
  const insertAgent = db.prepare(`
    INSERT OR IGNORE INTO agents (id, name, role, color, avatar, model, status, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, 'idle', ?)
  `);
  for (const [id, name, role, color, avatar] of V2_AGENT_DEFAULTS) {
    insertAgent.run(id, name, role, color, avatar, resolveAgentModel(id), now);
  }
  // Vis merged into Lens (v2.2) — remove the legacy agent so the UI/roster
  // no longer offers it. Historical @Vis messages keep their author_id.
  db.prepare(`DELETE FROM agents WHERE id = 'vis'`).run();
}
migrateAgentsV2();

/**
 * Migration: ensure new rooms exist (kb-curation, visual-review).
 * Runs ONCE (flagged in the meta table). Without the flag, every start
 * re-inserted these preset rooms with INSERT OR IGNORE — a user who
 * deleted them saw them resurrect on the next `atelier start`.
 */
function migrateRoomsV2(): void {
  const done = db.prepare("SELECT value FROM meta WHERE key = 'rooms_v2_migrated'").get() as { value: string } | undefined;
  if (done) return;
  const now = Date.now();
  const insertRoom = db.prepare(`
    INSERT OR IGNORE INTO rooms (id, name, topic, status, unread, last_activity, agent_ids, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const newRooms: Array<[string, string, string, string, number, number, string, string, number]> = [
    ["kb-curation",   "KB Curation",   "memory writes", "active", 0, now - 1 * 60_000, JSON.stringify(["atlas","archivist","trainer","echo","user"]), "", now],
    ["visual-review", "Visual Review", "screenshots",   "active", 0, now - 1 * 60_000, JSON.stringify(["atlas","vis","writer","analyst","user"]), "", now],
  ];
  for (const r of newRooms) insertRoom.run(...r);
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('rooms_v2_migrated', '1')").run();
}
migrateRoomsV2();
