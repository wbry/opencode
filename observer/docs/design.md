# OpenCode Observer - Web Session Monitor 设计文档

## 1. 项目概述

OpenCode Observer 是一个 Web 端的 Session 活动监控服务，随 `opencode serve` 启动时同时拉起。它提供类似 TUI 的实时体验，在浏览器中展示当前所有 Session 的活动状态、大模型交互实时流、Tool 调用实时流、Subagent 调用实时流等。

### 1.1 核心目标

- 实时列出所有 Session，标识当前正在运行的 Session
- 切换到某个 Session 时，实时显示 LLM 交互流（文本流、推理流）
- 实时显示 Tool 调用流（调用开始、输入流、进度、成功/失败）
- 实时显示 Subagent 调用流
- 复用 opencode serve 的 HTTP API，无需额外端口

## 2. 源码分析总结

### 2.1 opencode serve 架构

`opencode serve` 启动流程：

```
ServeCommand → Server.listen(opts) → HttpApiApp.createRoutes()
  → 合并所有 API 路由层:
    - RootHttpApi (control, control-plane, global)
    - EventApi (SSE 事件流)
    - PtyConnectApi (WebSocket)
    - InstanceHttpApi (session, config, file, tui, etc.)
    - V2Api (v2 session, message, event, etc.)
    - docRoute (OpenAPI spec)
    - uiRoute (嵌入式 Web UI 代理)
```

服务器使用 Effect HTTP 框架，监听端口默认 4096，支持 CORS、认证、压缩等中间件。

### 2.2 HTTP API 端点

#### V1 Instance API（主要使用）

| 端点 | 方法 | 说明 |
|------|------|------|
| `/session` | GET | 列出所有 Session |
| `/session/status` | GET | 获取所有 Session 状态（active/idle/completed） |
| `/session/:sessionID` | GET | 获取 Session 详情 |
| `/session/:sessionID/message` | GET | 获取 Session 消息列表 |
| `/session/:sessionID/message/:messageID` | GET | 获取单条消息 |
| `/session/:sessionID/todo` | GET | 获取 Session Todo 列表 |
| `/session/:sessionID/diff` | GET | 获取消息 Diff |
| `/event` | GET (SSE) | 订阅实时事件流 |
| `/agent` | GET | 列出所有 Agent |
| `/tui/select-session` | POST | 选择 Session |
| `/tui/append-prompt` | POST | 追加 Prompt |

#### V2 API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/session` | GET | 列出 V2 Session（分页） |
| `/api/session/:sessionID/context` | GET | 获取 Session 上下文消息 |
| `/api/session/:sessionID/message` | GET | 获取 V2 消息（分页） |
| `/api/session/:sessionID/prompt` | POST | 发送消息 |
| `/api/session/:sessionID/wait` | POST | 等待 Session 空闲 |
| `/api/event` | GET (SSE) | 订阅 V2 事件流 |
| `/api/agent` | GET | 列出 Agent |

### 2.3 SSE 事件流

opencode 提供两个 SSE 端点用于实时事件推送：

1. **V1 `/event`**：通过 `EventV2Bridge` 桥接，推送所有事件，格式为 `{ id, type, properties }`，包含心跳（10s 间隔），按 directory + workspaceID 过滤。

2. **V2 `/api/event`**：原生 EventV2 事件流，格式为 `{ id, type, location, metadata, version, data }`，按 location 过滤。

### 2.4 Session 事件类型（核心数据源）

Session 事件定义在 `@opencode-ai/core/session/event.ts`，分为持久事件和瞬态事件：

#### 持久事件（Durable Events）

