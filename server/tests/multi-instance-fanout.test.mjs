// Multi-instance fan-out probe: duplicate worker-role targets expand into
// concurrent instances; single-instance roles are denied; the fan-in
// barrier counts instances separately (two forges = two participants).
import assert from "node:assert/strict";
import { expandFanOutTargets, workerKeyOf, registerFanOutGroup, fanOutOnWorkerDone } from "../src/agents/triggers.js";

// --- Test 1: duplicate worker roles expand with instance numbers + toIndex
{
  const to = [
    { id: "forge", name: "Forge" },
    { id: "lens", name: "Lens" },
    { id: "forge", name: "Forge" },
    { id: "scout", name: "Scout" },
    { id: "scout", name: "Scout" },
  ];
  const { expanded, denied } = expandFanOutTargets(to);
  assert.deepEqual(expanded.map((t) => workerKeyOf(t.id, t.instance)),
    ["forge", "lens", "forge#2", "scout", "scout#2"]);
  // toIndex must point at the ORIGINAL entry so per-target briefs resolve
  assert.deepEqual(expanded.map((t) => t.toIndex), [0, 1, 2, 3, 4]);
  assert.equal(denied.length, 0);
  console.log("✅ duplicate worker roles expand: forge, forge#2, scout, scout#2 (toIndex preserved)");
}

// --- Test 2: single-instance roles dedupe + report denial
{
  const to = [
    { id: "lens", name: "Lens" },
    { id: "atlas", name: "Atlas" },
    { id: "lens", name: "Lens" },
    { id: "archivist", name: "Archivist" },
    { id: "archivist", name: "Archivist" },
  ];
  const { expanded, denied } = expandFanOutTargets(to);
  assert.deepEqual(expanded.map((t) => t.id), ["lens", "atlas", "archivist"]);
  assert.deepEqual(denied.map((d) => d.id), ["lens", "archivist"]);
  console.log("✅ lens/atlas/archivist stay single-instance (denied list reports repeats)");
}

// --- Test 3: mixed group — worker duplicates expand, reviewer dedupes
{
  const { expanded, denied } = expandFanOutTargets([
    { id: "forge", name: "F" }, { id: "forge", name: "F" },
    { id: "lens", name: "L" }, { id: "lens", name: "L" },
  ]);
  assert.deepEqual(expanded.map((t) => workerKeyOf(t.id, t.instance)), ["forge", "forge#2", "lens"]);
  assert.deepEqual(denied.map((d) => d.id), ["lens"]);
  console.log("✅ mixed fan-out: instances expand AND single-writer dedupe in the same dispatch");
}

// --- Test 4: fan-in barrier counts instances separately
{
  const traceId = "test_trace_" + Date.now();
  registerFanOutGroup(traceId, "room_test", "atlas", ["forge", "forge#2"]);

  // First forge instance hands back to originator — must be HELD (barrier
  // waits for forge#2).
  const first = fanOutOnWorkerDone({
    traceId, roomId: "room_test", worker: "forge",
    content: "forge instance 1 result",
    handoff: { schemaVersion: "2.0", traceId, rawTraceId: "", to: [{ id: "atlas", name: "Atlas", rawName: "atlas" }], taskSummary: "wrap up" },
  });
  assert.equal(first.status, "held", "first instance must be held");

  // Second instance completes → barrier fires ONE aggregate.
  const second = fanOutOnWorkerDone({
    traceId, roomId: "room_test", worker: "forge#2",
    content: "forge instance 2 result",
    handoff: { schemaVersion: "2.0", traceId, rawTraceId: "", to: [{ id: "atlas", name: "Atlas", rawName: "atlas" }], taskSummary: "wrap up" },
  });
  assert.equal(second.status, "fired", "barrier must fire when both instances done");
  assert.ok(second.directive.taskSummary.includes("forge instance 1 result"), "aggregate includes instance 1 output");
  assert.ok(second.directive.taskSummary.includes("forge instance 2 output".replace("output", "result")), "aggregate includes instance 2 output");
  assert.ok(second.directive.taskSummary.includes("2 个 worker"), "aggregate reports 2 workers");
  console.log("✅ fan-in barrier: 2 forge instances = 2 participants, one aggregate wrap-up");
}

// --- Test 5: workerKeyOf sanity
{
  assert.equal(workerKeyOf("forge"), "forge");
  assert.equal(workerKeyOf("forge", 2), "forge#2");
  assert.equal(workerKeyOf("forge", undefined), "forge");
  console.log("✅ workerKeyOf: bare id for first occurrence, id#n for instances");
}

console.log("\n🎉 Multi-instance fan-out verified.");
process.exit(0);
