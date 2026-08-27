// CP1 runtime probe: invoke loadRoomThread for different agents in the
// same room and confirm the filtered counts differ per role.
import assert from "node:assert/strict";
import { db } from "../src/db.js";
import { loadRoomThread, getRoleProfile, ROLE_CONTEXT_PROFILE } from "../src/agents/runtime.js";

const roomId = "test_role_thread_" + Date.now();
const now = Date.now();
db.prepare(`INSERT INTO rooms (id, name, topic, status, unread, last_activity, agent_ids, notes, created_at)
            VALUES (?, 'CP1 Role Thread', 'role filter test', 'active', 0, ?, '["atlas","forge","lens","scout","echo"]', '', ?)`)
  .run(roomId, now, now);

// Seed 20 messages with varied authors.
const authors = ["user", "atlas", "scout", "forge", "lens", "echo"];
let ts = now - 60_000;
const insertedIds = [];
for (let i = 0; i < 20; i++) {
  const author = authors[i % authors.length];
  const id = "msg_" + Math.random().toString(36).slice(2);
  db.prepare(`INSERT INTO messages (id, room_id, author_id, content, tags, findings, parent_id, mentioned_agent_ids, timestamp)
              VALUES (?, ?, ?, ?, '[]', '[]', NULL, '[]', ?)`)
    .run(id, roomId, author, `Message #${i} from ${author} with some content`, ts);
  insertedIds.push({ id, author });
  ts += 2000;
}
console.log(`Seeded 20 messages across ${authors.length} authors`);

const profileTable = Object.entries(ROLE_CONTEXT_PROFILE);
console.log("\n--- ROLE_CONTEXT_PROFILE ---");
for (const [id, p] of profileTable) {
  const allowed = p.allowedAuthors === "all" ? "all" : p.allowedAuthors.join(",");
  console.log(`  ${id.padEnd(10)} historyLimit=${p.historyLimit}  authors=${allowed.padEnd(40)}  truncate=${p.otherTruncate}  strip=${!p.keepIntermediate}`);
}

// --- Test: each role's filtered history has expected composition
function describe(thread) {
  const counts = {};
  for (const m of thread) {
    const head = m.content.match(/^\[(\w+)/);
    const who = head ? head[1] : "?";
    counts[who] = (counts[who] ?? 0) + 1;
  }
  return counts;
}

for (const role of Object.keys(ROLE_CONTEXT_PROFILE)) {
  const thread = loadRoomThread(roomId, role);
  const comp = describe(thread);
  const p = ROLE_CONTEXT_PROFILE[role];
  const allowed = p.allowedAuthors === "all" ? null : new Set(p.allowedAuthors);
  console.log(`\n${role} -> ${thread.length} messages, composition: ${JSON.stringify(comp)}`);
  // Every loaded message must be from an allowed author (or from this role).
  for (const m of thread) {
    const head = m.content.match(/^\[(\w+)/);
    const who = head ? head[1] : "?";
    if (who === role.toLowerCase()) continue;
    if (allowed) {
      assert.ok(allowed.has(who.toLowerCase()), `${role}: saw disallowed author ${who}`);
    }
  }
  // Length must not exceed profile limit
  assert.ok(thread.length <= p.historyLimit, `${role}: thread length ${thread.length} > limit ${p.historyLimit}`);
}
console.log("\n✅ All role filters respect allowedAuthors + historyLimit.");

// --- Test: forge sees different authors than atlas (the whole point)
{
  const atlasThread = loadRoomThread(roomId, "atlas");
  const forgeThread = loadRoomThread(roomId, "forge");
  // Forge filters out scout and echo messages
  const atlasScout = atlasThread.filter(m => m.content.match(/^\[scout/)).length;
  const forgeScout = forgeThread.filter(m => m.content.match(/^\[scout/)).length;
  assert.ok(atlasScout > forgeScout, `atlas sees more scout msgs (${atlasScout}) than forge (${forgeScout})`);
  console.log(`✅ forge's filter is stricter: atlas sees ${atlasScout} scout msgs, forge sees ${forgeScout}`);
}

// --- Test: total budget is respected even when profile says "all" with high cap
{
  const atlasThread = loadRoomThread(roomId, "atlas");
  const totalChars = atlasThread.reduce((s, m) => s + m.content.length, 0);
  assert.ok(totalChars <= 60_000, `atlas thread chars ${totalChars} > 60K budget`);
  console.log(`✅ atlas thread stays under 60K char budget (${totalChars})`);
}

// Cleanup
db.prepare("DELETE FROM messages WHERE room_id = ?").run(roomId);
db.prepare("DELETE FROM rooms WHERE id = ?").run(roomId);
console.log("\n🎉 CP1 role-aware loadRoomThread verified.");
process.exit(0);