| 事件类型 | type 字符串 | 说明 |
|----------|-------------|------|
| AgentSwitched | `session.next.agent.switched` | Agent 切换 |
| ModelSwitched | `session.next.model.switched` | 模型切换 |
| Prompted | `session.next.prompted` | 用户发送 Prompt |
| PromptAdmitted | `session.next.prompt.admitted` | Prompt 被接受 |
| PromptPromoted | `session.next.prompt.promoted` | Prompt 被提升 |
| InterruptRequested | `session.next.interrupt.requested` | 请求中断 |
| StepStarted | `session.next.step.started` | **步骤开始（LLM 调用开始）** |
| StepEnded | `session.next.step.ended` | **步骤结束（LLM 调用完成）** |
| StepFailed | `session.next.step.failed` | 步骤失败 |
| TextStarted | `session.next.text.started` | 文本输出开始 |
| TextEnded | `session.next.text.ended` | 文本输出结束 |
| ToolInputStarted | `session.next.tool.input.started` | **Tool 输入开始** |
| ToolInputEnded | `session.next.tool.input.ended` | Tool 输入结束 |
| ToolCalled | `session.next.tool.called` | **Tool 被调用** |
| ToolProgress | `session.next.tool.progress` | **Tool 执行进度** |
| ToolSuccess | `session.next.tool.success` | **Tool 执行成功** |
| ToolFailed | `session.next.tool.failed` | **Tool 执行失败** |
| ReasoningStarted | `session.next.reasoning.started` | 推理输出开始 |
| ReasoningEnded | `session.next.reasoning.ended` | 推理输出结束 |
| ShellStarted | `session.next.shell.started` | Shell 命令开始 |
| ShellEnded | `session.next.shell.ended` | Shell 命令结束 |
| CompactionStarted | `session.next.compaction.started` | 压缩开始 |
| CompactionEnded | `session.next.compaction.ended` | 压缩结束 |
| Retried | `session.next.retried` | 重试 |

#### 瞬态事件（Ephemeral Events - 仅实时流，不持久化）

| 事件类型 | type 字符串 | 说明 |
|----------|-------------|------|
| TextDelta | `session.next.text.delta` | **文本流增量** |
| ToolInputDelta | `session.next.tool.input.delta` | Tool 输入流增量 |
| ReasoningDelta | `session.next.reasoning.delta` | 推理流增量 |
| CompactionDelta | `session.next.compaction.delta` | 压缩流增量 |

### 2.5 Session 消息类型

消息定义在 `@opencode-ai/core/session/message.ts`：

| 消息类型 | type 字段 | 说明 |
|----------|-----------|------|
| User | `user` | 用户消息 |
| Assistant | `assistant` | AI 助手回复 |
| AgentSwitched | `agent-switched` | Agent 切换 |
| ModelSwitched | `model-switched` | 模型切换 |
| Synthetic | `synthetic` | 合成消息 |
| System | `system` | 系统消息 |
| Shell | `shell` | Shell 命令 |
| Compaction | `compaction` | 压缩摘要 |

#### Assistant 消息内容类型

| 内容类型 | type 字段 | 说明 |
|----------|-----------|------|
| AssistantText | `text` | 文本内容 |
| AssistantReasoning | `reasoning` | 推理内容 |
| AssistantTool | `tool` | Tool 调用 |

#### Tool 状态类型

| 状态 | status 字段 | 说明 |
|------|-------------|------|
| ToolStatePending | `pending` | 等待执行 |
| ToolStateRunning | `running` | 正在执行 |
| ToolStateCompleted | `completed` | 执行完成 |
| ToolStateError | `error` | 执行出错 |

### 2.6 Session 状态

通过 `/session/status` 端点获取，返回 `Record<sessionID, SessionStatus.Info>`，包含 active/idle/completed 等状态。

### 2.7 认证机制

- 如果设置了 `OPENCODE_SERVER_PASSWORD` 环境变量，请求需要 Basic Auth（username: `opencode`, password: 设置的值）
- 如果未设置，服务器无认证（会打印警告）
- V2 API 通过 `x-opencode-directory` header 路由到正确的项目实例

### 2.8 插件系统

opencode 支持两种插件：
- **Server Plugin**：`PluginModule.server`，在 serve 模式下运行，可监听事件、注册工具、修改行为
- **TUI Plugin**：`PluginModule.tui`，在 TUI 模式下运行，可扩展 UI

Server Plugin 通过 `Hooks.event` 钩子可以接收所有事件，这是 Observer 的关键集成点。

## 3. 系统架构设计

### 3.1 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                    opencode serve                            │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  HTTP API    │  │  SSE Event   │  │  Observer Plugin  │  │
│  │  (existing)  │  │  Stream      │  │  (server plugin)  │  │
│  │              │  │  (existing)  │  │                    │  │
│  │ /session     │  │ /event       │  │  hooks.event()    │  │
│  │ /session/    │  │ /api/event   │  │                    │  │
│  │  status      │  │              │  │  ↓                 │  │
│  │ /session/    │  │              │  │  Static Web Files  │  │
│  │  :id/message │  │              │  │  (embedded)        │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
│         ↑                ↑                    ↑              │
│         │                │                    │              │
│  ┌──────┴────────────────┴────────────────────┴──────────┐  │
│  │              Browser (SPA Frontend)                    │  │
│  │                                                        │  │
│  │  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐ │  │
│  │  │ Session List │  │ Session View │  │ Event Stream │ │  │
│  │  │ (sidebar)    │  │ (main area)  │  │ (SSE client) │ │  │
│  │  └─────────────┘  └──────────────┘  └──────────────┘ │  │
│  └────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 技术选型

