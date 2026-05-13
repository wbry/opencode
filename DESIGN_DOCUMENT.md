# OpenCode 二次开发设计文档：设备任务调度服务器

> 版本：1.0  
> 日期：2026-05-13  
> 目标：将 OpenCode 改造为承接上游任务的设备操作调度 Server

---

## 一、现有架构分析

### 1.1 项目整体结构

OpenCode 是一个基于 TypeScript (Bun runtime) 的 AI 编码助手，采用 monorepo 结构，核心代码位于 `packages/opencode/src/`。

```
packages/opencode/src/
├── agent/          # Agent 定义与配置
├── acp/            # Agent Client Protocol 实现
├── bus/            # 事件总线（PubSub）
├── cli/            # TUI / CLI 入口
├── config/         # 配置系统
├── control-plane/  # 工作区管理
├── effect/         # Effect 依赖注入与运行时
├── lsp/            # LSP 集成
├── mcp/            # MCP 工具集成
├── permission/     # 权限系统
├── plugin/         # 插件系统
├── project/        # 项目/实例管理
├── provider/       # LLM Provider 管理
├── pty/            # 伪终端
├── server/         # HTTP API / WebSocket 服务器
├── session/        # 会话管理（核心）
├── skill/          # 技能系统
├── storage/        # 数据库（Drizzle ORM + SQLite）
├── sync/           # 事件溯源（Event Sourcing）
├── tool/           # 工具系统
├── v2/             # V2 API（实验性）
└── util/           # 工具函数
```

### 1.2 核心模块依赖关系

```
┌──────────────────────────────────────────────────────────┐
│                     HTTP Server Layer                      │
│  (server/routes → handlers → groups → middleware)         │
├──────────────────────────────────────────────────────────┤
│                     Session Layer                          │
│  (session → prompt → processor → message → compaction)    │
├──────────────────────────────────────────────────────────┤
│                     Agent Layer                            │
│  (agent → subagent-permissions → TaskTool)                │
├──────────────────────────────────────────────────────────┤
│               Infrastructure Layer                         │
│  (bus → sync → storage → config → permission → provider)  │
└──────────────────────────────────────────────────────────┘
```

### 1.3 关键架构特征

| 特征 | 实现方式 | 关键文件 |
|------|---------|---------|
| **Agent 定义** | `Agent.Info` Schema，含 name/mode/permission/model | `agent/agent.ts` |
| **Agent 模式** | `primary`（主代理）/ `subagent`（子代理）/ `all` | `agent/agent.ts:L31` |
| **子代理创建** | `TaskTool` 创建子 Session，parentID 关联父 Session | `tool/task.ts` |
| **权限派生** | `deriveSubagentSessionPermission` 从父 Agent 派生 | `agent/subagent-permissions.ts` |
| **事件总线** | Effect PubSub，支持类型订阅和通配订阅 | `bus/index.ts` |
| **事件溯源** | SyncEvent 持久化 + Projector 投影到读模型 | `sync/index.ts` |
| **HTTP API** | Effect HttpApiBuilder，声明式路由定义 | `server/routes/instance/httpapi/` |
| **WebSocket** | websocket-tracker 管理连接，SSE 推送事件 | `server/routes/instance/httpapi/websocket-tracker.ts` |
| **会话事件流** | V2 SessionEvent（Step/Text/Tool/Reasoning 等） | `v2/session-event.ts` |
| **MCP 集成** | 支持 stdio/SSE/HTTP 传输的 MCP 客户端 | `mcp/index.ts` |
| **配置系统** | 多层合并：全局 → 项目 → 环境变量 | `config/config.ts` |

### 1.4 现有 Agent 体系

```typescript
// agent/agent.ts 中定义的内置 Agent
{
  build:      { mode: "primary",  native: true },  // 默认主代理
  plan:       { mode: "primary",  native: true },  // 规划模式
  general:    { mode: "subagent", native: true },  // 通用子代理
  explore:    { mode: "subagent", native: true },  // 代码探索子代理
  scout:      { mode: "subagent", native: true },  // 文档搜索子代理
  compaction: { mode: "primary",  native: true, hidden: true },
  title:      { mode: "primary",  native: true, hidden: true },
  summary:    { mode: "primary",  native: true, hidden: true },
}
```

### 1.5 现有 Session 事件模型

V2 SessionEvent 定义了完整的会话生命周期事件：

```
session.next.agent.switched    # Agent 切换
session.next.model.switched    # Model 切换
session.next.prompted          # 用户提示
session.next.step.started      # 步骤开始
session.next.step.ended        # 步骤结束
session.next.step.failed       # 步骤失败
session.next.text.started      # 文本生成开始
session.next.text.delta        # 文本增量
session.next.text.ended        # 文本生成结束
session.next.tool.called       # 工具调用
session.next.tool.progress     # 工具进度
session.next.tool.success      # 工具成功
session.next.tool.failed       # 工具失败
session.next.reasoning.*       # 推理过程
session.next.retried           # 重试
session.next.compaction.*      # 压缩
```

---

## 二、总体架构设计

### 2.1 目标架构

将 OpenCode 从「单用户编码助手」改造为「多设备任务调度服务器」：

```
┌─────────────────────────────────────────────────────────────────┐
│                        Upstream System                           │
│                  (上游任务调度 / CI/CD / 测试平台)                │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTP API / WebSocket
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                    OpenCode Device Server                        │
│  ┌─────────────┐ ┌──────────────┐ ┌──────────────────────────┐ │
│  │   Device     │ │  Dispatcher  │ │   Analytics Module       │ │
│  │  Manager     │ │    Agent     │ │   (运营打点)              │ │
│  └──────┬──────┘ └──────┬───────┘ └──────────────────────────┘ │
│         │               │                                       │
│  ┌──────┴──────┐ ┌──────┴───────┐ ┌──────────────────────────┐ │
│  │  Device      │ │  Sub-Agent   │ │   Stream Distributor     │ │
│  │  Registry    │ │  Pool        │ │   (输出流分发)            │ │
│  └──────┬──────┘ └──────┬───────┘ └──────────────────────────┘ │
│         │               │                                       │
│  ┌──────┴───────────────┴──────────────────────────────────┐   │
│  │              Core Session / Bus / Sync Layer              │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
         │               │               │
    ┌────┴────┐    ┌─────┴─────┐   ┌────┴────┐
    │ Android │    │ HarmonyOS │   │   iOS   │
    │ Device  │    │  Device   │   │ Device  │
    └─────────┘    └───────────┘   └─────────┘
```

### 2.2 新增模块清单

| 模块 | 路径 | 职责 |
|------|------|------|
| Device Manager | `src/device/` | 设备注册、发现、状态管理、心跳 |
| Dispatcher Agent | `src/agent/` (扩展) | 任务分配主代理，替代 build 成为默认 primary |
| Device Sub-Agent | `src/agent/` (扩展) | 设备操作子代理，按设备类型特化 |
| Stream Distributor | `src/stream/` | 子 Agent 输出流的独立分发与路由 |
| Analytics Module | `src/analytics/` | 运营打点接口预留，事件采集与上报 |

