# 🏗️ 架构深潜（Architecture Deep-Dive）

> 本文是 [README](../README.md) 的实现细节补充：Handoff 协议、隐式路由、失败兜底、长记忆 KB、Per-Agent 模型路由。

## 目录

- [总览](#总览)
- [Handoff v2.1 — Typed Payload](#handoff-v21--typed-payload)
- [隐式路由（14 条规则）](#隐式路由14-条规则)
- [失败兜底 chain + 重试](#失败兜底-chain--重试)
- [长记忆 KB](#长记忆-kb)
- [Per-Agent 模型路由](#per-agent-模型路由)
- [WebSocket 事件全集](#websocket-事件全集)

---

## 总览

一次典型协作的数据流：

```
1. 用户 @Forge 派活
2. triggers.ts 识别 @提及 → handoff.ts 构造 v2.1 typed payload
3. runtime.ts 解析该 agent 的模型 → spawn opencode 子进程
4. Forge 输出 [RESULT] → 14 条隐式路由命中 → 自动召唤 Lens
5. Lens 输出 [REVIEW] → 命中 critical/major → Forge 被拉回返工
6. 全 minor → Atlas 收尾；全程 WS 28 种事件实时推给前端
```

路由优先级（首匹配命中）：

```
1. schema 校验失败  →  failurePolicy.onInvalidOutput (retry / fallback_echo / escalate)
2. agent 显式 handoff 块  →  解析 v1/v2 → 路由
3. agent 输出 tag pattern  →  14 条隐式规则
4. 都没有  →  停止（prose 里的 @mention 不会误触发）
```

---

## Handoff v2.1 — Typed Payload

agent 之间派活**必须**用结构化的 ` ```handoff ... ``` ` 代码块（v1 兼容）。v2 在 v1 基础上加了：

| 字段 | 作用 |
|---|---|
| `schemaVersion: "2.0"` / `"2.1"` | 协议版本（v2.1 加了 intent / attachmentRefs） |
| `traceId` | 整条任务链的 UUID（便于追溯） |
| `taskSummary` | 取代 v1 `task`，明确字段名 |
| `provenance` | 父 agent + 父消息 id + 上下文摘要 |
| `requiredOutputSchema` | 下游必须产出的 tag（`result_block` / `review_block` / `research_brief` / `analysis` / `document` / `visual_brief` / `memory_write` 等） |
| `constraints` | deadline / token 预算 |
| `evidenceStandard` | `strict` / `balanced` / `loose` |
| `failurePolicy` | `fallback_echo` / `retry` / `escalate`（默认 `fallback_echo`） |
| `intent` *(v2.1)* | 语义意图（"verify_fix" / "request_analysis" 等） |
| `attachmentRefs` *(v2.1)* | 引用的图片 / 文件 / 消息 id 列表 |

v1 仍可写，server 自动补全：

```jsonc
{"to": ["forge"], "task": "实现 selectFrame 兜底路径"}
```

v2.1 推荐写法：

```jsonc
{
  "schemaVersion": "2.1",
  "traceId": "f3b9e2f4-91d1-4d74-9a32-3c5b48fa2a63",
  "to": ["scout", "analyst"],
  "taskSummary": "调研 selectFrame 在 ZSL 路径下的兜底实现",
  "intent": "verify_fallback_path",
  "attachmentRefs": ["msg-100", "msg-101"],
  "requiredOutputSchema": "research_brief",
  "evidenceStandard": "strict",
  "failurePolicy": { "onInvalidOutput": "fallback_echo", "maxRetries": 1 }
}
```

整条任务链可通过 REST 追溯：

```
GET /api/runtime/handoff-chain/:messageId
```

---

## 隐式路由（14 条规则）

agent 没显式写 ` ```handoff ``` ` 块时，server 用 tag 模式触发自动路由（实现在 `server/src/agents/implicit-handoff.ts`）：

| 触发 | 路由到 | 触发条件 |
|---|---|---|
| `[RESULT]` from Forge | Lens review | 默认 |
| `[RESULT]` 含 `reusable` / `通用经验` / `// reusable:` | **+** Archivist 自动归档 | 检测可复用 pattern |
| `[REVIEW]` critical/major from Lens | Forge 返工 | 严重度 ≥ major |
| `[REVIEW]` + `[STATUS]` done + 全 minor | Atlas 收尾 | clean review |
| `[REVIEW]` 含 `建议归档` | **+** Archivist | Lens 显式标 |
| `[RESEARCH]` 长 / 多条事实 from Scout | Analyst 分析 | 多个 findings |
| `[RESEARCH]` 简短 from Scout | Atlas 收尾 | 简单查询 |
| `[ANALYSIS]` 含 `建议报告/文档` | **+** Writer 文档化 | 需要落地 |
| `[ANALYSIS]` 其他 | Atlas 收尾 | 默认 |
| `[DOCUMENT]` from Writer | Lens review 文档 | review prose |
| `[VISUAL]` 含 `error/null` | **+** Analyst 分析 | 错误诊断 |
| `[VISUAL]` 含 `mockup/design/设计` | **+** Writer 文档化 | 设计落地 |
| `[VISUAL]` 其他 | Atlas 收尾 | 默认 |
| `[MEMORY]` from Archivist | Atlas 收尾 | KB 写入完成 |

防失控保护：10 条消息内同 agent 最多触发 5 次；单条消息 handoff 链深上限 50（`OPENCODE_HANDOFF_DEPTH`）。

---

## 失败兜底 chain + 重试

```
specialist agent  ─fail─►  echo (fallback_echo)  ─fail─►  [BLOCKER] (escalate)
                      │
                      └─►  retry with exponential backoff (maxRetries 0-3, total budget 30s)
```

- `failurePolicy.onInvalidOutput = "retry"` → 重试同一 agent，prompt 追加 schema 错配说明
- `failurePolicy.onInvalidOutput = "fallback_echo"` → 派 Echo 接管，Echo 若失败 → escalate
- `failurePolicy.onInvalidOutput = "escalate"` → 立即 [BLOCKER]

重试用 AWS-style 指数退避 + full jitter：base 500ms，每次 cap 翻倍，最大 8s，总预算 30s（实现在 `server/src/agents/retry.ts`）。

---

## 长记忆 KB

`server/data/memory/` 下按 scope 分文件（append-only markdown）：

| 文件 | 作用域 |
|---|---|
| `global.md` | 跨房间普适经验 |
| `room_<id>.md` | 单房间私域 |
| `agent_<id>.md` | 仅注入对应 agent |
| `project_<name>.md` | 按项目 |

**写入规则**：

- `Archivist` 是唯一允许输出 `[MEMORY]` 块的 agent；其他 agent 输出 `[MEMORY]` 会被丢弃 + warning
- 每次写入追加 `memoryId` + 时间戳；支持 `supersedes: <memoryId>` 链接
- `deprecateMemoryEntry()` 通过前置 `[MEMORY:DEPRECATE]` 标记废弃

**检索规则**（每次 agent invoke 自动注入）：

- 评分：tag 命中 ×3 + title 命中 ×2 + content 命中 ×1
- 自动排除 `[MEMORY:DEPRECATE]` 条目和被 `supersedes` 指向的旧条目
- 同 agent 标签的条目 +0.5 加分
- 跨 scope 合并：room → agent → global，按分数 + 时间排序

**REST API**：

```
GET  /api/memory/list?scope=global&limit=50&includeDeprecated=false
GET  /api/memory/stats                                  # counts by scope/category/confidence
GET  /api/memory/search?q=...&limit=10                  # 关键词搜索（带评分）
POST /api/memory/deprecate {memoryId, scopeKind, ...}   # 标记废弃
GET  /api/memory/path                                   # server.data/memory 路径
```

---

## Per-Agent 模型路由

改 `server/agent-models.json`，**无需重启 server**，下一次 agent 调用即生效：

```json
{
  "default": "<provider>/<multimodal-model>",
  "models": {
    "atlas":  "preset:fast",
    "forge":  "<provider>/<strong-coder-model>",
    "lens":   "<provider>/<multimodal-model>"
  },
  "presets": {
    "fast":     "<provider>/<cheap-flash>",
    "balanced": "<provider>/<balanced-model>",
    "deep":     "<provider>/<deep-model>"
  }
}
```

**解析优先级**（首匹配命中）：

```
models[<agentId>]   →   default   →   OPENCODE_MODEL env 兜底
```

**Preset 语法**：任何字符串以 `preset:` 开头即查 `presets` 表，支持嵌套引用：

```json
"models": { "lens": "preset:deep" }
"presets": { "deep": "preset:vision" }
```

**运行时 API**：

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET`  | `/api/runtime/agent-models` | 看当前配置 + 每个 agent 实际解析到的 model |
| `PUT`  | `/api/runtime/agent-models` | `{"config": {...}}` — 原子覆盖配置文件，下次调用生效 |
| `POST` | `/api/runtime/agent-models/reload` | 主动重读（目前 no-op，预留） |

```bash
# 看当前解析
curl http://127.0.0.1:8787/api/runtime/agent-models | jq

# 原子覆盖
curl -X PUT http://127.0.0.1:8787/api/runtime/agent-models \
  -H "Content-Type: application/json" \
  -d '{"config": {"default": "<provider>/<balanced-model>", "models": {"atlas": "preset:fast"}}}'
```

> ⚠️ 模型 key 必须出现在你的 `~/.config/opencode/opencode.json` 的 `provider.*.models.*` 列表里。`notes` 块仅作文档，运行时不读。

**选型原则**：

- 编排 / 支援类（Atlas、Echo、Scout）→ `preset:fast`，只路由不深想
- 实现 / 评审 / 归档类（Forge、Lens、Archivist、Trainer）→ 多模态强模型，Lens 必须多模态（要看截图）
- 分析 / 撰写类（Analyst、Writer）→ balanced 档即可

---

## WebSocket 事件全集

server → client 共 28+ 种，按域分组：

| 域 | 事件 |
|---|---|
| 消息 | `message.created` · `messages.cleared` |
| 房间 | `room.created` · `room.updated` · `room.deleted` |
| 任务 | `task.created` · `task.updated` · `task.deleted` |
| Agent | `agent.created` · `agent.updated` · `agent.status` · `agent.thinking` · `agent.tool_call` · `agent.handoff` · `agent.completed` · `agent.error` |
| 评审 | `review.completed` · `finding.accepted` · `finding.rejected` · `rework` · `escalation` |
| 路由 | `routing.route` · `routing.invite` |
| 自言自语 | `self_talk.start` · `self_talk.stop` · `self_talk.tick` |
| 系统 | `system.warning` · `system.info` · `system.error` · `project.updated` · `activity.cleared` · `ping` · `pong` |