| 组件 | 选择 | 理由 |
|------|------|------|
| 前端框架 | Vanilla HTML/CSS/JS | 零依赖，嵌入 serve，无需构建步骤 |
| 实时通信 | SSE (EventSource) | opencode 已原生支持 SSE |
| 数据获取 | Fetch API | 调用现有 HTTP API |
| 代码高亮 | 轻量级 CSS | 无需外部依赖 |
| 部署方式 | Server Plugin + 静态文件 | 随 serve 启动，无需额外端口 |

### 3.3 为什么选择 Server Plugin 方式

1. **零侵入**：不需要修改 opencode 核心代码
2. **自动启动**：随 `opencode serve` 启动时自动加载
3. **事件访问**：通过 `hooks.event` 可以接收所有实时事件
4. **API 复用**：直接使用 serve 的 HTTP API，无需额外端口
5. **静态文件服务**：通过 Plugin 机制注册静态文件路由

## 4. 详细设计

### 4.1 目录结构

```
observer/
├── docs/
│   └── design.md          # 本设计文档
├── src/
│   ├── index.ts           # Plugin 入口，注册 hooks 和静态文件路由
│   ├── event-collector.ts # 事件收集器，整理 SSE 事件为结构化数据
│   └── static/            # 前端静态文件
│       ├── index.html     # 主页面
│       ├── style.css      # 样式
│       └── app.js         # 前端应用逻辑
└── package.json           # 包配置
```

### 4.2 Plugin 入口 (index.ts)

```typescript
// 作为 opencode server plugin 运行
import type { Plugin, Hooks, PluginInput } from "@opencode-ai/plugin"

const plugin: Plugin = async (input, options) => {
  const { client, serverUrl } = input

  return {
    // 监听所有事件，用于 Observer 内部状态维护
    event: async ({ event }) => {
      // 事件通过 SSE 直接推送到前端，此处无需额外处理
    },
  }
}

export default plugin
```

### 4.3 前端架构

#### 4.3.1 页面布局

```
┌──────────────────────────────────────────────────┐
│  OpenCode Observer                    [connected] │
├──────────────┬───────────────────────────────────┤
│              │  Session: xxx                     │
│  Sessions    │  Agent: code  Model: claude-4     │
│              │  Status: ● active                 │
│  ● ses_xxx   │───────────────────────────────────│
│    active    │                                   │
│  ○ ses_yyy   │  [User]                           │
│    idle      │  Help me implement...             │
│  ○ ses_zzz   │                                   │
│    idle      │  [Assistant]                      │
│              │  I'll help you implement that...  │
│              │  ████████████░░░░ (streaming)     │
│              │                                   │
│              │  🔧 Tool: Read                    │
│              │  📄 /path/to/file.ts              │
│              │  ✓ completed                      │
│              │                                   │
│              │  🔧 Tool: Bash                    │
│              │  $ npm test                       │
│              │  ● running...                     │
│              │  ┌─ output ──────────────────┐    │
│              │  │ test 1: pass              │    │
│              │  │ test 2: pass              │    │
│              │  │ test 3: ░░░ (streaming)   │    │
│              │  └───────────────────────────┘    │
│              │                                   │
│              │  💭 Reasoning:                    │
│              │  Let me think about this...       │
│              │                                   │
│              │───────────────────────────────────│
│              │  Tokens: 1.2k in / 800 out       │
│              │  Cost: $0.03                      │
└──────────────┴───────────────────────────────────┘
```

#### 4.3.2 前端数据流

```
1. 页面加载
   ├── GET /session → 获取 Session 列表
   ├── GET /session/status → 获取 Session 状态
   └── EventSource(/event) → 建立 SSE 连接

2. SSE 事件处理
   ├── session.next.step.started → 标记 Session 为 active
   ├── session.next.step.ended → 标记 Session 为 idle
   ├── session.next.text.delta → 追加文本流
   ├── session.next.text.started/ended → 文本块边界
   ├── session.next.tool.called → 显示 Tool 调用
   ├── session.next.tool.progress → 更新 Tool 进度
   ├── session.next.tool.success/failed → Tool 结果
   ├── session.next.reasoning.delta → 推理流
   └── session.next.prompted → 用户消息

3. 切换 Session
   ├── GET /session/:id/message → 加载历史消息
   └── SSE 事件按 sessionID 过滤显示
```