### 2.3 改造原则

1. **最小侵入**：尽量通过扩展而非修改现有代码实现新功能
2. **Effect 兼容**：新模块遵循 Effect 依赖注入模式（Service/Layer）
3. **事件驱动**：利用现有 Bus/SyncEvent 体系进行模块间通信
4. **配置驱动**：新功能通过 `opencode.json` 配置开关控制
5. **向后兼容**：不破坏现有 CLI/TUI 模式的正常使用

---

## 三、模块详细设计

### 3.1 设备管理模块 (Device Manager)

#### 3.1.1 模块定位

设备管理模块负责管理本地连接的移动设备（Android/鸿蒙/iOS 等），提供设备注册、发现、状态监控和心跳保活能力，为任务分配代理提供设备维度的上下文信息。

#### 3.1.2 数据模型

```typescript
// src/device/schema.ts

import { Schema } from "effect"
import { Identifier } from "@/id/id"

export const DeviceID = Schema.String.check(Schema.isStartsWith("dev")).pipe(
  Schema.brand("DeviceID"),
)

export type DeviceID = Schema.Schema.Type<typeof DeviceID>

export const DevicePlatform = Schema.Literals(
  "android",
  "harmonyos",
  "ios",
)
export type DevicePlatform = Schema.Schema.Type<typeof DevicePlatform>

export const DeviceStatus = Schema.Literals(
  "online",
  "offline",
  "busy",
  "error",
)
export type DeviceStatus = Schema.Schema.Type<typeof DeviceStatus>

export const DeviceInfo = Schema.Struct({
  id: DeviceID,
  name: Schema.String,
  platform: DevicePlatform,
  platformVersion: Schema.String,
  serialNumber: Schema.String,
  model: Schema.String,
  manufacturer: Schema.String,
  status: DeviceStatus,
  capabilities: Schema.Array(Schema.String),
  connectionType: Schema.Literals("usb", "wifi", "tcp"),
  connectionAddress: Schema.optional(Schema.String),
  lastHeartbeat: Schema.Number,
  metadata: Schema.Record(Schema.String, Schema.Unknown),
  time: Schema.Struct({
    registered: Schema.Number,
    updated: Schema.Number,
  }),
})
export type DeviceInfo = Schema.Schema.Type<typeof DeviceInfo>

export const DeviceCommand = Schema.Struct({
  deviceID: DeviceID,
  command: Schema.String,
  args: Schema.Array(Schema.String),
  timeout: Schema.optional(Schema.Number),
})
export type DeviceCommand = Schema.Schema.Type<typeof DeviceCommand>

export const DeviceCommandResult = Schema.Struct({
  deviceID: DeviceID,
  command: Schema.String,
  exitCode: Schema.Number,
  stdout: Schema.String,
  stderr: Schema.String,
  duration: Schema.Number,
})
export type DeviceCommandResult = Schema.Schema.Type<typeof DeviceCommandResult>
```

#### 3.1.3 数据库表

```sql
-- migration/XXXX_add_device_tables/migration.sql

CREATE TABLE device (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  platform_version TEXT NOT NULL,
  serial_number TEXT NOT NULL UNIQUE,
  model TEXT NOT NULL,
  manufacturer TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'offline',
  capabilities TEXT NOT NULL DEFAULT '[]',
  connection_type TEXT NOT NULL DEFAULT 'usb',
  connection_address TEXT,
  last_heartbeat INTEGER NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  time_registered INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);

CREATE INDEX idx_device_platform ON device(platform);
CREATE INDEX idx_device_status ON device(status);
CREATE INDEX idx_device_serial ON device(serial_number);

CREATE TABLE device_command_log (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES device(id),
  session_id TEXT,
  command TEXT NOT NULL,
  args TEXT NOT NULL DEFAULT '[]',
  exit_code INTEGER,
  stdout TEXT,
  stderr TEXT,
  duration INTEGER,
  time_created INTEGER NOT NULL,
  time_completed INTEGER
);

CREATE INDEX idx_device_command_device ON device_command_log(device_id);
CREATE INDEX idx_device_command_session ON device_command_log(session_id);
```

#### 3.1.4 Service 接口

```typescript
// src/device/device.ts

import { Context, Effect, Layer, Stream, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { DeviceID, DeviceInfo, DevicePlatform, DeviceStatus, DeviceCommand, DeviceCommandResult } from "./schema"
import { Bus } from "@/bus"
import { SyncEvent } from "@/sync"

export interface Interface {
  readonly register: (input: {
    name: string
    platform: DevicePlatform
    platformVersion: string
    serialNumber: string
    model: string
    manufacturer: string
    capabilities?: string[]
    connectionType?: "usb" | "wifi" | "tcp"
    connectionAddress?: string
    metadata?: Record<string, unknown>
  }) => Effect.Effect<DeviceInfo>

  readonly unregister: (deviceID: DeviceID) => Effect.Effect<void>

  readonly get: (deviceID: DeviceID) => Effect.Effect<DeviceInfo, DeviceNotFoundError>

  readonly list: (filter?: {
    platform?: DevicePlatform
    status?: DeviceStatus
  }) => Effect.Effect<DeviceInfo[]>

  readonly heartbeat: (deviceID: DeviceID) => Effect.Effect<void>

  readonly updateStatus: (deviceID: DeviceID, status: DeviceStatus) => Effect.Effect<void>

  readonly executeCommand: (input: DeviceCommand) => Effect.Effect<DeviceCommandResult>

  readonly watch: (deviceID?: DeviceID) => Stream.Stream<DeviceEvent>

  readonly onlineCount: () => Effect.Effect<number>
}

export class DeviceNotFoundError extends Schema.TaggedErrorClass<DeviceNotFoundError>()(
  "Device.NotFoundError",
  { deviceID: DeviceID },
) {}

export class Service extends Context.Service<Service, Interface>()("@opencode/Device") {}
```

#### 3.1.5 Bus 事件定义

```typescript
// src/device/events.ts

import { BusEvent } from "@/bus/bus-event"
import { Schema } from "effect"
import { DeviceID, DevicePlatform, DeviceStatus } from "./schema"

export const DeviceRegistered = BusEvent.define(
  "device.registered",
  Schema.Struct({
    deviceID: DeviceID,
    platform: DevicePlatform,
    name: Schema.String,
  }),
)

export const DeviceUnregistered = BusEvent.define(
  "device.unregistered",
  Schema.Struct({
    deviceID: DeviceID,
  }),
)

export const DeviceStatusChanged = BusEvent.define(
  "device.status.changed",
  Schema.Struct({
    deviceID: DeviceID,
    previousStatus: DeviceStatus,
    currentStatus: DeviceStatus,
  }),
)

export const DeviceHeartbeat = BusEvent.define(
  "device.heartbeat",
  Schema.Struct({
    deviceID: DeviceID,
    timestamp: Schema.Number,
  }),
)

export const DeviceCommandExecuted = BusEvent.define(
  "device.command.executed",
  Schema.Struct({
    deviceID: DeviceID,
    command: Schema.String,
    exitCode: Schema.Number,
    duration: Schema.Number,
  }),
)
```

