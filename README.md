<div align="center">

# 🎨 Atelier

**多 Agent 协作聊天室 —— 与 AI 专家（Atlas · Forge · Lens · Echo）同处一室，**
**流式看到每一步，产出决策而非闲聊。**

<br>

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev)
[![Vite](https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white)](https://vitejs.dev)
[![Fastify](https://img.shields.io/badge/Fastify-5-000000?logo=fastify&logoColor=white)](https://fastify.dev)
[![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?logo=python&logoColor=white)](https://python.org)
[![OpenCode](https://img.shields.io/badge/OpenCode-runtime-blueviolet)](https://github.com/opencode-ai/opencode)

<br>

[快速开始](#-快速开始) · [Per-Agent 模型配置](#-per-agent-模型配置) · [项目结构](#-项目结构) · [API 参考](#-api-参考) · [路线图](#-路线图)

<br>

</div>

---

## ✨ 核心特性

| 能力 | 说明 |
|---|---|
| 🧩 **多 Agent 房间** | 每个房间一套 agent 团队，`@Atlas` / `@Forge` / `@Lens` / `@Echo` 把消息精确路由到对应专家。 |
| 🔁 **隐式交接** | Forge 抛出 `[RESULT]` 自动召唤 Lens 评审；命中 `critical` / `major` 再把 Forge 拉回来返工。 |
| 🛡️ **防刷防深** | 内置频次 / 深度保护（10 条内同 agent ≤ 5 次 / 链深 ≤ 50）防止失控循环。 |
| 📡 **Live Activity 流** | `thinking` / `tool_call` / `handoff` / `completed` / `error` 实时右侧时间线呈现。 |
| 🏷️ **结构化信号卡片** | `[RESULT]` 出 diff、`[REVIEW]` 出严重度 lane + accept/reject、`[QUESTION]` 出内联回复框；`[DECISION]` / `[BLOCKER]` / `[TODO]` 各自专属形态。 |
| 🦾 **Proserpina 评审桥** | 可对任意 agent 输出调用 5 个 Python critic（Methodologist / Devil's Advocate / Editor / Domain Expert / Red Team）。 |
| ⌨️ **Cmd-K 命令栏** | Linear 风调色板：跳房间、建房间、切换 Review / Self-Talk / 右栏。 |
| 📜 **流式 + 跳到底** | Virtuoso 虚拟消息列表，带 Stop 按钮、思考时的 pulse 头像、上滑时浮现"新消息"浮钮。 |
| ⚙️ **Per-Agent 模型路由** | `server/agent-models.json` 一处改各 agent 用什么模型，**无需重启**，下次调用即生效，支持 `preset:` 引用别名。 |
| 🚀 **一键部署** | `atelier deploy` 自动检测环境，幂等补全依赖 + 配置，新机器零配置拉起。 |

---

## 🏗️ 架构一览

```mermaid
flowchart LR
  User["👤 用户<br/>(React UI)"] -- "@Forge 修一下" --> R["Atelier Server<br/>Fastify · :8787"]
  R -- invokeAgent --> Agents["Atlas · Forge · Lens · Echo · Trainer<br/>opencode runtime"]
  Agents -- "[RESULT]" --> R
  R -- handoff --> Lens
  Lens -- "[REVIEW]" --> R
  R -- "WS · 28 events" --> FE["React 19 + Vite<br/>:5173"]
  R -- "POST /api/review" --> PB["Proserpina Bridge<br/>FastAPI · :8765"]
  PB -- "5 个 critic" --> Findings
  FE <-. "WS 事件流" .-> R

  classDef box fill:#eef,stroke:#88a,color:#222
  classDef ext fill:#efe,stroke:#8a8,color:#222
  class User,FE box
  class Agents,PB ext
```

---

## 🚀 快速开始

### 📋 前置依赖

| 工具 | 版本 | 用途 | 是否必须 |
|---|---|---|---|
| Node.js | ≥ 22 | 前端 + 后端运行时 | ✅ 必须 |
| Python | ≥ 3.10 | Proserpina 评审桥 | ⚪ 可选 |
| opencode CLI | latest | Agent 子进程 | ⚪ 可选（缺则回落到 mock） |
| Git | — | 拉取 / 推送代码 | ⚪ 可选 |

支持 **Windows · macOS · Linux** 三平台。

### ⚡ 一键部署（推荐）

```bash
# 在任何目录下:
atelier deploy
```

> Windows 用户：首次运行 `scripts\atelier.ps1` 会自动把 `scripts\` 加到用户 PATH，新终端即可直接用 `atelier`。

`atelier deploy` **自动检测**环境并按 7 步幂等执行：

| 步骤 | 内容 |
|---|---|
| **0. 检测** | OS / Node ≥ 22 / npm / opencode CLI / Python ≥ 3.10 / git |
| **1. 配置** | 部署 `opencode-config/agents/*.md` 到 `~/.config/opencode/agents/`（仅缺则补） |
| 1. 配置 | 从 `.env.example` 生成 `server/.env`（仅缺则补） |
| 1. 配置 | 把 `opencode-agents.template.json` 合并进 `~/.config/opencode/opencode.json`（**只补缺失 agent，provider / mcp 块保留不动**） |
| **2. 建目录** | `server/data/` + `logs/` |
| **3. npm 依赖** | 前端 + 后端（仅缺则补） |
| **4. Python 依赖** | Proserpina `.venv` + `pip install`（可选） |
| **5. PATH** | `scripts/` 加入用户 PATH（幂等） |
| **6. 验证** | server typecheck + 端口探测 |

#### 部署脚本 flags

```powershell
atelier deploy -Start            # 部署完直接拉起服务
atelier deploy -InstallOpencode  # 缺 opencode 时自动 npm install -g
atelier deploy -ForceAgents      # 强制覆盖 ~/.config/opencode/agents/*.md
atelier deploy -SkipPython       # 跳过 Proserpina bridge
atelier deploy -DryRun           # 只打印计划不改任何文件
atelier deploy -ForceConfig      # 同 -InstallOpencode
```

POSIX 等价命令：

```bash
./scripts/deploy.sh --start
./scripts/deploy.sh --install-opencode
./scripts/deploy.sh --force-agents
./scripts/deploy.sh --skip-python
./scripts/deploy.sh --dry-run
```

### 🛠️ 手动安装（旧路径）

```bash
git clone https://github.com/Cappuccino-y/Atelier.git
cd Atelier

# 前端
npm install

# 后端
cd server && npm install && cd ..

# 评审桥（可选但推荐）
cd proserpina-bridge && python -m venv .venv \
  && source .venv/bin/activate \
  && pip install -r requirements.txt && cd ..
```

### ▶️ 启动

```bash
atelier start
```

后台拉起三个服务进程：

| 服务 | 端口 | 健康检查 |
|---|---|---|
| 🖥️ Server | `8787` | http://127.0.0.1:8787 |
| 🎨 Frontend | `5173` | http://127.0.0.1:5173 |
| 🦾 Proserpina | `8765` | http://127.0.0.1:8765/health |

日志位于 `logs/{server,frontend,proserpina}.log`。

### ⏹ 停止与管理

```bash
atelier stop            # 杀掉三端口进程
atelier restart         # 先停再启
atelier status          # 看进程状态
atelier logs server     # tail server 日志
```

---

## 🤖 Per-Agent 模型配置

改 `server/agent-models.json`，**无需重启 server**，下一次 agent 调用即生效：

```json
{
  "default": "custom-saas/minimax-MiniMax-M3-cp",
  "models": {
    "atlas":  "preset:fast",                       // 编排器，便宜就行
    "forge":  "custom-saas/minimax-MiniMax-M3-cp", // 实现者，要能写代码
    "lens":   "comagic/kimi-k2.6-saas",           // 审查者，长上下文友好
    "echo":   "preset:fast",
    "trainer": "custom-saas/minimax-MiniMax-M3-cp"
  },
  "presets": {
    "fast":     "comagic/qwen3.6-flash-saas",
    "balanced": "custom-saas/qwen-3.6-saas",
    "deep":     "custom-saas/glm-5-saas"
  }
}
```

### 解析优先级（首匹配命中）

```
models[<agentId>]   →   default   →   OPENCODE_MODEL env 兜底
```

### Preset 语法

任何字符串以 `preset:` 开头即查 `presets` 表，支持嵌套引用：

```json
"models": { "lens": "preset:deep" }    // → custom-saas/glm-5-saas
"presets": { "deep": "preset:vision" } // → 间接引用
```

### 运行时 API

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET`    | `/api/runtime/agent-models` | 看当前配置 + 每个 agent 实际解析到的 model |
| `PUT`    | `/api/runtime/agent-models` | `{"config": {...}}` — 原子覆盖配置文件，下次调用生效 |
| `POST`   | `/api/runtime/agent-models/reload` | 主动重读（目前 no-op，预留） |

```bash
# 看当前解析
curl http://127.0.0.1:8787/api/runtime/agent-models | jq

# 原子覆盖
curl -X PUT http://127.0.0.1:8787/api/runtime/agent-models \
  -H "Content-Type: application/json" \
  -d '{"config": {"default": "comagic/qwen-3.6-saas", "models": {"atlas": "preset:fast"}}}'
```

> ⚠️ 模型 key 必须出现在你的 `~/.config/opencode/opencode.json` 的 `provider.*.models.*` 列表里。`notes` 块仅作文档，运行时不读。

### 选型建议

| Agent | 角色 | 推荐模型 | 原因 |
|---|---|---|---|
| Atlas | 编排器 | fast preset / Qwen-Flash | 只路由，不深想，便宜即可 |
| Forge | 实现者 | MiniMax-M3 / DeepSeek-V4-Pro | 代码生成能力强 |
| Lens  | 审查者 | MiniMax-M3 / Kimi-K2.6 | 仔细读 + 长上下文友好 |
| Echo  | 支援 | fast preset | 短回复多，便宜省时间 |
| Trainer | 经验固化 | MiniMax-M3 | 结构化输出稳 |

---

## 🧠 Agent 体系

四个内置专家在 `~/.config/opencode/agents/` 里：

| Agent | 角色 | 触发方式 |
|---|---|---|
| 🧭 **Atlas** | 编排（纯路由，绝不动手） | `@Atlas` |
| 🔨 **Forge** | 实现（写代码 / 改配置 / 跑命令） | `@Forge` |
| 🔍 **Lens**  | 评审（只读，找问题出 `[REVIEW]`） | `@Lens` 或 `[RESULT]` 后自动 |
| 💬 **Echo**  | 支援（调研 / 总结 / 日常事务） | `@Echo` |
| 📒 **Trainer**（可选）| 经验固化（KB / 模板 / 踩坑） | `@Trainer` |

### 推进对话的两种方式

1. **显式提及** —— `Hey @Forge，把 triggers.ts 改成 better-sqlite3 事务`
2. **隐式交接** —— agent 输出 `[RESULT]` 时，Lens 自动被召唤做评审；若命中 `critical` / `major`，Forge 再被召唤返工。

### 识别为一等 UI 形态的标签

```
[DECISION]  [TODO]  [STATUS]  [RESULT]  [REVIEW]  [QUESTION]  [BLOCKER]
```

---

## 📁 项目结构

```text
Atelier/
├── project.md                       # 原始需求（zh）
├── README.md
├── package.json                     # 前端（Vite + React 19 + Tailwind v4）
├── index.html
├── vite.config.ts
├── tsconfig.json
│
├── src/                             # 前端（React + Vite）
│   ├── App.tsx                      # 状态 + WS 事件路由
│   ├── main.tsx
│   ├── index.css                    # 设计 token、prose-chat、agent-pulse 动画
│   ├── components/
│   │   ├── chat/                    # MessageList · MessageItem · Composer · RoomHeader
│   │   ├── layout/                  # AppShell · TopBar · Sidebar · RightPanel · CommandBar
│   │   ├── ui/                      # shadcn/ui 原语
│   │   └── *Dialog.tsx
│   ├── lib/                         # api · ws · utils · atch-debug
│   └── types/                       # 共享 TS 类型
│
├── server/                          # 后端（Fastify + tsx）
│   ├── package.json
│   ├── .env                         # 由 deploy 从 .env.example 生成
│   ├── .env.example                 # 配置模板
│   ├── agent-models.json            # ⭐ Per-agent 模型路由配置
│   ├── agent-models.schema.json     # JSON Schema（编辑器可识别）
│   ├── data/                        # SQLite 数据（gitignore）
│   └── src/
│       ├── index.ts                 # Fastify 入口、10 路由、/ws
│       ├── db.ts                    # SQLite 建表 + 种子数据
│       ├── broadcast.ts             # WebSocket 广播
│       ├── config.ts                # ⭐ 加载 agent-models.json + resolveAgentModel()
│       ├── agents/
│       │   ├── runtime.ts           # ⭐ 按 agent id 取模型 → runOpenCodeAgent
│       │   ├── process-agent.ts     # 单 agent 调度封装（spawn opencode CLI）
│       │   ├── triggers.ts          # @ 提及 + 隐式 [RESULT]/[REVIEW] 交接
│       │   ├── arbiter.ts
│       │   └── prompts.ts
│       └── routes/                  # agents · debug · events · mcp · messages · review · rooms · routing · runtime · tasks
│
├── proserpina-bridge/               # Python 评审服务（可选）
│   ├── main.py                      # FastAPI :8765
│   ├── critics/                     # 5 critic: base · methodologist · devils_advocate · editor · domain_expert · red_team
│   └── requirements.txt
│
├── opencode-config/                 # ⭐ 部署模板
│   ├── README.md                    # 加新 agent 的步骤
│   ├── opencode-agents.template.json  # opencode.json 的 agent.* 片段
│   └── agents/
│       ├── atlas.md
│       ├── lens.md
│       ├── echo.md
│       └── trainer.md
│
├── scripts/                         # 一键控制
│   ├── atelier.bat                  # 3 行包装（cmd → atelier.ps1）
│   ├── atelier.ps1                  # PowerShell 主控（start/stop/restart/deploy/...）
│   ├── deploy.ps1                   # ⭐ 一键部署（Windows）
│   └── deploy.sh                    # ⭐ 一键部署（POSIX）
│
└── logs/                            # 运行日志（gitignore）
```

---

## ⚙️ 配置

### 前端 `.env.development`

```bash
VITE_API_URL=http://127.0.0.1:8787
VITE_WS_URL=ws://127.0.0.1:8787/ws
```

### 后端 `server/.env`

```bash
AGENT_RUNTIME=opencode               # "opencode" | "mock"
OPENCODE_MODEL=custom-saas/minimax-MiniMax-M3-cp   # 默认 model
PORT=8787
HOST=127.0.0.1
OPENCODE_TIMEOUT=600000              # 单次 agent 调用超时（ms）
OPENCODE_HANDOFF_DEPTH=50            # 单条消息最大 handoff 深度
AGENT_MAPPING=atlas:atlas,forge:build,lens:lens,echo:echo,trainer:trainer
PROSERPINA_URL=http://127.0.0.1:8765
DB_PATH=./data/atelier.db
LOG_DIR=../logs
```

### 评审桥 `proserpina-bridge/.env`（可选）

```bash
PORT=8765
PANEL=default                        # default · duo · panel
```

---

## 🔌 API 参考

### REST

```
GET    /api/rooms
POST   /api/rooms
GET    /api/rooms/:id
PATCH  /api/rooms/:id
DELETE /api/rooms/:id
POST   /api/rooms/:id/clear
GET    /api/rooms/:id/messages
POST   /api/rooms/:id/messages
GET    /api/rooms/:id/tasks
POST   /api/rooms/:id/tasks
GET    /api/rooms/:id/events
GET    /api/agents
POST   /api/agents
PATCH  /api/agents/:id/status
POST   /api/review                    # → Proserpina 桥
POST   /api/route-to                  # 直接调度 agent
POST   /api/invite                    # 加 agent 进房间
POST   /api/self-talk                 # 切换 self-talk tick
GET    /api/runtime/status
GET    /api/runtime/agent-models      # ⭐ 看 per-agent 模型配置
PUT    /api/runtime/agent-models      # ⭐ 原子覆盖配置
POST   /api/runtime/agent-models/reload
```

### WebSocket 事件（28 个，server → client）

```
message.created · task.created · task.updated · task.deleted
room.created · room.updated · room.deleted · messages.cleared
project.updated · agent.created · agent.updated · agent.status
agent.thinking · agent.tool_call · agent.handoff
agent.completed · agent.error · activity.cleared
self_talk.start · self_talk.stop · self_talk.tick
escalation · rework · finding.accepted · finding.rejected
review.completed · routing.route · routing.invite
system.warning · system.info · system.error · ping · pong
```

---

## 🛠 开发

```bash
# Server（tsx，无 watch — 手动重启最快）
cd server && npm run dev

# 带 HMR 的 server（Windows 上较慢）
cd server && npm run dev:watch

# 前端（Vite HMR）
npm run dev          # vite
npm run build        # 生产构建
npm run preview      # 预览产物
npm run typecheck    # tsc --noEmit

# 评审桥
cd proserpina-bridge && uvicorn main:app --reload --port 8765

# 跑 server 单元测试
cd server && npm test
```

---

## 🔭 路线图

- [ ] LLM token 流式推到 WS（目前 agent 回复是一次性返回）
- [ ] SQLite → Postgres 迁移工具
- [ ] Agent 记忆：跨重启的 per-room 上下文窗口
- [ ] 多租户：单 server 多 workspace
- [ ] `[RESULT]` 卡片内嵌 diff 视图（左右并排）
- [ ] Proserpina Web UI，可按 workspace 调 critic 权重
- [ ] Per-Agent 模型热切换界面（前端）
- [ ] 视觉型 agent（图片 / 截图输入）

---

## 📄 许可

[MIT](LICENSE) —— 见 `LICENSE`（若尚未添加请补一份）。

---

<div align="center">

**⭐ 如果这个项目对你有帮助，欢迎 star！**

<sub>Built with ❤️ · Powered by [opencode](https://github.com/opencode-ai/opencode) · UI by [shadcn/ui](https://ui.shadcn.com)</sub>

</div>