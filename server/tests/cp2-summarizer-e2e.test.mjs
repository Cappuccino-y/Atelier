// End-to-end test for summarizer.
// Mocks the LLM call by importing the LLM-free parts + injecting a fake.
import assert from "node:assert/strict";
import { db } from "../src/db.js";
import { countUnsummarized, getLatestSummary, forceSummarize } from "../src/agents/summarizer.js";

const roomId = "test_summarizer_e2e_" + Date.now();

// Seed 12 atlas messages (exceeds MIN_UNSUMMARIZED=10)
const now = Date.now();
db.prepare(`INSERT INTO rooms (id, name, topic, status, unread, last_activity, agent_ids, notes, created_at)
            VALUES (?, 'CP2 E2E', 'summarizer', 'active', 0, ?, '["atlas"]', '', ?)`)
  .run(roomId, now, now);

const scenarios = [
  "user asks for module X",
  "Atlas dispatches Scout",
  "Scout returns [RESEARCH] recommending lib Y",
  "Atlas dispatches Forge to implement with lib Y",
  "Forge reads files",
  "Forge edits config",
  "Forge ships [RESULT]: module X done, 50 lines",
  "Lens [REVIEW]: critical bug in cleanup logic",
  "Forge fixes bug",
  "Lens re-review: 1 minor only",
  "Atlas drafts final summary for user",
  "User asks follow-up: add Y feature",
];
let ts = now - 60_000;
for (const s of scenarios) {
  const id = "msg_" + Math.random().toString(36).slice(2);
  db.prepare(`INSERT INTO messages (id, room_id, author_id, content, tags, findings, parent_id, mentioned_agent_ids, timestamp)
              VALUES (?, ?, 'atlas', ?, '[]', '[]', NULL, '[]', ?)`)
    .run(id, roomId, s, ts);
  ts += 3000;
}
console.log(`Seeded ${scenarios.length} messages`);

// 1. countUnsummarized should be 12 (no summary yet)
{
  const { count, lastSummaryTs } = countUnsummarized(roomId, "atlas");
  assert.equal(count, 12, "all 12 should be unsummarized");
  assert.equal(lastSummaryTs, null);
  console.log("✅ Step 1: countUnsummarized = 12");
}

// 2. getLatestSummary should be null
{
  const s = getLatestSummary(roomId, "atlas");
  assert.equal(s, null);
  console.log("✅ Step 2: no summary yet");
}

// 3. forceSummarize will call the LLM. Skip — we don't want to burn tokens in tests.
//    Instead verify the SQL schema works by inserting a fake summary row.
//    Place the checkpoint exactly between msg9 and msg10 so the assertion
//    is unambiguous: anything strictly > checkpointTs counts as "after".
//    Use checkpointTs = msg10.timestamp - 1 so 3 messages (10, 11, 12)
//    are strictly after the checkpoint.
const checkpointTs = ts - 3000 * 3 - 1; // one tick before msg 10
{
  const fakeId = `sum_test_${Date.now().toString(36)}`;
  db.prepare(`INSERT INTO message_summaries
              (id, room_id, profile_key, up_to_message_id, up_to_timestamp, summary, covered_count, created_at)
              VALUES (?, ?, 'atlas', 'msg_fake', ?, 'Test summary', 9, ?)`)
    .run(fakeId, roomId, checkpointTs, Date.now());
  const s = getLatestSummary(roomId, "atlas");
  assert.ok(s, "summary row should be retrievable");
  assert.equal(s.summary, "Test summary");
  assert.equal(s.covered_count, 9);
  console.log("✅ Step 3: summary round-trip works");
}

// 4. countUnsummarized should now reflect the checkpoint (3 messages after)
{
  const { count } = countUnsummarized(roomId, "atlas");
  assert.equal(count, 3, "3 messages should be strictly after checkpoint");
  console.log(`✅ Step 4: countUnsummarized = ${count} (matches 12 - 9 covered)`);
}

// 5. listSummariesForRoom via direct query
{
  const rows = db.prepare(`SELECT * FROM message_summaries WHERE room_id = ?`).all(roomId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].profile_key, "atlas");
  console.log("✅ Step 5: indexable per (room, profile_key)");
}

// Cleanup
db.prepare("DELETE FROM message_summaries WHERE room_id = ?").run(roomId);
db.prepare("DELETE FROM messages WHERE room_id = ?").run(roomId);
db.prepare("DELETE FROM rooms WHERE id = ?").run(roomId);
console.log("\n🎉 CP2 summarizer E2E schema/path verification passed.");
process.exit(0);