#### 3.1.6 设备发现器 (Device Discovery)

设备发现器负责自动检测本地连接的设备，通过调用平台工具（adb/hdc/idevice）获取设备列表并自动注册。

```typescript
// src/device/discovery.ts

import { Effect, Layer, Schedule, Context } from "effect"
import { Device } from "./device"
import { DevicePlatform } from "./schema"

export interface DiscoveryInterface {
  readonly start: () => Effect.Effect<void>
  readonly stop: () => Effect.Effect<void>
  readonly discoverAndroid: () => Effect.Effect<RawDeviceInfo[]>
  readonly discoverHarmonyOS: () => Effect.Effect<RawDeviceInfo[]>
  readonly discoverIOS: () => Effect.Effect<RawDeviceInfo[]>
}

export class Service extends Context.Service<Service, DiscoveryInterface>()(
  "@opencode/DeviceDiscovery",
) {}

interface RawDeviceInfo {
  serialNumber: string
  model: string
  manufacturer: string
  platformVersion: string
  name: string
  connectionType: "usb" | "wifi" | "tcp"
  connectionAddress?: string
}

// 实现策略：通过 shell 命令调用平台工具
// Android: adb devices -l → 解析输出
// HarmonyOS: hdc list targets → 解析输出
// iOS: idevice_id -l + ideviceinfo → 解析输出
```

#### 3.1.7 心跳监控

```typescript
// src/device/heartbeat.ts

import { Effect, Layer, Schedule, Context } from "effect"
import { Device } from "./device"
import { Bus } from "@/bus"
import { DeviceHeartbeat, DeviceStatusChanged } from "./events"

// 心跳超时阈值（毫秒）
const HEARTBEAT_TIMEOUT = 30_000
// 心跳检查间隔
const HEARTBEAT_CHECK_INTERVAL = 10_000

export interface HeartbeatMonitorInterface {
  readonly start: () => Effect.Effect<void>
  readonly stop: () => Effect.Effect<void>
  readonly checkAll: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, HeartbeatMonitorInterface>()(
  "@opencode/DeviceHeartbeatMonitor",
) {}
```

#### 3.1.8 HTTP API 路由

```typescript
// src/server/routes/instance/httpapi/groups/device.ts

import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { DeviceInfo, DeviceID, DevicePlatform, DeviceStatus } from "@/device/schema"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"

const root = "/device"

export const DeviceApi = HttpApi.make("device")
  .add(
    HttpApiGroup.make("device")
      .add(
        HttpApiEndpoint.get("list", root, {
          query: Schema.Struct({
            platform: Schema.optional(DevicePlatform),
            status: Schema.optional(DeviceStatus),
          }),
          success: Schema.Array(DeviceInfo),
        }),
      )
      .add(
        HttpApiEndpoint.get("get", `${root}/:deviceID`, {
          params: { deviceID: DeviceID },
          success: DeviceInfo,
          error: HttpApiError.NotFound,
        }),
      )
      .add(
        HttpApiEndpoint.post("register", `${root}/register`, {
          payload: DeviceRegisterPayload,
          success: DeviceInfo,
        }),
      )
      .add(
        HttpApiEndpoint.delete("unregister", `${root}/:deviceID`, {
          params: { deviceID: DeviceID },
          success: Schema.Boolean,
        }),
      )
      .add(
        HttpApiEndpoint.post("heartbeat", `${root}/:deviceID/heartbeat`, {
          params: { deviceID: DeviceID },
          success: Schema.Boolean,
        }),
      )
      .add(
        HttpApiEndpoint.post("command", `${root}/:deviceID/command`, {
          params: { deviceID: DeviceID },
          payload: DeviceCommandPayload,
          success: DeviceCommandResult,
        }),
      )
      .add(
        HttpApiEndpoint.get("events", `${root}/events`, {
          success: HttpApiSchema.Stream<{ type: string; data: unknown }>,
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(Authorization),
  )
```

#### 3.1.9 配置扩展

```jsonc
// opencode.json 配置扩展
{
  "device": {
    "enabled": true,
    "discovery": {
      "auto": true,
      "interval": 30000,
      "android": {
        "adbPath": "adb"
      },
      "harmonyos": {
        "hdcPath": "hdc"
      },
      "ios": {
        "idevicePath": "idevice_id"
      }
    },
    "heartbeat": {
      "timeout": 30000,
      "checkInterval": 10000
    }
  }
}
```

---

### 3.2 任务分配代理 (Dispatcher Agent)

#### 3.2.1 设计思路

将 OpenCode 的默认主代理从 `build`（编码执行型）切换为 `dispatcher`（任务分配型）。Dispatcher Agent 的核心职责是：

1. 接收上游下发的任务描述
2. 查询可用设备列表
3. 根据任务类型和设备能力进行任务-设备匹配
4. 为每台设备创建子 Agent Session 执行具体操作
5. 汇总子 Agent 执行结果并上报

#### 3.2.2 Agent 定义

```typescript
// 在 agent/agent.ts 的 agents 对象中新增

dispatcher: {
  name: "dispatcher",
  description: `Task dispatching agent. Receives upstream tasks, matches them to available devices, and spawns device-specific sub-agents for execution. Use this agent when operating in server mode to coordinate multi-device operations.`,
  mode: "primary",
  native: true,
  options: {},
  permission: Permission.merge(
    defaults,
    Permission.fromConfig({
      task: "allow",
      question: "allow",
      plan_enter: "allow",
    }),
    user,
  ),
  prompt: PROMPT_DISPATCHER,
}
```

#### 3.2.3 Dispatcher 系统提示词

```
// src/agent/prompt/dispatcher.txt

You are a task dispatching agent operating in server mode. Your role is to:

1. **Receive Tasks**: Accept task descriptions from upstream systems
2. **Query Devices**: Check available connected devices and their capabilities
3. **Plan Distribution**: Break down complex tasks into device-specific subtasks
4. **Dispatch Execution**: Assign subtasks to appropriate device sub-agents
5. **Monitor Progress**: Track sub-agent execution status
6. **Aggregate Results**: Collect and summarize results from all sub-agents

## Available Device Sub-Agents

- `android-operator`: Executes operations on Android devices (adb commands, UI automation, app management)
- `harmonyos-operator`: Executes operations on HarmonyOS devices (hdc commands, UI automation, app management)
- `ios-operator`: Executes operations on iOS devices (idevice commands, UI automation, app management)

## Task Dispatching Rules

1. Before dispatching, always check device availability using the device list
2. Match task requirements to device capabilities
3. Each device gets its own sub-agent session for isolation
4. Monitor sub-agent progress and handle failures gracefully
5. Aggregate all results before responding to the upstream task

## Response Format

When reporting results, include:
- Task summary
- Per-device execution status
- Any errors or warnings encountered
- Recommendations for follow-up actions
```

