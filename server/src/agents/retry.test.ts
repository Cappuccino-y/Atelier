import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideRetry } from "./retry.js";

describe("decideRetry", () => {
  it("retries within maxRetries when within default budget", () => {
    const d = decideRetry({ attempt: 0, maxRetries: 1, elapsedMs: 1000, reason: "test" });
    assert.equal(d.shouldRetry, true);
  });

  it("refuses when maxRetries exhausted", () => {
    const d = decideRetry({ attempt: 2, maxRetries: 2, elapsedMs: 1000, reason: "test" });
    assert.equal(d.shouldRetry, false);
    assert.match(d.reason, /maxRetries/);
  });

  it("refuses when default 30s budget exhausted (default decideRetry behavior)", () => {
    const d = decideRetry({ attempt: 0, maxRetries: 3, elapsedMs: 31_000, reason: "timeout" });
    assert.equal(d.shouldRetry, false);
    assert.match(d.reason, /budget/);
  });

  it("retries long-running failures when budgetMs is Infinity (schema-mismatch AND run-failed paths)", () => {
    // Forge ran 168s then failed (exit code 1 / format error) — the run
    // itself was legitimate work, so wall-clock must NOT veto the retry.
    // maxRetries is the only cap. Both the schema-mismatch branch and the
    // run-failed branch in triggers.ts pass budgetMs: Infinity now.
    const d = decideRetry({ attempt: 0, maxRetries: 1, elapsedMs: 168_000, reason: "schema-mismatch", budgetMs: Infinity });
    assert.equal(d.shouldRetry, true);
  });

  it("still refuses long failures with a finite budgetMs override", () => {
    const d = decideRetry({ attempt: 0, maxRetries: 3, elapsedMs: 200_000, reason: "x", budgetMs: 60_000 });
    assert.equal(d.shouldRetry, false);
  });
});
