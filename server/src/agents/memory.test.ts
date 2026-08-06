import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseMemoryFile, isDeprecated } from "./memory.js";
import type { MemoryEntry } from "./handoff.js";

function entry(over: Partial<MemoryEntry>): MemoryEntry {
  return {
    scope: "room:general",
    category: "gotcha",
    title: "t",
    content: "c",
    tags: [],
    confidence: "medium",
    source: { messageIds: [], agentIds: [] },
    ...over,
  };
}

const FILE = `---
memoryId: mem_abc
timestamp: 2026-08-06T00:00:00.000Z
scope: room:general
category: gotcha
title: 多行内容含分隔符
tags: [sqlite, gotcha]
confidence: high
source.messageIds: m1, m2
source.agentIds: archivist

遇到含 --- 的正文第一行
第二行 --- 再来一个
第三段正常文字
---

---
memoryId: mem_def
timestamp: 2026-08-06T00:00:01.000Z
scope: global
category: fact
title: 第二条
tags: []
confidence: medium
source.messageIds: —
source.agentIds: —

简单内容
---
`;

describe("parseMemoryFile — content containing literal `---`", () => {
  it("does not truncate at embedded separators", () => {
    const parsed = parseMemoryFile(FILE);
    assert.equal(parsed.length, 2);
    const first = parsed[0];
    assert.equal(first.id, "mem_abc");
    assert.equal(first.entry.content.includes("第三段正常文字"), true, "trailing paragraph kept");
    assert.ok(first.entry.content.split("---").length >= 3, "embedded separators preserved");
    assert.equal(parsed[1].entry.content, "简单内容");
  });

  it("returns [] for empty / headerless content", () => {
    assert.deepEqual(parseMemoryFile(""), []);
    assert.deepEqual(parseMemoryFile("garbage without memoryId"), []);
  });
});

describe("isDeprecated", () => {
  it("an entry that supersedes an older one is NOT deprecated itself", () => {
    const newer = entry({ title: "新条目", supersedes: "mem_old" });
    assert.equal(isDeprecated(newer), false, "newer entry must be kept");
  });

  it("title markers mark deprecated", () => {
    assert.equal(isDeprecated(entry({ title: "[MEMORY:DEPRECATE] 旧条目" })), true);
    assert.equal(isDeprecated(entry({ title: "deprecated config path" })), true);
    assert.equal(isDeprecated(entry({ title: "已废弃的规则" })), true);
  });

  it("plain entry is not deprecated", () => {
    assert.equal(isDeprecated(entry({ title: "正常条目" })), false);
  });
});