#### 3.2.4 设备操作子代理

```typescript
// 在 agent/agent.ts 的 agents 对象中新增

android_operator: {
  name: "android-operator",
  description: `Android device operation agent. Executes commands and UI operations on Android devices via adb. Handles app installation, UI automation, log collection, and system configuration.`,
  mode: "subagent",
  native: true,
  options: {},
  permission: Permission.merge(
    defaults,
    Permission.fromConfig({
      "*": "deny",
      bash: "allow",
      read: "allow",
      glob: "allow",
      grep: "allow",
      task: "allow",
    }),
    user,
  ),
  prompt: PROMPT_ANDROID_OPERATOR,
},

harmonyos_operator: {
  name: "harmonyos-operator",
  description: `HarmonyOS device operation agent. Executes commands and UI operations on HarmonyOS devices via hdc. Handles app installation, UI automation, log collection, and system configuration.`,
  mode: "subagent",
  native: true,
  options: {},
  permission: Permission.merge(
    defaults,
    Permission.fromConfig({
      "*": "deny",
      bash: "allow",
      read: "allow",
      glob: "allow",
      grep: "allow",
      task: "allow",
    }),
    user,
  ),
  prompt: PROMPT_HARMONYOS_OPERATOR,
},

ios_operator: {
  name: "ios-operator",
  description: `iOS device operation agent. Executes commands and UI operations on iOS devices via libimobiledevice. Handles app installation, UI automation, log collection, and system configuration.`,
  mode: "subagent",
  native: true,
  options: {},
  permission: Permission.merge(
    defaults,
    Permission.fromConfig({
      "*": "deny",
      bash: "allow",
      read: "allow",
      glob: "allow",
      grep: "allow",
      task: "allow",
    }),
    user,
  ),
  prompt: PROMPT_IOS_OPERATOR,
},
```

#### 3.2.5 设备操作工具 (Device Tool)

新增 `device_command` 工具，供设备操作子代理调用：

```typescript
// src/tool/device-command.ts

import * as Tool from "./tool"
import { Device } from "@/device/device"
import { DeviceID, DevicePlatform } from "@/device/schema"
import { Effect, Schema } from "effect"

export const Parameters = Schema.Struct({
  device_id: DeviceID.annotate({ description: "Target device ID" }),
  command: Schema.String.annotate({ description: "Command to execute on the device" }),
  args: Schema.Array(Schema.String).annotate({
    description: "Command arguments",
  }).pipe(Schema.optional),
  timeout: Schema.Number.annotate({
    description: "Timeout in milliseconds",
  }).pipe(Schema.optional),
})

export const DeviceCommandTool = Tool.define(
  "device_command",
  Effect.gen(function* () {
    const device = yield* Device.Service

    return {
      description: "Execute a command on a connected device",
      parameters: Parameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const result = yield* device.executeCommand({
            deviceID: params.device_id,
            command: params.command,
            args: params.args ?? [],
            timeout: params.timeout,
          })
          return {
            output: [
              `Device: ${params.device_id}`,
              `Command: ${params.command} ${(params.args ?? []).join(" ")}`,
              `Exit Code: ${result.exitCode}`,
              `Duration: ${result.duration}ms`,
              "--- stdout ---",
              result.stdout,
              result.exitCode !== 0 ? `--- stderr ---\n${result.stderr}` : "",
            ].join("\n"),
          }
        }),
    }
  }),
)
```

#### 3.2.6 任务分配流程

```
上游系统 → POST /session/:id/prompt_async
                │
                ▼
        Dispatcher Agent 接收任务
                │
                ├── 1. 调用 device list 查询可用设备
                │
                ├── 2. 分析任务，拆分为设备级子任务
                │
                ├── 3. 为每台设备创建子 Session
                │       │
                │       ├── Session A (android-operator)
                │       │     └── device_command → adb shell ...
                │       │
                │       ├── Session B (harmonyos-operator)
                │       │     └── device_command → hdc shell ...
                │       │
                │       └── Session C (ios-operator)
                │             └── device_command → idevice ...
                │
                └── 4. 汇总子 Agent 结果，返回上游
```

#### 3.2.7 配置扩展

```jsonc
// opencode.json
{
  "agent": {
    "dispatcher": {
      "mode": "primary",
      "model": "anthropic/claude-sonnet-4-20250514",
      "steps": 50
    },
    "android-operator": {
      "mode": "subagent",
      "model": "anthropic/claude-sonnet-4-20250514"
    },
    "harmonyos-operator": {
      "mode": "subagent",
      "model": "anthropic/claude-sonnet-4-20250514"
    },
    "ios-operator": {
      "mode": "subagent",
      "model": "anthropic/claude-sonnet-4-20250514"
    }
  },
  "default_agent": "dispatcher"
}
```

---

### 3.3 子 Agent 输出流分发 (Stream Distributor)

#### 3.3.1 设计思路

现有架构中，子 Agent 的输出流通过 Bus 事件发布，但所有事件混在同一个事件流中。需要实现：

1. **按 SessionID 过滤**：每个子 Agent Session 的事件可独立订阅
2. **按 DeviceID 关联**：将 Session 与 Device 绑定，支持按设备维度订阅
3. **多通道输出**：支持 WebSocket/SSE/Webhook 多种输出方式
4. **流隔离**：不同子 Agent 的输出流互不干扰

#### 3.3.2 数据模型

```typescript
// src/stream/schema.ts

import { Schema } from "effect"
import { SessionID } from "@/session/schema"
import { DeviceID } from "@/device/schema"

export const StreamChannelID = Schema.String.check(Schema.isStartsWith("ch_")).pipe(
  Schema.brand("StreamChannelID"),
)
export type StreamChannelID = Schema.Schema.Type<typeof StreamChannelID>

export const StreamChannel = Schema.Struct({
  id: StreamChannelID,
  sessionID: SessionID,
  deviceID: Schema.optional(DeviceID),
  name: Schema.String,
  outputType: Schema.Literals("websocket", "sse", "webhook"),
  outputConfig: Schema.Record(Schema.String, Schema.Unknown),
  filters: Schema.Struct({
    eventTypes: Schema.Array(Schema.String),
    minLevel: Schema.optional(Schema.Literals("debug", "info", "warn", "error")),
  }),
  active: Schema.Boolean,
  time: Schema.Struct({
    created: Schema.Number,
    lastEvent: Schema.optional(Schema.Number),
  }),
})
export type StreamChannel = Schema.Schema.Type<typeof StreamChannel>

export const StreamEvent = Schema.Struct({
  channelID: StreamChannelID,
  sessionID: SessionID,
  deviceID: Schema.optional(DeviceID),
  eventType: Schema.String,
  data: Schema.Unknown,
  timestamp: Schema.Number,
  sequence: Schema.Number,
})
export type StreamEvent = Schema.Schema.Type<typeof StreamEvent>
```

#### 3.3.3 Service 接口

