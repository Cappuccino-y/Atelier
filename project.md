# Atelier Build Spec — 从零复现指南

> 目标：让另一个 agent 根据这个文档，从零搭建出一个完整可跑的 Atelier 多 agent 群聊协作系统。

------

## 0. 项目概述

Atelier 是一个多 agent 群聊协作系统：

- **Atlas** (编排器) — 纯路由，只分解任务并 @派活，不调任何 tool
- **Forge** (实现者) — 产出代码 / 配置，完事后 [RESULT] @Lens review
- **Lens** (审查者) — 只读，找问题出 [REVIEW]，critical/major -> @Forge 修
- **Echo** (通用支持) — 调研 / 总结 / 日常事务

调用链收敛规则：末棒 @Atlas，Atlas 给用户最终汇总。

### 技术栈

| 层            | 技术                                                         |
| ------------- | ------------------------------------------------------------ |
| 前端          | Vite + React 19 + TypeScript + Tailwind v4 + shadcn/ui (new-york) |
| 后端          | Fastify + better-sqlite3 + WebSocket + Zod                   |
| Agent 运行时  | 每个 agent 是真实的 opencode 子进程                          |
| 多 agent 协作 | @-mention 触发 + 隐式调度 + per-room DB-backed shared thread |
| Review bridge | Proserpina (Python FastAPI 8765, 5 critic heuristic)         |
| 启动          | PowerShell 一键脚本，无弹窗，日志重定向                      |

### 项目目录总览

```plaintext
D:\Atelier\
  src/                         # 前端 (Vite + React)
    components/
      chat/   (6 文件)         # Composer, MessageList, MessageItem, RoomHeader, ...
      layout/ (6 文件)         # AppShell, Sidebar, TopBar, RightPanel, SearchPalette, ...
      ui/     (13 文件)        # shadcn 组件
    lib/                        # api.ts, ws.ts, utils.ts, atch-debug.ts
    types/index.ts              # 8 个 type + 28 个 event type
  server/                       # 后端 (Fastify)
    src/
      agents/                   # triggers(489行), runtime(170行), process-agent(356行), prompts(176行), arbiter
      routes/                   # rooms, messages, tasks, agents, events, routing, review, mcp, runtime, debug
      mcp/agent-room.ts
      db.ts, config.ts, broadcast.ts, index.ts
  proserpina-bridge/            # Python review service
  scripts/                      # 启动脚本 (atelier.ps1, start-all.ps1, stop-all.ps1)
```

------

## 1. 前置依赖

```bash
# 必需
node >= 22
python >= 3.10  (Proserpina bridge)
npm install -g opencode        # opencode CLI (必须!)

# 安装项目依赖
cd D:\Atelier && npm install                    # 前端
cd D:\Atelier\server && npm install             # 后端
cd D:\Atelier\proserpina-bridge && pip install -r requirements.txt  # bridge
```

------

## 2. opencode 自定义 Agent 配置

### 2.1 位置

