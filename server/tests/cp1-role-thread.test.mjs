// CP1 runtime probe: invoke loadRoomThread for different agents in the
// same room and confirm the TAG-subscription filter behaves per role.
// v2.2: author whitelists were replaced by MetaGPT-style tag subscriptions
// (subscribeTags on the role profile) + allowUser gate.
import assert from "node:assert/strict";
import { db } from "../src/db.js";
import { loadRoomThread, getRoleProfile, ROLE_CONTEXT_PROFILE, extractFinalResult, lastTag } from "../src/agents/runtime.js";

const roomId = "test_role_thread_" + Date.now();
const now = Date.now();
db.prepare(`INSERT INTO rooms (id, name, topic, status, unread, last_activity, agent_ids, notes, created_at)
            VALUES (?, 'CP1 Role Thread', 'tag subscription test', 'active', 0, ?, '["atlas","forge","lens","scout","echo","trainer"]', '', ?)`)
  .run(roomId, now, now);

// Seed messages with varied authors AND varied final tags.
const msgs = [
  { author: "user",   tag: null,      body: "please build the feature" },
  { author: "atlas",  tag: "DECISION", body: "we go with option B" },
  { author: "scout",  tag: "RESEARCH", body: "findings: lib X is fastest" },
  { author: "scout",  tag: "STATUS",  body: "searching more sources..." },
  { author: "forge",  tag: "RESULT",  body: "implemented and tested" },
  { author: "lens",   tag: "REVIEW",  body: "LGTM with two nits" },
  { author: "forge",  tag: null,      body: "hmm let me think about this" },
  { author: "scout",  tag: "RESEARCH", body: "second pass findings" },
  { author: "analyst",tag: "ANALYSIS", body: "tradeoffs favor option B" },
  { author: "trainer",tag: "RULES",   body: "always verify before RESULT" },
  { author: "forge",  tag: "BLOCKER", body: "blocked on missing creds" },
  { author: "atlas",  tag: null,      body: "routing chatter with no tag" },
  // Multi-tag message ending in STATUS — subscription matches the FINAL tag.
  { author: "lens",   tag: "STATUS",  body: "[RESULT]\ninterim ok\n[STATUS]\nstill reviewing" },
];
let ts = now - 60_000;
for (const m of msgs) {
  const content = m.tag ? `[${m.tag}]\n${m.body}` : m.body;
  db.prepare(`INSERT INTO messages (id, room_id, author_id, content, tags, findings, parent_id, mentioned_agent_ids, timestamp)
              VALUES (?, ?, ?, ?, '[]', '[]', NULL, '[]', ?)`)
    .run("msg_" + Math.random().toString(36).slice(2), roomId, m.author, content, ts);
  ts += 2000;
}
console.log(`Seeded ${msgs.length} messages`);

const profileTable = Object.entries(ROLE_CONTEXT_PROFILE);
console.log("\n--- ROLE_CONTEXT_PROFILE ---");
for (const [id, p] of profileTable) {
  const subs = p.subscribeTags === "all" ? "all" : p.subscribeTags.join("/");
  console.log(`  ${id.padEnd(10)} limit=${p.historyLimit}  subscribes=${subs.padEnd(45)} user=${p.allowUser}  strip=${!p.keepIntermediate}`);
}