```typescript
// src/stream/distributor.ts

import { Context, Effect, Layer, Stream, Schema } from "effect"
import { SessionID } from "@/session/schema"
import { DeviceID } from "@/device/schema"
import { StreamChannel, StreamChannelID, StreamEvent } from "./schema"

export interface Interface {
  readonly createChannel: (input: {
    sessionID: SessionID
    deviceID?: DeviceID
    name: string
    outputType: "websocket" | "sse" | "webhook"
    outputConfig: Record<string, unknown>
    filters?: { eventTypes?: string[]; minLevel?: string }
  }) => Effect.Effect<StreamChannel>

  readonly removeChannel: (channelID: StreamChannelID) => Effect.Effect<void>

  readonly listChannels: (filter?: {
    sessionID?: SessionID
    deviceID?: DeviceID
    active?: boolean
  }) => Effect.Effect<StreamChannel[]>

  readonly subscribe: (channelID: StreamChannelID) => Stream.Stream<StreamEvent>

  readonly subscribeBySession: (sessionID: SessionID) => Stream.Stream<StreamEvent>

  readonly subscribeByDevice: (deviceID: DeviceID) => Stream.Stream<StreamEvent>

  readonly publish: (event: {
    sessionID: SessionID
    deviceID?: DeviceID
    eventType: string
    data: unknown
  }) => Effect.Effect<void>

  readonly getChannelStats: (channelID: StreamChannelID) => Effect.Effect<{
    eventCount: number
    lastEventTime: number | null
    subscriberCount: number
  }>
}

export class Service extends Context.Service<Service, Interface>()(
  "@opencode/StreamDistributor",
) {}
```

#### 3.3.4 与现有 Bus 系统集成

Stream Distributor 通过订阅 Bus 的通配事件，将 Session 事件路由到对应的 Channel：

```typescript
// src/stream/distributor.ts (核心实现片段)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const channels = new Map<string, StreamChannel>()
    const channelPubSubs = new Map<string, PubSub.PubSub<StreamEvent>>()

    // 订阅所有 Bus 事件，路由到对应 Channel
    yield* bus.subscribeAllCallback((event) => {
      // 从事件类型中提取 sessionID
      const sessionID = extractSessionID(event)
      if (!sessionID) return

      // 查找匹配的 Channel
      for (const [id, channel] of channels) {
        if (channel.sessionID !== sessionID) continue
        if (!channel.active) continue
        if (channel.filters.eventTypes.length > 0 &&
            !channel.filters.eventTypes.includes(event.type)) continue

        const ps = channelPubSubs.get(id)
        if (ps) {
          const streamEvent: StreamEvent = {
            channelID: channel.id,
            sessionID,
            deviceID: channel.deviceID,
            eventType: event.type,
            data: event.properties,
            timestamp: Date.now(),
            sequence: nextSequence(),
          }
          Effect.runSync(PubSub.publish(ps, streamEvent))

          // Webhook 输出
          if (channel.outputType === "webhook") {
            yield* deliverWebhook(channel.outputConfig, streamEvent)
          }
        }
      }
    })

    // ... 其余实现
  }),
)
```

#### 3.3.5 Session-Device 绑定

在 Session 创建时建立与 Device 的绑定关系：

```typescript
// src/session/session.ts 扩展

// 在 Session.Info 中增加 deviceID 字段
export interface CreateInput {
  parentID?: SessionID
  title?: string
  agent?: string
  model?: { id: ModelID; providerID: ProviderID; variant?: string }
  permission?: Permission.Ruleset
  // 新增
  deviceID?: DeviceID
  taskMetadata?: Record<string, unknown>
}
```

#### 3.3.6 HTTP API 路由

```typescript
// src/server/routes/instance/httpapi/groups/stream.ts

const root = "/stream"

export const StreamApi = HttpApi.make("stream")
  .add(
    HttpApiGroup.make("stream")
      .add(
        // 创建输出通道
        HttpApiEndpoint.post("createChannel", `${root}/channel`, {
          payload: CreateChannelPayload,
          success: StreamChannel,
        }),
      )
      .add(
        // 删除输出通道
        HttpApiEndpoint.delete("removeChannel", `${root}/channel/:channelID`, {
          params: { channelID: StreamChannelID },
          success: Schema.Boolean,
        }),
      )
      .add(
        // 列出通道
        HttpApiEndpoint.get("listChannels", `${root}/channel`, {
          query: Schema.Struct({
            sessionID: Schema.optional(SessionID),
            deviceID: Schema.optional(DeviceID),
          }),
          success: Schema.Array(StreamChannel),
        }),
      )
      .add(
        // SSE 订阅特定通道
        HttpApiEndpoint.get("subscribe", `${root}/channel/:channelID/events`, {
          params: { channelID: StreamChannelID },
          success: HttpApiSchema.Stream<StreamEvent>,
        }),
      )
      .add(
        // SSE 订阅特定 Session 的所有事件
        HttpApiEndpoint.get("subscribeSession", `${root}/session/:sessionID/events`, {
          params: { sessionID: SessionID },
          success: HttpApiSchema.Stream<StreamEvent>,
        }),
      )
      .add(
        // SSE 订阅特定设备的所有事件
        HttpApiEndpoint.get("subscribeDevice", `${root}/device/:deviceID/events`, {
          params: { deviceID: DeviceID },
          success: HttpApiSchema.Stream<StreamEvent>,
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(Authorization),
  )
```

#### 3.3.7 Webhook 输出

```typescript
// src/stream/webhook.ts

import { Effect } from "effect"
import { StreamEvent, StreamChannel } from "./schema"

export interface WebhookConfig {
  url: string
  headers?: Record<string, string>
  retryCount?: number
  retryDelay?: number
  batchSize?: number
  secret?: string
}

export const deliverWebhook = Effect.fn("StreamDistributor.deliverWebhook")(
  function* (config: WebhookConfig, events: StreamEvent | StreamEvent[]) {
    const payload = Array.isArray(events) ? events : [events]
    const body = JSON.stringify({
      events: payload,
      timestamp: Date.now(),
    })

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...config.headers,
    }

    if (config.secret) {
      headers["X-Signature"] = computeHMAC(body, config.secret)
    }

    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(config.url, {
          method: "POST",
          headers,
          body,
        }),
      catch: (error) => new WebhookDeliveryError({ error: String(error) }),
    })

    if (!response.ok) {
      yield* new WebhookDeliveryError({
        error: `HTTP ${response.status}: ${response.statusText}`,
      })
    }
  },
)
```

---

### 3.4 运营打点模块 (Analytics Module)

#### 3.4.1 设计思路

运营打点模块采用**接口预留 + 插件化实现**的设计：

1. 定义统一的打点接口（`Analytics.Interface`）
2. 提供默认的 Noop 实现（不产生任何副作用）
3. 提供内置的文件日志实现（本地调试用）
4. 预留远程上报实现接口（由业务方自行实现）
5. 通过 Bus 事件自动采集关键指标

#### 3.4.2 数据模型