opencode per-agent 配置在 `~/.config/opencode/` (Windows: `C:\Users\<user>\.config\opencode\`)

### 2.2 opencode.json (关键片段)

```jsonc
{
  "model": "custom-saas/minimax-MiniMax-M3-cp",
  "agent": {
    "atlas": {
      "mode": "primary",
      "prompt": "{file:./agents/atlas.md}",
      "temperature": 0.2,
      "permission": { "bash":"deny", "edit":"deny", "read":"deny", "grep":"deny", "glob":"deny", "task":"deny", ... }
    },
    "lens": {
      "mode": "primary",
      "prompt": "{file:./agents/lens.md}",
      "temperature": 0.1,
      "permission": { "bash":"deny", "edit":"deny", "write":"deny", "read":"allow", "grep":"allow", "glob":"allow", ... }
    },
    "echo": {
      "mode": "primary",
      "prompt": "{file:./agents/echo.md}",
      "temperature": 0.3,
      "permission": { "bash":"deny", "edit":"deny", "write":"deny", "read":"allow", "grep":"allow", ... }
    }
  }
}
```

- Atlas: 所有 tool deny (纯编排)
- Lens: 只读 (read/glob/grep/lsp allow, 其他 deny)
- Echo: 只读 (同 Lens)
- Forge: 用 opencode 内置 `build` agent (全量 tool, 不需要在 opencode.json 定义)

### 2.3 agents/atlas.md (精简版)

```markdown
---
description: Atlas 编排器 — 纯路由，只分解任务并 @mention worker；绝不动手
mode: primary
model: custom-saas/minimax-MiniMax-M3-cp
temperature: 0.2
---

# Atlas — 编排器

你是 Atelier 多 agent 系统的**编排者**。纯路由，只分解任务并 @mention worker；绝不动手。

## 铁律
- **绝不**直接调用任何 skill、工具
- **绝不**自己读文件、看代码、跑命令
- **绝不**自己产出最终答案 — 要么 @Worker 派活，要么汇总 worker 结果回复用户

## 决策矩阵
| 需要查代码/看日志/跑命令 | @Forge |
| 需要审查/找bug | @Lens |
| 需要调研/总结 | @Echo |
| 多 worker 已回复 | 自己汇总后回复用户 |
```

### 2.4 agents/lens.md (精简版)

```markdown
---
description: Lens 审查者 — 只读，专注找问题、出 review
mode: primary
model: custom-saas/minimax-MiniMax-M3-cp
temperature: 0.1
---

# Lens — 审查者

你是 Atelier 的**审查者**。挑刺，不动手。

## 铁律
- **绝不**写代码、改文件、跑命令
- **只能**做：读、看、搜、查文档，产出 [REVIEW] 文本

## 输出格式
[REVIEW]
- **critical/major/minor**: <title>
  - location: file:line
  - quote: <原文片段>
  - suggested: <修改建议>
```

### 2.5 agents/echo.md (精简版)

```markdown
---
description: Echo 通用支持 — 只读，日常事务
mode: primary
model: custom-saas/minimax-MiniMax-M3-cp
temperature: 0.3
---

# Echo — 通用支持

帮忙查背景、汇总信息、处理日常确认。

## 铁律
- **绝不**写代码、改文件、跑命令
- **只能**做：读、看、搜、查文档，产出文本回复
```

------

## 3. 后端实现

### 3.1 入口 (server/src/index.ts)

Fastify + CORS + WebSocket, 注册 10 个路由模块，监听 8787。

### 3.2 数据库 (server/src/db.ts)

SQLite (better-sqlite3, WAL mode), 6 表: rooms, messages, tasks, agents, events, projects。

首次启动自动 seed 5 个 agents + 3 个 rooms + mock 对话 + 2 个 projects。

关键 schema:

```sql
CREATE TABLE messages (
  id TEXT PK, room_id TEXT NOT NULL FK, author_id TEXT NOT NULL,
  content TEXT NOT NULL, tags TEXT, findings TEXT,
  parent_id TEXT, mentioned_agent_ids TEXT, timestamp INTEGER
);
CREATE INDEX idx_messages_room ON messages(room_id, timestamp);
```

### 3.3 配置 (server/.env)

```env
PORT=8787
AGENT_RUNTIME=opencode
OPENCODE_MODEL=custom-saas/minimax-MiniMax-M3-cp
OPENCODE_TIMEOUT=600000
AGENT_MAPPING=atlas:atlas,forge:build,lens:lens,echo:echo
OPENCODE_HANDOFF_DEPTH=50
PROSERPINA_URL=http://127.0.0.1:8765
```

### 3.4 广播 (broadcast.ts)

Set<WebSocket> + JSON.stringify + sendAll

------

## 3. 后端实现 - Agent 运行时

### 3.5 process-agent.ts — opencode 子进程封装

每个 agent 调用时:

1. 拼接 system + history + user 到 prompt 文本
2. 写 prompt 到临时文件 (.txt)
3. 写 .bat 包装: `type prompt.txt | opencode run - --agent <name> --model <model> --dir <cwd> --format json`
4. `spawn("cmd.exe", ["/d", "/s", "/c", batFile])` hidden
5. 解析 stdout NDJSON -> 提取最后的 text 事件 -> 返回 content

关键 env:

- `AGENT_MAPPING=atlas:atlas,forge:build,lens:lens,echo:echo`
- Forge -> opencode 的 `build` primary agent（全量 tool）
- Atlas/Lens/Echo -> opencode 的自定义 primary agent

输出解析: `parseOpenCodeOutput()` — NDJSON lines, 收集所有 `type: "text"` 事件的 text 字段，join 后 trim。

Mock 模式：如果 opencode 不可用或 `AGENT_RUNTIME=mock`，用内置 MockAgentClient 返回模板。

### 3.6 runtime.ts — DB-backed per-room shared thread

```ts
const HISTORY_LIMIT = 30;
const CONTENT_TRUNCATE = 800;

function loadRoomThread(roomId: string, agentId: string): ChatMessage[] {
  // 从 messages 表拉最近 30 条（按 timestamp 逆序再 reverse 成正序）
  const rows = db.prepare(`
    SELECT author_id, content, timestamp FROM messages
    WHERE room_id = ?
    ORDER BY timestamp DESC LIMIT ?
  `).all(roomId, HISTORY_LIMIT);

  return rows.reverse().map(m => ({
    role: m.author_id === agentId ? "assistant" : "user",
    content: `[${m.author_id} ${formatTime(m.timestamp)}]\n${truncate(m.content, CONTENT_TRUNCATE)}`,
  }));
}
```

**角色转换**: author === 当前 agent -> role=assistant（这是我之前说的）, 其他 -> role=user（上下文）

### 3.7 triggers.ts — @-mention + 隐式调度

**核心机制**:

1. `extractMentions(content)` — 正则 `/@(!?)([\w\u4e00-\u9fa5]+)/g`，从 DB 找 match agent
2. `triggerOnMessage(params)` — 入口
   - user message -> reset depth counter
   - self-mention filter: `filtered = mentions.filter(m => m.id !== authorId)`
   - depth cap: OPENCODE_HANDOFF_DEPTH (默认 50)
   - flood detection: 同 agent 最近 10 条 >= 5 次 -> block + broadcast system.warning
   - per-agent busy queue: `runningAgents: Set<roomId:agentId>` + `agentQueues: Map`
3. `invokeAgentAsync(...)` — 异步 invoke
   - busy check -> queue
   - `enrichForHandoff()` 拼最近 6 条上下文
   - `invokeAgent()` -> opencode
   - parse tags + findings
   - INSERT message + broadcast
   - 递归 `triggerOnMessage()` + `implicitHandoff()`
   - finally: `drainQueue()`
4. `implicitHandoff()` — 隐式调度（兜底）
   - `[RESULT]` + agentId != lens -> auto-invoke Lens
   - `[REVIEW]` + hasFixable + agentId != forge -> auto-invoke Forge
   - depth cap + 不跟显式 @ 冲突
5. `triggerOnSelfTalkTick()` — self-talk 轮询
6. `isAgentFlooding()` — cycle detection (10/5)

### 3.8 prompts.ts — Agent System Prompts

SHARED_RULES 7 个核心段:

- 跨 agent 协作铁律（永不孤立输出 / 完成这一步 @Next / 结束条件 / 深度上限 3 跳 / 末棒收敛 Atlas）
- 声明！= 产出（tag/@ 只能描述已发生的事实；纯文本不触发隐式调度）
- 上下文读取规则（[HISTORY] 是房间共享；role=assistant 是我自己说的；role=user 是别人说的）
- 标签约定 ([DECISION][TODO][STATUS][RESULT][REVIEW][QUESTION][BLOCKER])
- @ 艾特语法
- 反例

Atlas/Forge/Lens/Echo 各有独立的 persona + role-specific rules:

- Atlas: 纯编排，不调工具，末棒收尾模式
- Forge: 实现者，[RESULT] + @Lens，全 minor 后 @Atlas 收尾
- Lens: 审查者，只读，[REVIEW] 含 critical/major -> @Forge，全 minor -> @Atlas
- Echo: 通用支持，只读，调研 / 总结完 -> @Atlas

### 3.9 Routes

所有路由在 `server/src/routes/` 下，每个文件 export async function `<name>Routes(app)`:

| 文件        | 关键端点                                                     |
| ----------- | ------------------------------------------------------------ |
| rooms.ts    | GET/POST /api/rooms, GET/PATCH/DELETE /api/rooms/:id, POST /api/rooms/:id/clear, GET /api/projects |
| messages.ts | GET /api/rooms/:id/messages, POST /api/rooms/:id/messages -> 触发 triggerOnMessage () |
| tasks.ts    | GET/POST /api/rooms/:id/tasks, PATCH/DELETE /api/tasks/:id   |
| agents.ts   | GET/POST /api/agents, PATCH /api/agents/:id/status           |
| events.ts   | GET /api/rooms/:id/events, GET /api/events                   |
| routing.ts  | route_to / invite / self-talk / tick                         |
| review.ts   | POST /api/review -> Proserpina bridge (8765)                 |
| mcp.ts      | Agent Room MCP 路由 (mcp_rooms/mcp_room_members 表)          |
| runtime.ts  | GET /api/runtime/status, POST /api/runtime/clear, GET /api/runtime/debug-env |
| debug.ts    | POST /api/debug/log -> client debug log sink                 |

------

## 4. 前端实现

### 4.1 技术栈

- 构建: Vite 6 + React 19 + TypeScript 5.6
- 样式: Tailwind CSS v4 + @tailwindcss/typography
- UI: shadcn/ui (new-york), Radix UI primitives (12+ 个)
- 图标: lucide-react
- 虚拟列表: react-virtuoso (1000+ 消息流畅)
- 渲染: react-markdown + remark-gfm
- 工具: clsx + tailwind-merge (cn ())

### 4.2 Vite 配置 (vite.config.ts)

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  server: {
    host: "127.0.0.1", port: 5173,
    watch: { ignored: ["**/server/data/**", "**/logs/**", "**/node_modules/**"] },
    proxy: {
      "/api": { target: "http://127.0.0.1:8787", changeOrigin: true },
      "/ws": { target: "ws://127.0.0.1:8787", ws: true },
    },
  },
});
```

### 4.3 Types (src/types/index.ts) — 8 个 type + 28 个 event type

```ts
Agent { id, name, role, color, avatar, model, status, lastSeen }
Message { id, roomId, authorId, content, tags?, findings?, parentId?, mentionedAgentIds?, timestamp }
Room { id, name, topic?, status, unread, lastActivity, agentIds, notes?, createdAt }
Task { id, roomId, title, assigneeId?, status, createdAt }
Project { id, name, roomIds, createdAt }
Finding { id, severity, title, location?, quote?, suggested?, supportingCritics }
```

### 4.4 App.tsx 架构

状态管理: 16 个 useState (rooms/messages/tasks/agents/projects/currentRoomId/rightTab/loading/error/wsStatus/paletteOpen + 弹窗 states + 房间 states)

初始化: useEffect -> api.listRooms/listProjects/listAgents -> 选第一个 room -> 拉 messages/tasks/selfTalk

WebSocket 事件处理: 28 个事件 switch:

- message.created/task.*/room.*/messages.cleared/project.updated/agent.*
- self_talk.*/escalation/rework/finding.accepted/system.warning

房间操作: handleCreateRoom /handleClearRoom/handleDeleteRoom /handleReview/handleExport /handleRoomUpdated/handleInviteAgent

Ctrl+K 全局搜索: useEffect + KeyboardEvent handler -> SearchPalette

### 4.5 布局组件

**AppShell**: 4 区 — TopBar, Sidebar (左 64px), MainArea (中), RightPanel (右 320px)

**Sidebar**: project 分组 + 未分组 orphan + Archived 区 + + 新建按钮

**TopBar**: 标题 + 搜索按钮 (Ctrl+K) + WS 状态灯 (绿 / 黄 / 红) + 通知 / 设置 / 用户

**MainArea**: RoomHeader + MessageList (Virtuoso 虚拟列表) + Composer

**RightPanel**: 5 tab — Tasks, Activity, Notes, Findings, Replay

### 4.6 核心聊天组件

**Composer.tsx** (372 行):

- detectMention () 检测 active @ token
- MentionDropdown 候选列表 (上下键导航，Enter/Tab 选择)
- blur 120ms 延迟关闭 dropdown
- Agent 快捷提及栏 (点一下插入 @AgentName)
- parseMentions () 提取 mentionedAgentIds

**MessageItem.tsx** (205 行):

- user/agent 气泡 (user 右对齐，agent 左对齐)
- TagBadge (7 色: DECISION/TODO/STATUS/RESULT/REVIEW/QUESTION/BLOCKER)
- ReactMarkdown + remarkGfm 渲染
- MentionBadges (-> @Forge @Lens 指向 agent)
- FindingCard (critical 红 /major 黄 /minor 蓝，含 location/quote/suggested/supportingCritics)

**RoomHeader.tsx** (287 行):

- 房间名 + status 标签 + Self-Talk 计数
- 模式选择 (Solo/On-demand/Collaborative/Self-Talk)
- Cap 选择 (3/5/10/20/50)
- Agent 头像列 (含状态指示点)
- Self-Talk 开关，Review 按钮 (-> Proserpina), Export/Setting/More 按钮
- More 菜单：清空对话 / 删除整个对话
- RoomSettingsDialog (改名 /topic/status 弹窗)

### 4.7 其他核心组件

**SearchPalette.tsx** (349 行): Ctrl+K 全局搜索

- 结果排序 (CJK> latin, startsWith > includes)
- 命中高亮 (黄色)
- 按键导航 (上下键 + Enter + ESC)

**RightPanel.tsx** (664 行): 5 tab

- TasksTab: 排序 doing->todo->blocked->done, 任务编辑弹窗 TaskEditDialog, + 新建按钮
- ActivityTab: 消息逆序
- NotesTab: 房间便笺，800ms debounce auto-save, "已保存 Xs 前" 状态，手动保存按钮
- FindingsTab: 按 severity 分组 (critical/major/minor)
- ReplayTab: 事件时间线，播放 / 暂停 / 速度控制 (1x/2x/5x/10x), 进度条

**RoomSettingsDialog.tsx** (239 行): 改名 /topic/status/ 邀请 agent

**CreateRoomDialog.tsx** (144 行): 名称 / 主题 / 归属项目

**TaskEditDialog.tsx** (240 行): 新建 / 编辑 / 删除任务弹窗

**ConfirmDialog.tsx** (69 行): 通用确认弹窗 (清空 / 删除)

### 4.8 API 客户端 (src/lib/api.ts)

```ts
const API_BASE = (import.meta.env.VITE_API_URL as string) || "http://127.0.0.1:8787";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body !== undefined && init.body !== null;
  const headers: Record<string, string> = {
    ...(hasBody ? { "Content-Type": "application/json" } : {}),
  };
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return res.json();
}

export const api = {
  // Rooms: listRooms, getRoom, createRoom, updateRoom, deleteRoom, clearRoomMessages
  // Messages: listMessages, sendMessage
  // Tasks: listTasks, createTask, updateTask, deleteTask
  // Agents: listAgents, upsertAgent, updateAgentStatus
  // Events: listRoomEvents, listEvents
  // Projects: listProjects
  // Review: reviewHealth, requestReview
  // MCP, Routing, Self-talk, Runtime 端点...
};
```

### 4.9 WebSocket 客户端 (src/lib/ws.ts)

```ts
class WSClient {
  ws.connect()          // new WebSocket("ws://127.0.0.1:8787/ws")
  ws.disconnect()       // 显式关闭
  ws.on(handler)        // 返回 unsubscribe
  ws.onStatus(listener) // 状态变化通知
  private startPing()   // 25s interval
  private scheduleReconnect()  // 指数退避 1s->2s->4s...->max 30s
}
```

------

## 5. Proserpina Bridge (Python FastAPI, 端口 8765)

### 5.1 架构

5 个 heuristic critic (无 LLM 也能跑):

| Critic           | 检测内容                                                     |
| ---------------- | ------------------------------------------------------------ |
| Devil's Advocate | if (cond) return; 无 else -> critical; // TODO release -> major |
| Methodologist    | new X 无 delete -> major; 函数 >80 行 -> minor               |
| Red Team         | strcpy/sprintf/gets -> critical; FIXME/XXX/HACK -> major     |
| Domain Expert    | selectFrame 无 release -> major; ZSL/RealTimeMCX 无 fallback -> major |
| Editor           | LOGI ("...") 无上下文 -> minor; 常见拼写错误 -> minor        |

API: `POST /critique { document, panel(default|duo|panel), context }` -> `{ findings[], summary, criticCount, mode }`

可选 LLM 模式：配置 `OPENAI_API_KEY` 或 `ANTHROPIC_API_KEY` 后切换。

### 5.2 依赖 (requirements.txt)

```plaintext
fastapi>=0.115.0
uvicorn[standard]>=0.32.0
pydantic>=2.9.0
```

### 5.3 启动

```bash
cd proserpina-bridge
pip install -r requirements.txt
python main.py     # 监听 127.0.0.1:8765
```

------

## 6. 启动脚本

### 6.1 一命令行入口 (scripts/atelier.bat + atelier.ps1)

```plaintext
atelier              -> start (默认)
atelier start        -> kill prior + start all + open browser
atelier stop         -> kill all
atelier restart      -> stop + start
atelier status       -> 端口 + PID
atelier logs <name>  -> tail 日志 (server|frontend|proserpina)
```

`atelier.bat` 做 `chcp 65001` 然后 `powershell atelier.ps1 %*`。

`atelier.ps1` 首次运行自动加 `D:\Atelier\scripts` 到 user PATH。

### 6.2 start-all.ps1

流程:

1. stop-all.ps1 -Quiet (先清理旧进程)
2. Preflight: 检查 node + python, 缺 module 跑 npm install
3. Start-Service 启动 3 服务 (cmd.exe hidden, stdout/stderr -> log)
4. sleep 1.5s -> 开浏览器
5. Background watcher: 2s 后检查 8787 是否 ready

### 6.3 stop-all.ps1

- 单次 WMI 查询: `Get-CimInstance Win32_Process -Filter "Name IN ('node.exe','python.exe','cmd.exe')"`
- 按 commandline 匹配 atelier/server/src/index|vite|tsx watch
- taskkill /F/T /PID 杀进程树 (子进程也死)

------

## 7. 完整启动流程

```bash
# 1. 安装 opencode CLI (必须!)
npm install -g opencode

# 2. 配置 opencode agent
#    复制 opencode.json -> ~/.config/opencode/opencode.json
#    复制 agents/*.md -> ~/.config/opencode/agents/

# 3. 安装前端依赖
cd D:\Atelier
npm install

# 4. 安装后端依赖
cd D:\Atelier\server
npm install

# 5. (可选) 安装 Proserpina bridge 依赖
cd D:\Atelier\proserpina-bridge
pip install -r requirements.txt

# 6. 启动!
atelier   # 一键启动 (或 cd D:\Atelier\scripts && .\atelier.ps1)
# 浏览器自动打开 http://127.0.0.1:5173
```

------

## 8. 关键设计决策

| 决策                                            | 原因                                                         |
| ----------------------------------------------- | ------------------------------------------------------------ |
| per-room shared thread (不是 per-agent history) | agent 需要看到完整房间上下文才能接住用户追问                 |
| DB-backed history (不是 in-memory Map)          | server 重启不丢历史                                          |
| 隐式调度 + 显式 @mention 互补                   | `[RESULT]` -> Lens, `[REVIEW]` + critical -> Forge 自动触发，即使 agent 忘了 @ |
| 末棒收敛到 Atlas                                | 避免 agent 直接对用户输出（不统一），让 Atlas 当面向用户的话事人 |
| 声明！= 产出                                    | tag/@ 只能描述已发生的事实，禁止把计划 / 假设写成 [RESULT]   |
| busy queue                                      | 同 agent 在跑时新消息排队，避免并发双 spawn                  |
| flood detection (10/5)                          | 同 agent 最近 10 条中 >=5 次 -> 拦截                         |
| atlas 的 opencode permission 全 deny            | 防止编排器 "偷偷动手"，保证纯路由                            |
| vite watch.ignored 排除 server/data + logs      | 避免 SQLite WAL 文件写入触发前端整页 reload                  |