#### 4.3.3 事件到 UI 的映射

| SSE 事件 | UI 行为 |
|----------|---------|
| `session.next.step.started` | Session 状态 → active，显示 agent/model 信息 |
| `session.next.text.delta` | 追加文本到当前 Assistant 消息，显示打字效果 |
| `session.next.text.started` | 创建新文本块 |
| `session.next.text.ended` | 文本块完成 |
| `session.next.reasoning.delta` | 追加到推理区域（可折叠） |
| `session.next.reasoning.started` | 创建推理块 |
| `session.next.tool.input.started` | 显示 Tool 调用开始（spinner） |
| `session.next.tool.called` | 显示 Tool 名称和输入参数 |
| `session.next.tool.progress` | 更新 Tool 进度（输出内容） |
| `session.next.tool.success` | Tool 成功标记，显示结果 |
| `session.next.tool.failed` | Tool 失败标记，显示错误 |
| `session.next.step.ended` | Session 状态 → idle，显示 token/cost 统计 |
| `session.next.step.failed` | 显示错误信息 |
| `session.next.prompted` | 显示用户消息 |
| `session.next.agent.switched` | 显示 Agent 切换 |
| `session.next.model.switched` | 显示 Model 切换 |
| `server.heartbeat` | 更新连接状态指示 |

### 4.4 认证处理

前端需要处理认证：

```javascript
// 从 URL 获取或提示输入密码
function getAuthHeaders() {
  const password = localStorage.getItem('opencode_password') || ''
  if (password) {
    return { 'Authorization': 'Basic ' + btoa('opencode:' + password) }
  }
  return {}
}

// SSE 连接需要认证
function createEventSource(url) {
  // EventSource 不支持自定义 header，使用查询参数或 cookie 方案
  // 方案：先通过 fetch 验证认证，获取 session cookie
  // 或使用 V2 API 的 /api/event 端点
}
```

由于 `EventSource` 不支持自定义 Header，认证方案调整为：
1. 首次访问时通过 fetch 请求验证认证
2. 认证成功后，服务端设置 cookie
3. SSE 连接自动携带 cookie

### 4.5 静态文件服务

Observer 的前端文件需要通过 opencode serve 提供。方案：

1. **方案 A：通过 Plugin 注册路由** - 在 server plugin 中注册 `/observer/*` 路由返回静态文件
2. **方案 B：独立 HTTP 服务** - 在 plugin 中启动一个轻量 HTTP 服务器

选择 **方案 A**，因为 opencode 的 UI 服务已有成熟的静态文件代理机制（`serveUIEffect`），可以复用。

但由于 Plugin 的 hook 机制不直接支持注册 HTTP 路由，实际实现采用：

**方案 C：将 Observer 前端文件直接放入 opencode 的嵌入式 Web UI 目录**，或通过 `uiRoute` 的 catch-all 机制在特定路径下提供。

最终方案：**在 opencode plugin 目录下创建 observer 子工程，作为 server plugin 加载。前端文件通过 plugin 的静态资源提供，注册自定义路由到 opencode 的 HTTP 服务器。**

### 4.6 关键实现细节

#### 4.6.1 SSE 事件过滤

SSE 事件流包含所有 Session 的事件，前端需要按 `sessionID` 过滤：

```javascript
// 事件中的 sessionID 提取
function getSessionID(event) {
  return event.properties?.sessionID
}
```

V2 事件的 sessionID 在 `data.sessionID` 字段中。

#### 4.6.2 实时文本流

文本流通过 `session.next.text.delta` 事件实现逐字显示：

```
text.started → 创建文本容器
text.delta → 追加文本片段（实时流）
text.ended → 文本完成，替换为最终文本
```

#### 4.6.3 Tool 调用流

Tool 调用的完整生命周期：

```
tool.input.started → 显示 Tool 名称，spinner
tool.input.delta → 输入参数流
tool.input.ended → 输入完成
tool.called → 显示完整输入参数
tool.progress → 执行进度更新
tool.success / tool.failed → 最终结果
```

#### 4.6.4 Subagent 调用