```typescript
// src/analytics/schema.ts

import { Schema } from "effect"
import { SessionID } from "@/session/schema"
import { DeviceID } from "@/device/schema"

export const AnalyticsEventName = Schema.Literals(
  "task.received",
  "task.dispatched",
  "task.completed",
  "task.failed",
  "device.registered",
  "device.unregistered",
  "device.offline",
  "device.command.executed",
  "device.command.failed",
  "agent.step.started",
  "agent.step.completed",
  "agent.step.failed",
  "agent.tool.called",
  "agent.tool.completed",
  "agent.tool.failed",
  "stream.channel.created",
  "stream.event.delivered",
  "server.started",
  "server.error",
)
export type AnalyticsEventName = Schema.Schema.Type<typeof AnalyticsEventName>

export const AnalyticsEvent = Schema.Struct({
  id: Schema.String,
  name: AnalyticsEventName,
  timestamp: Schema.Number,
  properties: Schema.Record(Schema.String, Schema.Unknown),
  metrics: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  sessionID: Schema.optional(SessionID),
  deviceID: Schema.optional(DeviceID),
  traceID: Schema.optional(Schema.String),
  spanID: Schema.optional(Schema.String),
})
export type AnalyticsEvent = Schema.Schema.Type<typeof AnalyticsEvent>

export const AnalyticsConfig = Schema.Struct({
  enabled: Schema.Boolean,
  provider: Schema.Literals("noop", "file", "remote", "custom"),
  providerConfig: Schema.Record(Schema.String, Schema.Unknown),
  sampling: Schema.Struct({
    rate: Schema.Finite,
    includeDebug: Schema.Boolean,
  }),
  batch: Schema.Struct({
    enabled: Schema.Boolean,
    maxSize: Schema.Finite,
    flushInterval: Schema.Finite,
  }),
  privacy: Schema.Struct({
    maskSessionContent: Schema.Boolean,
    maskDeviceSerial: Schema.Boolean,
    excludedEvents: Schema.Array(Schema.String),
  }),
})
export type AnalyticsConfig = Schema.Schema.Type<typeof AnalyticsConfig>
```

#### 3.4.3 Service 接口

```typescript
// src/analytics/analytics.ts

import { Context, Effect, Layer, Schema } from "effect"
import { AnalyticsEvent, AnalyticsEventName, AnalyticsConfig } from "./schema"
import { SessionID } from "@/session/schema"
import { DeviceID } from "@/device/schema"

export interface Interface {
  readonly track: (input: {
    name: AnalyticsEventName
    properties?: Record<string, unknown>
    metrics?: Record<string, number>
    sessionID?: SessionID
    deviceID?: DeviceID
    traceID?: string
  }) => Effect.Effect<void>

  readonly trackPage: (input: {
    name: string
    startTime: number
    endTime: number
    properties?: Record<string, unknown>
    sessionID?: SessionID
    deviceID?: DeviceID
  }) => Effect.Effect<void>

  readonly flush: () => Effect.Effect<void>

  readonly setGlobalProperties: (properties: Record<string, unknown>) => Effect.Effect<void>

  readonly setUserID: (userID: string) => Effect.Effect<void>

  readonly getConfig: () => Effect.Effect<AnalyticsConfig>
}

export class Service extends Context.Service<Service, Interface>()(
  "@opencode/Analytics",
) {}
```

#### 3.4.4 Provider 接口（插件化）

```typescript
// src/analytics/provider.ts

import { Effect, Context, Schema } from "effect"
import { AnalyticsEvent } from "./schema"

export interface ProviderInterface {
  readonly initialize: (config: Record<string, unknown>) => Effect.Effect<void>
  readonly track: (event: AnalyticsEvent) => Effect.Effect<void>
  readonly flush: () => Effect.Effect<void>
  readonly shutdown: () => Effect.Effect<void>
}

export class ProviderService extends Context.Service<ProviderService, ProviderInterface>()(
  "@opencode/AnalyticsProvider",
) {}

// ---- Noop 实现 ----
export const NoopProvider = Layer.succeed(
  ProviderService,
  ProviderService.of({
    initialize: () => Effect.void,
    track: () => Effect.void,
    flush: () => Effect.void,
    shutdown: () => Effect.void,
  }),
)

// ---- 文件日志实现 ----
export const FileProvider = Layer.effect(
  ProviderService,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const logPath = path.join(Global.Path.data, "analytics.jsonl")

    return ProviderService.of({
      initialize: () => Effect.void,
      track: (event) =>
        Effect.gen(function* () {
          const line = JSON.stringify(event) + "\n"
          yield* fs.appendFile(logPath, line)
        }),
      flush: () => Effect.void,
      shutdown: () => Effect.void,
    })
  }),
)

// ---- 远程上报实现接口 ----
export interface RemoteProviderConfig {
  endpoint: string
  headers?: Record<string, string>
  batchSize: number
  flushInterval: number
  retryConfig: {
    maxRetries: number
    initialDelay: number
    maxDelay: number
  }
}

export const RemoteProvider = Layer.effect(
  ProviderService,
  Effect.gen(function* () {
    // 实现由业务方提供
    // 框架仅定义接口规范
    return ProviderService.of({
      initialize: () => Effect.void,
      track: (event) => Effect.void,
      flush: () => Effect.void,
      shutdown: () => Effect.void,
    })
  }),
)
```

#### 3.4.5 自动事件采集

通过 Bus 订阅自动采集关键事件并转换为打点数据：

```typescript
// src/analytics/collector.ts

import { Effect, Layer } from "effect"
import { Bus } from "@/bus"
import { Analytics } from "./analytics"
import { DeviceRegistered, DeviceStatusChanged, DeviceCommandExecuted } from "@/device/events"
import { SessionEvent } from "@/v2/session-event"

export const AutoCollector = Layer.effect(
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const analytics = yield* Analytics.Service

    // 采集设备事件
    yield* bus.subscribeCallback(DeviceRegistered, (event) => {
      analytics.track({
        name: "device.registered",
        properties: {
          deviceID: event.properties.deviceID,
          platform: event.properties.platform,
        },
      })
    })

    yield* bus.subscribeCallback(DeviceStatusChanged, (event) => {
      const status = event.properties.currentStatus
      analytics.track({
        name: status === "offline" ? "device.offline" : "device.registered",
        properties: {
          deviceID: event.properties.deviceID,
          previousStatus: event.properties.previousStatus,
          currentStatus: event.properties.currentStatus,
        },
      })
    })

    yield* bus.subscribeCallback(DeviceCommandExecuted, (event) => {
      analytics.track({
        name: event.properties.exitCode === 0
          ? "device.command.executed"
          : "device.command.failed",
        properties: {
          deviceID: event.properties.deviceID,
          command: event.properties.command,
        },
        metrics: {
          exitCode: event.properties.exitCode,
          duration: event.properties.duration,
        },
      })
    })

    // 采集 Agent 步骤事件
    yield* bus.subscribeCallback(SessionEvent.Step.Started, (event) => {
      analytics.track({
        name: "agent.step.started",
        properties: {
          agent: event.properties.agent,
        },
        sessionID: event.properties.sessionID,
      })
    })

    yield* bus.subscribeCallback(SessionEvent.Step.Ended, (event) => {
      analytics.track({
        name: "agent.step.completed",
        sessionID: event.properties.sessionID,
        metrics: {
          cost: event.properties.cost,
          tokensInput: event.properties.tokens.input,
          tokensOutput: event.properties.tokens.output,
        },
      })
    })

    yield* bus.subscribeCallback(SessionEvent.Step.Failed, (event) => {
      analytics.track({
        name: "agent.step.failed",
        sessionID: event.properties.sessionID,
        properties: {
          error: event.properties.error,
        },
      })
    })

    // 采集工具调用事件
    yield* bus.subscribeCallback(SessionEvent.Tool.Called, (event) => {
      analytics.track({
        name: "agent.tool.called",
        sessionID: event.properties.sessionID,
        properties: {
          tool: event.properties.tool,
          callID: event.properties.callID,
        },
      })
    })
  }),
)
```

