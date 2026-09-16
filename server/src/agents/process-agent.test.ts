import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractErrorMsgForTest, splitModelForTest } from "./process-agent.js";

describe("extractErrorMsg — opencode error shape unwrapping", () => {
  it("handles string errors", () => {
    assert.equal(extractErrorMsgForTest("boom"), "boom");
  });

  it("handles {message} errors", () => {
    assert.equal(extractErrorMsgForTest({ message: "model not found" }), "model not found");
  });

  it("handles nested {data:{message}} errors", () => {
    assert.equal(
      extractErrorMsgForTest({ name: "X", data: { message: "nested fail" } }),
      "nested fail",
    );
  });

  it("returns empty for junk", () => {
    assert.equal(extractErrorMsgForTest(null), "");
    assert.equal(extractErrorMsgForTest(42), "");
  });
});

describe("splitModel — provider/model parsing", () => {
  it("splits provider/model", () => {
    assert.deepEqual(splitModelForTest("custom-saas/glm-5.3-flash-saas"), {
      providerID: "custom-saas",
      modelID: "glm-5.3-flash-saas",
    });
  });

  it("keeps bare model ids unpinned to a provider", () => {
    const { providerID, modelID } = splitModelForTest("glm-5.3-flash-saas");
    assert.equal(providerID, undefined);
    assert.equal(modelID, "glm-5.3-flash-saas");
  });

  it("handles empty/undefined", () => {
    assert.deepEqual(splitModelForTest(undefined), {});
    assert.deepEqual(splitModelForTest(""), {});
  });
});