function authorOf(m) {
  const head = m.content.match(/^\[(\w+)/);
  return head ? head[1] : "?";
}

// --- Test 1: subscribed roles only see their own + user + tag matches
for (const role of ["forge", "scout", "trainer", "writer"]) {
  const thread = loadRoomThread(roomId, role);
  const p = ROLE_CONTEXT_PROFILE[role];
  const subs = new Set(p.subscribeTags.map(t => t.toUpperCase()));
  console.log(`\n${role} -> ${thread.length} msgs, authors: ${[...new Set(thread.map(authorOf))].join(",")}`);
  assert.ok(thread.length <= p.historyLimit, `${role}: length ${thread.length} > limit`);
  for (const m of thread) {
    const who = authorOf(m);
    if (who === role.toLowerCase()) continue;
    if (who === "user") {
      assert.ok(p.allowUser, `${role}: user msg but allowUser=false`);
      continue;
    }
    // The stamped body starts with the author stamp; find the final tag of
    // the ORIGINAL content by re-extracting from the stored DB row shape —
    // here we rely on the seeded mapping via body matching instead.
  }
}

// Precise per-message check via DB round-trip: recompute what forge should see.
function scopedContents(role) {
  const p = getRoleProfile(role);
  return loadRoomThread(roomId, role).map(m => m.content);
}

{
  const forgeThread = scopedContents("forge");
  assert.ok(forgeThread.some(c => c.includes("LGTM with two nits")), "forge sees lens [REVIEW]");
  assert.ok(forgeThread.some(c => c.includes("implemented and tested")), "forge sees own [RESULT]");
  assert.ok(forgeThread.some(c => c.includes("blocked on missing creds")), "forge sees own [BLOCKER]");
  assert.ok(forgeThread.some(c => c.includes("please build the feature")), "forge sees user intent");
  assert.ok(!forgeThread.some(c => c.includes("findings: lib X")), "forge must NOT see scout [RESEARCH]");
  assert.ok(!forgeThread.some(c => c.includes("tradeoffs favor")), "forge must NOT see analyst [ANALYSIS]");
  assert.ok(!forgeThread.some(c => c.includes("still reviewing")), "forge must NOT see lens msg ending in [STATUS]");
  console.log("✅ forge subscription: REVIEW/RESULT/BLOCKER in, RESEARCH/ANALYSIS/STATUS-tail out");
}

{
  const scoutThread = scopedContents("scout");
  assert.ok(scoutThread.some(c => c.includes("findings: lib X")), "scout sees own [RESEARCH]");
  assert.ok(scoutThread.some(c => c.includes("we go with option B")), "scout sees atlas [DECISION]");
  assert.ok(!scoutThread.some(c => c.includes("LGTM")), "scout must NOT see lens [REVIEW]");
  console.log("✅ scout subscription: own RESEARCH + DECISION in, REVIEW out");
}

{
  // The persona-fix case: trainer harvests any agent's RESULT / DECISION / RULES.
  const trainerThread = scopedContents("trainer");
  assert.ok(trainerThread.some(c => c.includes("implemented and tested")), "trainer sees forge [RESULT]");
  assert.ok(trainerThread.some(c => c.includes("we go with option B")), "trainer sees atlas [DECISION]");
  assert.ok(trainerThread.some(c => c.includes("always verify before RESULT")), "trainer sees [RULES]");
  console.log("✅ trainer harvests RESULT/DECISION/RULES from all authors (persona contradiction fixed)");
}

{
  const writerThread = scopedContents("writer");
  assert.ok(writerThread.some(c => c.includes("findings: lib X")), "writer sees scout [RESEARCH]");
  assert.ok(writerThread.some(c => c.includes("tradeoffs favor")), "writer sees analyst [ANALYSIS]");
  assert.ok(!writerThread.some(c => c.includes("LGTM")), "writer must NOT see lens [REVIEW]");
  console.log("✅ writer subscription: RESEARCH/ANALYSIS in, REVIEW out");
}

// --- Test 2: "all" roles keep the full view
{
  const lensThread = scopedContents("lens");
  assert.ok(lensThread.some(c => c.includes("routing chatter with no tag")), "lens sees tagless agent prose");
  assert.ok(lensThread.some(c => c.includes("hmm let me think")), "lens sees tagless forge prose");
  console.log("✅ lens (all) still sees tagless prose");
}

// --- Test 3: self messages always pass even when tag not subscribed
{
  // scout's [STATUS] message: not in scout's subscription, but is self.
  const scoutThread = scopedContents("scout");
  assert.ok(scoutThread.some(c => c.includes("searching more sources")), "scout sees own [STATUS] via self-passthrough");
  console.log("✅ self-passthrough: scout sees own [STATUS] despite no STATUS subscription");
}

// --- Test 4: lastTag + extractFinalResult consistency
{
  assert.equal(lastTag("[RESULT]\nok\n[STATUS]\nbusy"), "STATUS");
  assert.equal(lastTag("no tags here"), null);
  assert.equal(lastTag("[RESEARCH:DEPRECATE]\nold"), "RESEARCH");
  const stripped = extractFinalResult("intro\n[RESULT]\nreal deliverable\n[STATUS]\nnoise");
  assert.ok(stripped.startsWith("[STATUS]"), "extractFinalResult keeps the final block");
  assert.ok(!stripped.includes("real deliverable"), "extractFinalResult drops earlier blocks");
  console.log("✅ lastTag/extractFinalResult agree on the final block");
}

// --- Test 5: atlas (all) respects budget
{
  const atlasThread = scopedContents("atlas");
  const totalChars = atlasThread.reduce((s, m) => s + m.length, 0);
  assert.ok(totalChars <= 60_000, `atlas thread chars ${totalChars} > 60K budget`);
  console.log(`✅ atlas thread stays under 60K char budget (${totalChars})`);
}

// Cleanup
db.prepare("DELETE FROM messages WHERE room_id = ?").run(roomId);
db.prepare("DELETE FROM rooms WHERE id = ?").run(roomId);
console.log("\n🎉 CP1 tag-subscription loadRoomThread verified.");
process.exit(0);