#### 3.4.6 配置扩展

```jsonc
// opencode.json
{
  "analytics": {
    "enabled": true,
    "provider": "noop",
    "providerConfig": {},
    "sampling": {
      "rate": 1.0,
      "includeDebug": false
    },
    "batch": {
      "enabled": true,
      "maxSize": 100,
      "flushInterval": 5000
    },
    "privacy": {
      "maskSessionContent": true,
      "maskDeviceSerial": true,
      "excludedEvents": []
    }
  }
}
```

#### 3.4.7 HTTP API 路由

```typescript
// src/server/routes/instance/httpapi/groups/analytics.ts

const root = "/analytics"

export const AnalyticsApi = HttpApi.make("analytics")
  .add(
    HttpApiGroup.make("analytics")
      .add(
        // 手动上报事件
        HttpApiEndpoint.post("track", `${root}/track`, {
          payload: TrackPayload,
          success: Schema.Boolean,
        }),
      )
      .add(
        // 获取打点配置
        HttpApiEndpoint.get("config", `${root}/config`, {
          success: AnalyticsConfig,
        }),
      )
      .add(
        // 强制刷新缓冲区
        HttpApiEndpoint.post("flush", `${root}/flush`, {
          success: Schema.Boolean,
        }),
      )
      .middleware(Authorization),
  )
```

---

## 四、集成与启动流程

### 4.1 Server 模式启动

新增 `opencode serve --mode device-server` 启动模式：

```typescript
// src/cli/cmd/serve.ts 扩展

import { Device } from "@/device/device"
import { DeviceDiscovery } from "@/device/discovery"
import { StreamDistributor } from "@/stream/distributor"
import { Analytics } from "@/analytics/analytics"
import { AutoCollector } from "@/analytics/collector"

// Server 模式的 Layer 组装
const DeviceServerLayer = Layer.mergeAll(
  Device.defaultLayer,
  DeviceDiscovery.defaultLayer,
  StreamDistributor.defaultLayer,
  Analytics.defaultLayer,
  AutoCollector,
).pipe(
  Layer.provide(/* 现有依赖层 */),
)
```

### 4.2 完整 Layer 依赖图

```
DeviceServerLayer
├── Device.Layer
│   ├── Bus.Layer
│   ├── SyncEvent.Layer
│   ├── Storage.Layer
│   └── Config.Layer
├── DeviceDiscovery.Layer
│   ├── Device.Layer
│   └── Shell.Layer
├── StreamDistributor.Layer
│   ├── Bus.Layer
│   └── Session.Layer
├── Analytics.Layer
│   ├── AnalyticsProvider.Layer (noop/file/remote)
│   └── Config.Layer
└── AutoCollector.Layer
    ├── Bus.Layer
    └── Analytics.Layer
```

### 4.3 API 路由注册

```typescript
// src/server/routes/instance/httpapi/api.ts 扩展

import { DeviceApi } from "./groups/device"
import { StreamApi } from "./groups/stream"
import { AnalyticsApi } from "./groups/analytics"

export const InstanceHttpApi = HttpApi.make("opencode-instance")
  // ... 现有路由
  .addHttpApi(DeviceApi)      // 新增
  .addHttpApi(StreamApi)      // 新增
  .addHttpApi(AnalyticsApi)   // 新增
  .middleware(SchemaErrorMiddleware)
```

### 4.4 配置合并

```typescript
// src/config/config.ts 扩展

export interface Info {
  // ... 现有字段
  device?: {
    enabled: boolean
    discovery: {
      auto: boolean
      interval: number
      android: { adbPath: string }
      harmonyos: { hdcPath: string }
      ios: { idevicePath: string }
    }
    heartbeat: {
      timeout: number
      checkInterval: number
    }
  }
  analytics?: {
    enabled: boolean
    provider: "noop" | "file" | "remote" | "custom"
    providerConfig: Record<string, unknown>
    sampling: { rate: number; includeDebug: boolean }
    batch: { enabled: boolean; maxSize: number; flushInterval: number }
    privacy: {
      maskSessionContent: boolean
      maskDeviceSerial: boolean
      excludedEvents: string[]
    }
  }
  stream?: {
    maxChannelsPerSession: number
    webhookTimeout: number
    sseKeepaliveInterval: number
  }
}
```

---

## 五、API 接口总览

### 5.1 设备管理 API

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/device` | 列出设备（支持 platform/status 过滤） |
| GET | `/device/:deviceID` | 获取设备详情 |
| POST | `/device/register` | 注册设备 |
| DELETE | `/device/:deviceID` | 注销设备 |
| POST | `/device/:deviceID/heartbeat` | 设备心跳 |
| POST | `/device/:deviceID/command` | 执行设备命令 |
| GET | `/device/events` | SSE 订阅设备事件流 |

### 5.2 流分发 API

| 方法 | 路径 | 描述 |
|------|------|------|
| POST | `/stream/channel` | 创建输出通道 |
| DELETE | `/stream/channel/:channelID` | 删除输出通道 |
| GET | `/stream/channel` | 列出通道 |
| GET | `/stream/channel/:channelID/events` | SSE 订阅通道事件 |
| GET | `/stream/session/:sessionID/events` | SSE 订阅 Session 事件 |
| GET | `/stream/device/:deviceID/events` | SSE 订阅设备事件 |

### 5.3 运营打点 API

| 方法 | 路径 | 描述 |
|------|------|------|
| POST | `/analytics/track` | 手动上报事件 |
| GET | `/analytics/config` | 获取打点配置 |
| POST | `/analytics/flush` | 强制刷新缓冲区 |

### 5.4 现有 Session API（复用）

| 方法 | 路径 | 描述 |
|------|------|------|
| POST | `/session/:sessionID/prompt_async` | 异步下发任务 |
| GET | `/session/:sessionID/message` | 获取会话消息 |
| POST | `/session/:sessionID/abort` | 中止会话 |
| GET | `/session` | 列出会话 |

---

## 六、数据流全景

```
上游系统
  │
  │ 1. POST /session (创建 dispatcher session)
  │ 2. POST /session/:id/prompt_async { prompt: "在所有设备上安装App v2.0" }
  │
  ▼