Subagent 调用通过 Tool 调用体现（Tool 名称为 subagent 相关），事件流中：
- `tool.called` 的 `tool` 字段标识为 subagent 类型
- subagent 内部的活动通过同一事件流的 `sessionID` 关联

#### 4.6.5 Session 活跃状态判定

通过以下事件判定 Session 是否活跃：

| 事件 | 状态变化 |
|------|---------|
| `session.next.step.started` | → active |
| `session.next.step.ended` | → idle |
| `session.next.step.failed` | → idle (error) |
| `session.next.prompted` | → active (pending) |

也可通过 `/session/status` API 轮询获取。

## 5. API 使用规划

### 5.1 初始化阶段

```
GET /session          → 获取 Session 列表
GET /session/status   → 获取所有 Session 状态
GET /agent            → 获取 Agent 列表
```

### 5.2 实时监控阶段

```
GET /event (SSE)      → 订阅实时事件流
```

### 5.3 Session 详情阶段

```
GET /session/:id           → 获取 Session 信息
GET /session/:id/message   → 获取历史消息
GET /session/:id/todo      → 获取 Todo 列表
GET /session/:id/diff      → 获取文件变更
```

### 5.4 交互操作

```
POST /session/:id/prompt_async  → 异步发送消息
POST /session/:id/abort         → 中断 Session
```

## 6. 实现计划

### Phase 1: 核心框架
- 创建 observer plugin 工程结构
- 实现 server plugin 入口
- 实现静态文件服务路由
- 基础 HTML 页面框架

### Phase 2: Session 列表
- Session 列表展示
- Session 状态实时更新
- Session 切换

### Phase 3: 实时事件流
- SSE 连接建立
- 事件解析和分发
- 文本流实时显示
- 推理流实时显示

### Phase 4: Tool 调用流
- Tool 调用生命周期展示
- Tool 进度实时更新
- Tool 输入/输出展示

### Phase 5: 增强功能
- 认证处理
- 消息历史加载
- Token/Cost 统计展示
- 响应式布局优化

## 7. 实现说明

### 7.1 文件结构

```
observer/
├── docs/
│   └── design.md          # 设计文档
├── src/
│   ├── index.ts           # Server Plugin 入口
│   └── serve.ts           # 独立静态文件服务器（开发模式）
├── static/
│   ├── index.html         # 主页面
│   ├── style.css          # 样式
│   └── app.js             # 前端应用逻辑
├── package.json
└── tsconfig.json
```

### 7.2 集成方式

Observer 通过以下方式集成到 opencode serve：

1. **路由注册**：在 `packages/opencode/src/server/routes/instance/httpapi/server.ts` 中添加了 `/observer` 和 `/observer/:file` 路由，用于服务 Observer 的静态文件。

2. **静态文件路径**：Observer 的静态文件位于仓库根目录的 `observer/static/` 下，通过 `import.meta.dirname` 相对路径解析。

3. **访问方式**：启动 `opencode serve` 后，浏览器访问 `http://localhost:4096/observer` 即可打开 Observer。

4. **开发模式**：也可以通过 `bun run observer/src/serve.ts` 启动独立的开发服务器（端口 4097），它会代理 API 请求到 opencode serve。

### 7.3 前端工作流程

1. 用户打开 `http://localhost:4096/observer`
2. 输入项目目录（用于 workspace routing）和密码（如果需要）
3. 点击 Connect，建立 SSE 连接到 `/event`
4. 前端获取 Session 列表和状态
5. 点击 Session 查看详情，加载历史消息
6. SSE 事件实时推送，前端按 sessionID 过滤并渲染

### 7.4 限制与注意事项

1. **EventSource 认证**：浏览器 EventSource API 不支持自定义 Header，需要通过 cookie 或查询参数传递认证信息
2. **事件顺序**：SSE 事件可能乱序到达，前端需要根据 `seq` 字段排序
3. **连接断开**：SSE 连接可能断开，需要自动重连机制
4. **大量 Session**：Session 数量较多时，列表渲染需要虚拟滚动
5. **跨域**：如果浏览器和 serve 不在同一域，需要 CORS 支持（opencode 已内置）
6. **V1/V2 API 选择**：优先使用 V1 Instance API（更完整），SSE 使用 V1 `/event` 端点
7. **Workspace Routing**：V1 API 需要 `directory` 参数或 `x-opencode-directory` header 来路由到正确的项目实例