Dispatcher Agent
  │
  │ 3. 内部推理：分析任务 → 查询设备 → 规划子任务
  │
  ├── TaskTool → android-operator (Session A, Device D1)
  │     │
  │     │ 4a. device_command(D1, "adb install app.apk")
  │     │     → Device.executeCommand()
  │     │     → Bus.publish(DeviceCommandExecuted)
  │     │     → Analytics.track("device.command.executed")
  │     │
  │     └── Stream: Session A events → StreamDistributor → SSE/Webhook
  │
  ├── TaskTool → harmonyos-operator (Session B, Device D2)
  │     │
  │     │ 4b. device_command(D2, "hdc install app.hap")
  │     │     → Device.executeCommand()
  │     │     → Bus.publish(DeviceCommandExecuted)
  │     │     → Analytics.track("device.command.executed")
  │     │
  │     └── Stream: Session B events → StreamDistributor → SSE/Webhook
  │
  └── 5. 汇总结果 → 返回上游
        │
        └── Analytics.track("task.completed", { deviceCount, successCount, failCount })
```

---

## 七、文件变更清单

### 7.1 新增文件

```
src/device/
├── schema.ts              # 设备数据模型
├── device.ts              # Device Service 实现
├── device.sql.ts          # 数据库表定义
├── discovery.ts           # 设备自动发现
├── heartbeat.ts           # 心跳监控
├── events.ts              # Bus 事件定义
└── index.ts               # 模块导出

src/stream/
├── schema.ts              # 流通道数据模型
├── distributor.ts         # StreamDistributor Service 实现
├── webhook.ts             # Webhook 输出实现
└── index.ts               # 模块导出

src/analytics/
├── schema.ts              # 打点数据模型
├── analytics.ts           # Analytics Service 实现
├── provider.ts            # Provider 接口与实现
├── collector.ts           # 自动事件采集
└── index.ts               # 模块导出

src/tool/
└── device-command.ts      # 设备命令工具

src/agent/prompt/
├── dispatcher.txt         # Dispatcher Agent 系统提示词
├── android-operator.txt   # Android 操作 Agent 提示词
├── harmonyos-operator.txt # HarmonyOS 操作 Agent 提示词
└── ios-operator.txt       # iOS 操作 Agent 提示词

src/server/routes/instance/httpapi/groups/
├── device.ts              # 设备管理 API 路由定义
├── stream.ts              # 流分发 API 路由定义
└── analytics.ts           # 打点 API 路由定义

src/server/routes/instance/httpapi/handlers/
├── device.ts              # 设备管理 API 处理器
├── stream.ts              # 流分发 API 处理器
└── analytics.ts           # 打点 API 处理器

migration/
└── XXXXX_add_device_tables/
    ├── migration.sql       # 数据库迁移
    └── snapshot.json       # 迁移快照
```

### 7.2 修改文件

| 文件 | 修改内容 |
|------|---------|
| `src/agent/agent.ts` | 新增 dispatcher/android-operator/harmonyos-operator/ios-operator Agent 定义 |
| `src/tool/registry.ts` | 注册 device_command 工具 |
| `src/session/session.ts` | Session.CreateInput 增加 deviceID/taskMetadata 字段 |
| `src/session/schema.ts` | Session 表增加 device_id 列 |
| `src/session/session.sql.ts` | 数据库表增加 device_id 字段 |
| `src/server/routes/instance/httpapi/api.ts` | 注册 Device/Stream/Analytics API 路由组 |
| `src/server/routes/instance/httpapi/server.ts` | 组装新 Layer |
| `src/config/config.ts` | 增加 device/analytics/stream 配置项 |
| `src/cli/cmd/serve.ts` | 增加 device-server 模式启动逻辑 |
| `src/tool/task.ts` | TaskTool 执行时传递 deviceID 上下文 |

---

## 八、实施路线图

### Phase 1：设备管理基础（1-2 周）

1. 实现 Device 数据模型和数据库迁移
2. 实现 Device Service（注册/查询/心跳）
3. 实现设备发现器（Android adb / HarmonyOS hdc / iOS idevice）
4. 实现心跳监控
5. 实现 Device HTTP API
6. 编写单元测试

### Phase 2：任务分配代理（1-2 周）

1. 编写 Dispatcher/设备操作 Agent 提示词
2. 在 agent.ts 中注册新 Agent
3. 实现 device_command 工具
4. 修改 Session 支持设备绑定
5. 修改 TaskTool 传递设备上下文
6. 端到端集成测试

### Phase 3：输出流分发（1 周）

1. 实现 StreamChannel 数据模型
2. 实现 StreamDistributor Service
3. 实现 SSE/WebSocket 输出
4. 实现 Webhook 输出
5. 实现 Stream HTTP API
6. 测试流隔离和并发

### Phase 4：运营打点（1 周）

1. 实现 Analytics 数据模型和 Service
2. 实现 Provider 接口（Noop/File）
3. 实现 AutoCollector 自动采集
4. 实现 Analytics HTTP API
5. 编写远程 Provider 接入文档
6. 测试打点采集完整性

### Phase 5：集成与优化（1 周）

1. Server 模式启动流程完善
2. 配置系统整合
3. 错误处理与恢复
4. 性能优化（批量打点、流控）
5. 文档编写
6. 全链路压测

---

## 九、风险与注意事项

### 9.1 技术风险

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 设备工具链依赖（adb/hdc/idevice） | 设备发现和命令执行依赖外部工具 | 提供手动注册 API 作为降级方案；工具检测与健康检查 |
| 子 Agent 并发资源消耗 | 多设备同时操作可能消耗大量 LLM Token | 限制并发子 Agent 数量；配置 steps 上限；Token 预算控制 |
| 流分发性能 | 大量子 Agent 同时输出可能造成 Bus 压力 | 背压控制；批量合并；按需订阅 |
| 数据库迁移兼容性 | 新增表/字段需兼容现有数据 | 使用 Drizzle 迁移；字段默认值；渐进式迁移 |

### 9.2 安全注意事项

1. **设备命令执行**：device_command 工具需要严格权限控制，防止任意命令注入
2. **Webhook 签名**：所有 Webhook 输出必须支持 HMAC 签名验证
3. **设备序列号脱敏**：打点数据中默认脱敏设备序列号
4. **Session 内容脱敏**：打点数据中默认脱敏 Session 内容
5. **API 鉴权**：所有新增 API 必须经过 Authorization 中间件

### 9.3 向后兼容

1. 所有新功能通过配置开关控制（`device.enabled`, `analytics.enabled`）
2. 默认 Agent 仍为 `build`，仅当配置 `default_agent: "dispatcher"` 时切换
3. 现有 CLI/TUI 模式不受影响
4. 数据库迁移为增量式，不修改现有表结构
