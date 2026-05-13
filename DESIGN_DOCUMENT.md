# OpenCode 二次开发设计文档：安卓设备管理 & 任务分配代理

> 版本：1.0  
> 日期：2026-05-13  
> 目标：将 opencode 改造为可承接上游任务的服务端，新增安卓设备管理模块与任务分配代理系统

---

## 目录

- [一、现有架构分析](#一现有架构分析)
  - [1.1 项目总体结构](#11-项目总体结构)
  - [1.2 核心架构模式](#12-核心架构模式)
  - [1.3 扩展点分析](#13-扩展点分析)
- [二、需求分析](#二需求分析)
  - [2.1 功能需求](#21-功能需求)
  - [2.2 非功能需求](#22-非功能需求)
- [三、详细设计](#三详细设计)
  - [3.1 整体架构](#31-整体架构)
  - [3.2 模块一：安卓设备管理](#32-模块一安卓设备管理devicemanager)
  - [3.3 模块二：任务分配代理](#33-模块二任务分配代理dispatcher-agent)
  - [3.4 配置扩展](#34-配置扩展)
  - [3.5 默认代理切换](#35-默认代理切换)
  - [3.6 上游任务接入 API](#36-上游任务接入-api)
- [四、文件变更清单](#四文件变更清单)
  - [4.1 新增文件](#41-新增文件)
  - [4.2 修改文件](#42-修改文件)
- [五、关键设计决策](#五关键设计决策)
- [六、实施路线图](#六实施路线图)
- [七、风险与缓解](#七风险与缓解)
- [附录A：核心源码引用](#附录a核心源码引用)
- [附录B：数据流图](#附录b数据流图)

---

## 一、现有架构分析

### 1.1 项目总体结构

opencode 是一个基于 TypeScript + Effect 框架的 AI 编码助手，采用 monorepo 结构（bun workspace + turbo），核心代码位于 `packages/opencode/src/`。

关键模块目录：

| 模块 | 路径 | 职责 |
|------|------|------|
| Agent | `src/agent/agent.ts` | 代理定义、注册、权限管理 |
| Session | `src/session/session.ts` | 会话生命周期管理 |
| Tool | `src/tool/tool.ts` | 工具接口定义 |
| ToolRegistry | `src/tool/registry.ts` | 工具注册与发现 |
| TaskTool | `src/tool/task.ts` | 子代理委派工具 |
| Server | `src/server/server.ts` | HTTP API + WebSocket 服务 |
| ACP | `src/acp/agent.ts` | Agent Client Protocol 适配层 |
| Config | `src/config/config.ts` | 配置加载与合并 |
| Bus | `src/bus/index.ts` | 事件总线 |
| Plugin | `src/plugin/index.ts` | 插件系统 |
| LLM | `src/session/llm.ts` | LLM 流式调用 |
| Prompt | `src/session/prompt.ts` | 会话提示处理 |
| Permission | `src/permission/index.ts` | 权限评估 |
| Shell | `src/shell/shell.ts` | Shell 命令执行 |
| Storage | `src/storage/storage.ts` | 持久化存储 |
| SyncEvent | `src/sync/index.ts` | 同步事件系统 |

### 1.2 核心架构模式

#### 1.2.1 Effect 依赖注入体系

opencode 大量使用 Effect 框架的 `Context` / `Layer` 模式实现依赖注入。每个核心模块都定义了 `Interface` + `Service` + `layer` 三件套：

```typescript
// 通用模式（以 Agent 为例）
export interface Interface {
  readonly get: (agent: string) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Info[]>
  readonly defaultInfo: () => Effect.Effect<Info>
  readonly defaultAgent: () => Effect.Effect<string>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Agent") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 注入依赖
    const config = yield* Config.Service
    const auth = yield* Auth.Service
    const plugin = yield* Plugin.Service
    // ...
    return Service.of({ get, list, defaultInfo, defaultAgent })
  }),
)
```

Layer 之间通过 `Layer.provide` 组合，形成依赖图。`InstanceState` 用于管理实例级别的状态，确保每个项目实例拥有独立的代理/工具配置。

#### 1.2.2 Agent 系统

Agent 定义在 `src/agent/agent.ts` 中，核心数据结构为 `Info`：

```typescript
export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  mode: Schema.Literals(["subagent", "primary", "all"]),
  native: Schema.optional(Schema.Boolean),
  hidden: Schema.optional(Schema.Boolean),
  topP: Schema.optional(Schema.Finite),
  temperature: Schema.optional(Schema.Finite),
  color: Schema.optional(Schema.String),
  permission: Permission.Ruleset,
  model: Schema.optional(Schema.Struct({
    modelID: ModelID,
    providerID: ProviderID,
  })),
  variant: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  options: Schema.Record(Schema.String, Schema.Unknown),
  steps: Schema.optional(Schema.Finite),
})
```

内置代理：

| 代理名 | 模式 | 说明 |
|--------|------|------|
| `build` | primary | 默认代理，拥有完整工具权限 |
| `plan` | primary | 计划模式，禁止编辑工具 |
| `general` | subagent | 通用子代理，执行多步骤任务 |
| `explore` | subagent | 代码探索子代理，只读操作 |
| `scout` | subagent | 文档与依赖源码研究（实验性） |
| `compaction` | primary (hidden) | 上下文压缩 |
| `title` | primary (hidden) | 会话标题生成 |
| `summary` | primary (hidden) | 会话摘要生成 |

代理可通过以下方式扩展：
1. `opencode.json` 中的 `agent` 字段
2. `.opencode/agent/*.md` 或 `.opencode/agents/*.md` Markdown 文件（frontmatter + 正文作为 prompt）

#### 1.2.3 Task 工具 —— 子代理委派机制

`src/tool/task.ts` 是子代理委派的核心。当主代理调用 `task` 工具时：

1. 根据 `subagent_type` 参数查找对应 Agent 定义
2. 创建子 Session（`parentID` 指向父 Session）
3. 通过 `deriveSubagentSessionPermission()` 合并权限（继承父代理的 deny 规则 + 父 Session 的 deny 和 external_directory 规则 + 默认禁止 todowrite/task）
4. 调用 `ops.prompt()` 将任务发送到子 Session 执行
5. 子代理完成后返回结果（提取最后一段文本作为 `task_result`）

关键参数：
```typescript
export const Parameters = Schema.Struct({
  description: Schema.String,    // 3-5词任务描述
  prompt: Schema.String,         // 给子代理的任务内容
  subagent_type: Schema.String,  // 子代理类型名
  task_id: Schema.optional(Schema.String), // 恢复已有任务
  command: Schema.optional(Schema.String), // 触发命令
})
```

#### 1.2.4 事件驱动架构

系统通过 Bus 和 SyncEvent 实现事件驱动：

- **BusEvent**：进程内即时事件，用于组件间实时通信
- **SyncEvent**：持久化事件，写入数据库并通过 WebSocket 同步到客户端

Session 的创建、更新、删除等都通过事件发布/订阅机制传播。Server 端通过 SSE/WebSocket 将事件推送到客户端。

```typescript
// 事件定义示例
export const Event = {
  Created: SyncEvent.define({
    type: "session.created",
    version: 1,
    aggregate: "sessionID",
    schema: CreatedEventSchema,
  }),
  Updated: SyncEvent.define({
    type: "session.updated",
    version: 1,
    aggregate: "sessionID",
    schema: UpdatedEventSchema,
  }),
  // ...
}
```

#### 1.2.5 HTTP API 服务

Server 基于 Effect 的 `HttpApiBuilder` 构建，采用分层路由结构：

```
RootHttpApi (全局)
  ├── /api/global/*           → 全局操作（认证、项目列表、事件流）
  └── InstanceHttpApi (项目级)
       ├── /api/instance/session/*    → 会话管理
       ├── /api/instance/file/*       → 文件操作
       ├── /api/instance/mcp/*        → MCP 管理
       ├── /api/instance/permission/* → 权限管理
       ├── /api/instance/pty/*        → 终端
       ├── /api/instance/v2/*         → V2 API
       └── ...
```

中间件层：
- `authorization` → 认证校验
- `instanceContext` → 项目实例上下文注入
- `workspaceRouting` → 工作区路由
- `compression` → 响应压缩
- `cors` → 跨域处理
- `fence` → 并发请求限制
- `error` → 错误处理

#### 1.2.6 ACP 适配层

`src/acp/agent.ts` 实现了 Agent Client Protocol（`@agentclientprotocol/sdk`），允许外部 IDE（VSCode、Cursor 等）通过标准化协议与 opencode 交互。它封装了：
- 会话管理（newSession / loadSession / resumeSession / closeSession）
- 权限请求（requestPermission）
- 事件流订阅（sessionUpdate）
- 模型/模式切换（setSessionModel / setSessionMode）

### 1.3 扩展点分析

| 扩展点 | 机制 | 关键文件 |
|--------|------|---------|
| 新增 Agent | 配置文件 + Agent.Service 注册 | `src/agent/agent.ts`, `src/config/agent.ts` |
| 新增 Tool | `Tool.define()` + Registry 注册 | `src/tool/tool.ts`, `src/tool/registry.ts` |
| 新增 HTTP 路由 | HttpApi Group + Handler | `src/server/routes/instance/httpapi/` |
| 新增事件 | `BusEvent.define` / `SyncEvent.define` | `src/bus/bus-event.ts`, `src/sync/index.ts` |
| 新增插件 | Plugin 系统 | `src/plugin/index.ts`, `src/plugin/loader.ts` |
| 新增配置 | Config 模块扩展 | `src/config/config.ts` |
| 新增 Effect Service | Interface + Service + Layer | 遵循现有模式 |

---

## 二、需求分析

### 2.1 功能需求

**需求1：安卓设备管理模块**
- 自动检测本地通过 ADB 连接的安卓设备
- 上报设备状态（online / offline / unauthorized / recovery / bootloader / disconnected）
- 提供设备信息查询 API（序列号、型号、Android 版本、SDK 版本、IP 地址等）
- 设备状态变更实时通知（通过 SSE / WebSocket）
- 支持手动刷新设备列表

**需求2：任务分配代理**
- 主代理切换为"任务分配器"（Dispatcher）角色
- 能够给单台设备分配子 Agent 执行设备操作任务
- 子 Agent 需具备安卓设备操作能力（执行 Shell 命令、安装应用、推送/拉取文件、截图等）
- 支持多设备并行任务执行
- 支持任务状态查询和结果汇总

### 2.2 非功能需求

- **最小侵入性**：尽量通过新增文件实现功能，减少对现有代码的修改
- **架构一致性**：遵循 Effect 依赖注入、事件驱动、配置合并等现有模式
- **可扩展性**：设备管理模块应支持未来扩展（如 iOS 设备、远程设备）
- **安全性**：ADB 操作需经过参数校验和权限控制
- **兼容性**：保持与 ACP 协议的兼容性，现有客户端不受影响
- **可靠性**：设备离线时优雅降级，任务部分失败时提供详细错误信息

---

## 三、详细设计

### 3.1 整体架构

```
┌───────────────────────────────────────────────────────────────┐
│                      上游任务系统                              │
│                (通过 HTTP API 提交任务)                        │
└─────────────────────────┬─────────────────────────────────────┘
                          │
                          ▼
┌───────────────────────────────────────────────────────────────┐
│                OpenCode Server (扩展后)                        │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐     │
│  │            Dispatcher Agent (主代理)                   │     │
│  │  - 接收上游任务描述                                     │     │
│  │  - 查询可用设备 (device_list 工具)                     │     │
│  │  - 为每台设备分配子 Agent (task 工具)                   │     │
│  │  - 汇总执行结果                                        │     │
│  └─────────────┬────────────────────────────────────────┘     │
│                │ task tool (subagent_type="device-operator")   │
│                ▼                                               │
│  ┌──────────────────────┐  ┌──────────────────────┐          │
│  │ Device Agent (设备A)  │  │ Device Agent (设备B)  │          │
│  │ - adb_shell          │  │ - adb_shell          │          │
│  │ - adb_install        │  │ - adb_install        │          │
│  │ - adb_push / pull    │  │ - adb_push / pull    │          │
│  │ - adb_screenshot     │  │ - adb_screenshot     │          │
│  └──────────────────────┘  └──────────────────────┘          │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐     │
│  │           Device Manager (设备管理模块)                │     │
│  │  - ADB 设备发现与监控 (轮询 adb devices)              │     │
│  │  - 设备状态管理 (在线/离线/未授权)                     │     │
│  │  - 设备信息上报 (型号/版本/IP)                        │     │
│  │  - 事件通知 (Bus → SSE/WebSocket)                    │     │
│  └──────────────────────────────────────────────────────┘     │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐     │
│  │              HTTP API 层                               │     │
│  │  /api/instance/device/*        → 设备管理 API         │     │
│  │  /api/instance/task/dispatch   → 任务分配 API         │     │
│  │  /api/instance/task/:id/status → 任务状态查询         │     │
│  └──────────────────────────────────────────────────────┘     │
└───────────────────────────────────────────────────────────────┘
```

### 3.2 模块一：安卓设备管理（DeviceManager）

#### 3.2.1 数据模型

**新增文件：`src/device/schema.ts`**

```typescript
import { Schema } from "effect"

export const DeviceID = Schema.String.pipe(Schema.brand("DeviceID"))
export type DeviceID = Schema.Schema.Type<typeof DeviceID>

export const DeviceStatus = Schema.Literals([
  "online",       // 设备在线可用
  "offline",      // 设备离线
  "unauthorized", // 设备未授权调试
  "recovery",     // 设备处于恢复模式
  "bootloader",   // 设备处于 bootloader 模式
  "disconnected", // 设备已断开连接
])

export const DeviceInfo = Schema.Struct({
  id: DeviceID,
  serial: Schema.String,
  model: Schema.optional(Schema.String),
  product: Schema.optional(Schema.String),
  device: Schema.optional(Schema.String),
  transportId: Schema.optional(Schema.String),
  status: DeviceStatus,
  androidVersion: Schema.optional(Schema.String),
  sdkVersion: Schema.optional(Schema.String),
  ipAddress: Schema.optional(Schema.String),
  lastSeen: Schema.Number,
}).annotate({ identifier: "DeviceInfo" })
export type DeviceInfo = Schema.Schema.Type<typeof DeviceInfo>

export const DeviceChangeType = Schema.Literals([
  "connected",
  "disconnected",
  "status_changed",
])

export const DeviceChangeEvent = Schema.Struct({
  type: DeviceChangeType,
  device: DeviceInfo,
  previousStatus: Schema.optional(DeviceStatus),
}).annotate({ identifier: "DeviceChangeEvent" })
export type DeviceChangeEvent = Schema.Schema.Type<typeof DeviceChangeEvent>
```

#### 3.2.2 ADB 输出解析器

**新增文件：`src/device/adb-parser.ts`**

负责解析 `adb devices -l` 和 `adb -s <serial> shell getprop` 的输出。

```typescript
export interface ParsedDevice {
  serial: string
  status: "online" | "offline" | "unauthorized" | "recovery" | "bootloader"
  model?: string
  product?: string
  device?: string
  transportId?: string
}

export function parseAdbDevices(output: string): ParsedDevice[] {
  // 解析 adb devices -l 输出格式：
  // SERIAL    status product:PRODUCT model:MODEL device:DEVICE transport_id:ID
  const lines = output.split("\n").slice(1) // 跳过 "List of devices attached"
  const devices: ParsedDevice[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split(/\s+/)
    const serial = parts[0]
    const statusPart = parts[1]
    // 解析状态
    let status: ParsedDevice["status"] = "offline"
    if (statusPart === "device") status = "online"
    else if (statusPart === "offline") status = "offline"
    else if (statusPart === "unauthorized") status = "unauthorized"
    else if (statusPart === "recovery") status = "recovery"
    else if (statusPart === "bootloader") status = "bootloader"
    // 解析附加属性
    const props: Record<string, string> = {}
    for (let i = 2; i < parts.length; i++) {
      const [key, value] = parts[i].split(":")
      if (key && value) props[key] = value
    }
    devices.push({
      serial,
      status,
      model: props["model"],
      product: props["product"],
      device: props["device"],
      transportId: props["transport_id"],
    })
  }
  return devices
}

export function parseGetprop(output: string): Record<string, string> {
  // 解析 adb shell getprop 输出格式：
  // [ro.build.version.release]: [14]
  // [ro.build.version.sdk]: [34]
  const result: Record<string, string> = {}
  const regex = /\[([^\]]+)\]:\s*\[([^\]]*)\]/
  for (const line of output.split("\n")) {
    const match = line.trim().match(regex)
    if (match) result[match[1]] = match[2]
  }
  return result
}
```

#### 3.2.3 设备管理服务

**新增文件：`src/device/device-manager.ts`**

遵循 Effect Service 模式，提供设备列表查询、状态监控、事件发布等能力。

```typescript
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Config } from "@/config/config"
import { Shell } from "@/shell/shell"
import { InstanceState } from "@/effect/instance-state"
import { Effect, Layer, Context, Schedule, Stream, Ref, Schema } from "effect"
import { DeviceID, DeviceInfo, DeviceStatus, DeviceChangeEvent } from "./schema"
import { parseAdbDevices, parseGetprop } from "./adb-parser"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "device-manager" })

export interface Interface {
  readonly list: () => Effect.Effect<DeviceInfo[]>
  readonly get: (id: DeviceID) => Effect.Effect<DeviceInfo, NotFoundError>
  readonly watch: () => Stream.Stream<DeviceChangeEvent>
  readonly refresh: () => Effect.Effect<void>
  readonly isAvailable: (id: DeviceID) => Effect.Effect<boolean>
  readonly count: () => Effect.Effect<number>
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()(
  "DeviceNotFoundError",
  { id: DeviceID },
) {}

export class Service extends Context.Service<Service, Interface>()("@opencode/DeviceManager") {}

export const layer: Layer.Layer<
  Service,
  never,
  Shell.Service | Config.Service | Bus.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const shell = yield* Shell.Service
    const config = yield* Config.Service
    const bus = yield* Bus.Service

    // 设备列表引用（实例级状态）
    const state = yield* InstanceState.make<Map<string, DeviceInfo>>(
      Effect.sync(() => new Map()),
    )

    // 执行 ADB 命令
    const execAdb = (args: string) =>
      Effect.gen(function* () {
        const cfg = yield* config.get()
        const adbPath = cfg.device?.adbPath ?? "adb"
        return yield* shell.exec(`${adbPath} ${args}`)
      })

    // 获取设备详情
    const enrichDevice = (parsed: ParsedDevice): Effect.Effect<DeviceInfo> =>
      Effect.gen(function* () {
        if (parsed.status !== "online") {
          return {
            id: DeviceID.make(parsed.serial),
            serial: parsed.serial,
            model: parsed.model,
            product: parsed.product,
            device: parsed.device,
            transportId: parsed.transportId,
            status: parsed.status as DeviceStatus,
            lastSeen: Date.now(),
          }
        }
        // 在线设备获取更多属性
        const propOutput = yield* execAdb(
          `-s ${parsed.serial} shell getprop`,
        ).pipe(Effect.catchAll(() => Effect.succeed("")))
        const props = parseGetprop(propOutput)
        return {
          id: DeviceID.make(parsed.serial),
          serial: parsed.serial,
          model: parsed.model ?? props["ro.product.model"],
          product: parsed.product,
          device: parsed.device,
          transportId: parsed.transportId,
          status: "online" as DeviceStatus,
          androidVersion: props["ro.build.version.release"],
          sdkVersion: props["ro.build.version.sdk"],
          ipAddress: props["dhcp.wlan0.ipaddress"],
          lastSeen: Date.now(),
        }
      })

    // 刷新设备列表
    const refresh = Effect.fn("DeviceManager.refresh")(function* () {
      const output = yield* execAdb("devices -l").pipe(
        Effect.catchAll(() => Effect.succeed({ stdout: "" })),
      )
      const parsed = parseAdbDevices(output.stdout)
      const enriched = yield* Effect.forEach(parsed, enrichDevice, {
        concurrency: "unbounded",
      })

      const currentMap = yield* InstanceState.useEffect(
        state,
        (ref) => Effect.sync(() => ref),
      )
      const newMap = new Map(enriched.map((d) => [d.serial, d]))

      // 检测变更并发布事件
      for (const device of enriched) {
        const prev = currentMap.get(device.serial)
        if (!prev) {
          yield* bus.publish(DeviceEvent.Connected, { device })
        } else if (prev.status !== device.status) {
          yield* bus.publish(DeviceEvent.StatusChanged, {
            device,
            previousStatus: prev.status,
          })
        }
      }
      for (const [serial, device] of currentMap) {
        if (!newMap.has(serial)) {
          yield* bus.publish(DeviceEvent.Disconnected, { device })
        }
      }

      yield* InstanceState.useEffect(state, (ref) =>
        Effect.sync(() => {
          ref.clear()
          for (const [k, v] of newMap) ref.set(k, v)
        }),
      )
    })

    // 启动轮询
    const cfg = yield* config.get()
    const pollInterval = cfg.device?.pollInterval ?? 5000
    yield* refresh.pipe(
      Effect.repeat(Schedule.spaced(Duration.millis(pollInterval))),
      Effect.fork, // 后台运行
    )

    // 初始刷新
    yield* refresh

    const list = Effect.fn("DeviceManager.list")(function* () {
      const map = yield* InstanceState.useEffect(state, (ref) =>
        Effect.sync(() => Array.from(ref.values())),
      )
      return map
    })

    const get = Effect.fn("DeviceManager.get")(function* (id: DeviceID) {
      const map = yield* InstanceState.useEffect(state, (ref) =>
        Effect.sync(() => ref),
      )
      const device = map.get(id)
      if (!device) return yield* Effect.fail(new NotFoundError({ id }))
      return device
    })

    const isAvailable = Effect.fn("DeviceManager.isAvailable")(function* (
      id: DeviceID,
    ) {
      const map = yield* InstanceState.useEffect(state, (ref) =>
        Effect.sync(() => ref),
      )
      const device = map.get(id)
      return device?.status === "online"
    })

    const count = Effect.fn("DeviceManager.count")(function* () {
      const map = yield* InstanceState.useEffect(state, (ref) =>
        Effect.sync(() => ref.size),
      )
      return map
    })

    const watch = () =>
      Stream.fromIterableEffect(
        Effect.sync(() => {
          // 订阅 Bus 事件并转换为 Stream
          // 实际实现需要通过 bus.subscribe
          return Stream.empty
        }),
      ).pipe(Stream.flattenIterables)

    return Service.of({ list, get, watch, refresh, isAvailable, count })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Shell.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Bus.layer),
)
```

#### 3.2.4 设备事件定义

**新增文件：`src/device/device-event.ts`**

```typescript
import { BusEvent } from "@/bus/bus-event"
import { DeviceInfo, DeviceStatus } from "./schema"

export const DeviceEvent = {
  Connected: BusEvent.define(
    "device.connected",
    Schema.Struct({
      device: DeviceInfo,
    }),
  ),
  Disconnected: BusEvent.define(
    "device.disconnected",
    Schema.Struct({
      device: DeviceInfo,
    }),
  ),
  StatusChanged: BusEvent.define(
    "device.status_changed",
    Schema.Struct({
      device: DeviceInfo,
      previousStatus: Schema.optional(DeviceStatus),
    }),
  ),
}
```

#### 3.2.5 模块导出

**新增文件：`src/device/index.ts`**

```typescript
export * as DeviceManager from "./device-manager"
export * as DeviceSchema from "./schema"
export * as DeviceEvent from "./device-event"
export * as AdbParser from "./adb-parser"
```

#### 3.2.6 HTTP API 路由

**新增文件：`src/server/routes/instance/httpapi/groups/device.ts`**

```typescript
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Schema } from "effect"

export const DeviceGroup = HttpApiBuilder.group(
  "device",
  HttpApiBuilder.httpApi(),
  (routes) =>
    routes
      .get(
        "/device",
        HttpApiBuilder.handler(
          Schema.Array(DeviceInfo),
          () => /* handler 调用 DeviceManager.list() */,
        ),
        { description: "List all connected Android devices" },
      )
      .get(
        "/device/:id",
        HttpApiBuilder.handler(
          DeviceInfo,
          ({ path }) => /* handler 调用 DeviceManager.get(path.id) */,
        ),
        { description: "Get device details by ID" },
      )
      .post(
        "/device/refresh",
        HttpApiBuilder.handler(
          Schema.Struct({ success: Schema.Boolean }),
          () => /* handler 调用 DeviceManager.refresh() */,
        ),
        { description: "Force refresh device list" },
      ),
)
```

**新增文件：`src/server/routes/instance/httpapi/handlers/device.ts`**

实现具体的请求处理逻辑，注入 DeviceManager.Service 并调用相应方法。

### 3.3 模块二：任务分配代理（Dispatcher Agent）

#### 3.3.1 设计思路

将 opencode 的主代理从 `build`（通用编码助手）切换为 `dispatcher`（任务分配器）。Dispatcher Agent 的核心职责是：

1. 接收上游任务描述
2. 查询可用设备列表
3. 为每台设备创建子 Agent Session
4. 通过 Task 工具将具体操作委派给 Device Operator Agent
5. 收集并汇总所有子 Agent 的执行结果
6. 向上游返回最终结果

这种设计复用了现有的 Agent + Task 工具架构，无需重新实现子代理调度机制。

#### 3.3.2 Dispatcher Agent 定义

**新增文件：`src/agent/prompt/dispatcher.txt`**

```
You are a task dispatcher agent responsible for coordinating Android device operations across multiple devices.

## Your Responsibilities

1. **Receive tasks**: Accept task descriptions from the upstream system or user
2. **Check device availability**: Use the `device_list` tool to see which devices are currently online
3. **Assign tasks**: Use the `task` tool with `subagent_type="device-operator"` to delegate work to individual devices
4. **Collect results**: Wait for all sub-agents to complete and aggregate their results
5. **Report outcomes**: Return a consolidated summary of all device operations

## Task Dispatching Guidelines

- Always call `device_list` before assigning tasks to check which devices are available
- For each target device, create a separate task with a clear prompt that includes:
  - The device serial number (e.g., "Target device serial: abc123")
  - The specific operation to perform
  - Any parameters or files needed
- Use descriptive task names (3-5 words) for the `description` parameter
- If a task needs to run on ALL available devices, create one task per device
- If a task targets a SPECIFIC device, only create one task for that device

## Error Handling

- If no devices are available, report "No devices currently available" and suggest retrying later
- If a device goes offline during execution, note the failure and continue with remaining devices
- Always include per-device status in the final summary (success/failure/timeout)

## Result Format

Structure your final response as:
```
## Task Summary
- Task: [task description]
- Total devices: [count]
- Successful: [count]
- Failed: [count]

## Per-Device Results
- Device [serial]: [status] - [brief result]
- Device [serial]: [status] - [brief result]

## Details
[detailed output from each device]
```
```

**在 `src/agent/agent.ts` 中注册 dispatcher agent：**

在 `agents` 对象中添加：

```typescript
dispatcher: {
  name: "dispatcher",
  description:
    "Task dispatcher that coordinates Android device operations across multiple devices. " +
    "Use this agent when you need to run tasks on Android devices.",
  mode: "primary",
  native: true,
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
  options: {},
},
```

#### 3.3.3 Device Operator Agent 定义

**新增文件：`src/agent/prompt/device-operator.txt`**

```
You are a device operator agent responsible for executing tasks on a specific Android device.

## Available Tools

You have access to the following ADB tools:

- **adb_shell**: Execute shell commands on the device
- **adb_install**: Install an APK on the device
- **adb_push**: Push a file from host to device
- **adb_pull**: Pull a file from device to host
- **adb_screenshot**: Take a screenshot of the device screen

## Important Rules

1. **Always use the device serial** specified in your task prompt. Prefix all operations with the correct serial.
2. **Verify device connectivity** before starting operations by running a simple command like `echo hello`.
3. **Report device issues immediately** if the device is unreachable or unresponsive.
4. **Provide structured output** of all operation results.
5. **Do not modify host files** unless explicitly required by the task (you only have read access to the host filesystem).

## Output Format

After completing your task, provide:
1. A summary of operations performed
2. The result of each operation (success/failure)
3. Any output or data requested by the task
4. Any errors encountered and suggested remediation

## Common Operations

### Install and launch an app
1. Use `adb_install` with the APK path
2. Use `adb_shell` to launch: `am start -n <package>/<activity>`

### Execute a test
1. Use `adb_shell` to run the test command
2. Capture and return the test output

### Take a screenshot
1. Use `adb_screenshot` to capture the screen
2. Return the screenshot file path

### Check device state
1. Use `adb_shell` with `getprop` or `dumpsys` commands
2. Parse and return relevant information
```

**在 `src/agent/agent.ts` 中注册 device-operator agent：**

```typescript
"device-operator": {
  name: "device-operator",
  description:
    "Operates a specific Android device via ADB commands. " +
    "Receives a device serial and task description, executes the task on the target device.",
  mode: "subagent",
  native: true,
  permission: Permission.merge(
    defaults,
    Permission.fromConfig({
      bash: "allow",
      read: "allow",
      grep: "allow",
      glob: "allow",
      question: "deny",
      plan_enter: "deny",
      plan_exit: "deny",
      todowrite: "deny",
      task: "deny",
      edit: { "*": "deny" },
      write: { "*": "deny" },
    }),
    user,
  ),
  prompt: PROMPT_DEVICE_OPERATOR,
  options: {},
},
```

#### 3.3.4 ADB 工具集

**新增文件：`src/tool/adb.ts`**

为 Device Operator Agent 提供专用的 ADB 操作工具，而非直接暴露 Shell 工具。

```typescript
import * as Tool from "./tool"
import { DeviceManager } from "@/device/device-manager"
import { DeviceID } from "@/device/schema"
import { Config } from "@/config/config"
import { Effect, Schema } from "effect"

const adbCommand = (serial: string, args: string) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const cfg = yield* config.get()
    const adbPath = cfg.device?.adbPath ?? "adb"
    const cmd = `${adbPath} -s ${serial} ${args}`
    // 通过 Shell 工具执行
    const shell = yield* Shell.Service
    return yield* shell.exec(cmd)
  })

export const AdbShellTool = Tool.define(
  "adb_shell",
  Effect.gen(function* () {
    return {
      description:
        "Execute a shell command on an Android device. " +
        "The command runs on the device, not on the host.",
      parameters: Schema.Struct({
        serial: Schema.String.annotate({
          description: "Device serial number (e.g., 'emulator-5554' or 'ABC123DEF')",
        }),
        command: Schema.String.annotate({
          description: "Shell command to execute on the device",
        }),
        timeout: Schema.optional(Schema.Number).annotate({
          description: "Timeout in milliseconds (default: 30000)",
        }),
      }),
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const deviceManager = yield* DeviceManager.Service
          const available = yield* deviceManager.isAvailable(
            DeviceID.make(params.serial),
          )
          if (!available) {
            return yield* Effect.fail(
              new Error(`Device ${params.serial} is not available`),
            )
          }
          const result = yield* adbCommand(
            params.serial,
            `shell ${params.command}`,
          )
          return {
            title: `adb shell on ${params.serial}`,
            metadata: { serial: params.serial, command: params.command },
            output: result.stdout || result.stderr || "(no output)",
          }
        }),
    }
  }),
)

export const AdbInstallTool = Tool.define(
  "adb_install",
  Effect.gen(function* () {
    return {
      description:
        "Install an APK file on an Android device.",
      parameters: Schema.Struct({
        serial: Schema.String.annotate({
          description: "Device serial number",
        }),
        apkPath: Schema.String.annotate({
          description: "Path to the APK file on the host machine",
        }),
        reinstall: Schema.optional(Schema.Boolean).annotate({
          description: "Whether to reinstall keeping data (default: false)",
        }),
      }),
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const deviceManager = yield* DeviceManager.Service
          const available = yield* deviceManager.isAvailable(
            DeviceID.make(params.serial),
          )
          if (!available) {
            return yield* Effect.fail(
              new Error(`Device ${params.serial} is not available`),
            )
          }
          const reinstallFlag = params.reinstall ? " -r" : ""
          const result = yield* adbCommand(
            params.serial,
            `install${reinstallFlag} ${params.apkPath}`,
          )
          return {
            title: `Install APK on ${params.serial}`,
            metadata: { serial: params.serial, apkPath: params.apkPath },
            output: result.stdout || result.stderr,
          }
        }),
    }
  }),
)

export const AdbPushTool = Tool.define(
  "adb_push",
  Effect.gen(function* () {
    return {
      description:
        "Push a file from the host to an Android device.",
      parameters: Schema.Struct({
        serial: Schema.String.annotate({
          description: "Device serial number",
        }),
        localPath: Schema.String.annotate({
          description: "Path to the file on the host machine",
        }),
        remotePath: Schema.String.annotate({
          description: "Destination path on the device",
        }),
      }),
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const deviceManager = yield* DeviceManager.Service
          const available = yield* deviceManager.isAvailable(
            DeviceID.make(params.serial),
          )
          if (!available) {
            return yield* Effect.fail(
              new Error(`Device ${params.serial} is not available`),
            )
          }
          const result = yield* adbCommand(
            params.serial,
            `push ${params.localPath} ${params.remotePath}`,
          )
          return {
            title: `Push file to ${params.serial}`,
            metadata: {
              serial: params.serial,
              localPath: params.localPath,
              remotePath: params.remotePath,
            },
            output: result.stdout || result.stderr,
          }
        }),
    }
  }),
)

export const AdbPullTool = Tool.define(
  "adb_pull",
  Effect.gen(function* () {
    return {
      description:
        "Pull a file from an Android device to the host.",
      parameters: Schema.Struct({
        serial: Schema.String.annotate({
          description: "Device serial number",
        }),
        remotePath: Schema.String.annotate({
          description: "Path to the file on the device",
        }),
        localPath: Schema.String.annotate({
          description: "Destination path on the host machine",
        }),
      }),
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const deviceManager = yield* DeviceManager.Service
          const available = yield* deviceManager.isAvailable(
            DeviceID.make(params.serial),
          )
          if (!available) {
            return yield* Effect.fail(
              new Error(`Device ${params.serial} is not available`),
            )
          }
          const result = yield* adbCommand(
            params.serial,
            `pull ${params.remotePath} ${params.localPath}`,
          )
          return {
            title: `Pull file from ${params.serial}`,
            metadata: {
              serial: params.serial,
              remotePath: params.remotePath,
              localPath: params.localPath,
            },
            output: result.stdout || result.stderr,
          }
        }),
    }
  }),
)

export const AdbScreenshotTool = Tool.define(
  "adb_screenshot",
  Effect.gen(function* () {
    return {
      description:
        "Take a screenshot of an Android device screen.",
      parameters: Schema.Struct({
        serial: Schema.String.annotate({
          description: "Device serial number",
        }),
        savePath: Schema.optional(Schema.String).annotate({
          description:
            "Path to save the screenshot on the host (default: /tmp/screenshot_<serial>_<timestamp>.png)",
        }),
      }),
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const deviceManager = yield* DeviceManager.Service
          const available = yield* deviceManager.isAvailable(
            DeviceID.make(params.serial),
          )
          if (!available) {
            return yield* Effect.fail(
              new Error(`Device ${params.serial} is not available`),
            )
          }
          const timestamp = Date.now()
          const remotePath = `/data/local/tmp/screenshot_${timestamp}.png`
          const localPath =
            params.savePath ??
            `/tmp/screenshot_${params.serial}_${timestamp}.png`
          // 在设备上截图
          yield* adbCommand(
            params.serial,
            `shell screencap -p ${remotePath}`,
          )
          // 拉取到主机
          const result = yield* adbCommand(
            params.serial,
            `pull ${remotePath} ${localPath}`,
          )
          // 清理设备上的临时文件
          yield* adbCommand(
            params.serial,
            `shell rm ${remotePath}`,
          ).pipe(Effect.catchAll(() => Effect.void))
          return {
            title: `Screenshot from ${params.serial}`,
            metadata: { serial: params.serial, filePath: localPath },
            output: `Screenshot saved to: ${localPath}`,
          }
        }),
    }
  }),
)
```

**新增文件：`src/tool/device-list.ts`**

```typescript
import * as Tool from "./tool"
import { DeviceManager } from "@/device/device-manager"
import { Effect, Schema } from "effect"

export const DeviceListTool = Tool.define(
  "device_list",
  Effect.gen(function* () {
    const deviceManager = yield* DeviceManager.Service
    return {
      description:
        "List all connected Android devices and their status. " +
        "Returns device serial numbers, models, Android versions, and online/offline status. " +
        "Use this before dispatching tasks to check which devices are available.",
      parameters: Schema.Struct({
        filter: Schema.optional(Schema.Struct({
          status: Schema.optional(Schema.String).annotate({
            description: "Filter by status (e.g., 'online')",
          }),
          model: Schema.optional(Schema.String).annotate({
            description: "Filter by device model",
          }),
        })).annotate({
          description: "Optional filter criteria",
        }),
      }),
      execute: (params, ctx) =>
        Effect.gen(function* () {
          let devices = yield* deviceManager.list()
          // 应用过滤
          if (params.filter?.status) {
            devices = devices.filter((d) => d.status === params.filter!.status)
          }
          if (params.filter?.model) {
            devices = devices.filter(
              (d) => d.model?.includes(params.filter!.model!),
            )
          }
          const lines = devices.map((d) => {
            const parts = [
              `  - Serial: ${d.serial}`,
              `    Status: ${d.status}`,
              d.model ? `    Model: ${d.model}` : null,
              d.androidVersion ? `    Android: ${d.androidVersion} (SDK ${d.sdkVersion})` : null,
              d.ipAddress ? `    IP: ${d.ipAddress}` : null,
              `    Last seen: ${new Date(d.lastSeen).toISOString()}`,
            ].filter(Boolean)
            return parts.join("\n")
          })
          const output =
            lines.length > 0
              ? `Found ${devices.length} device(s):\n${lines.join("\n")}`
              : "No devices currently connected."
          return {
            title: `${devices.length} device(s) found`,
            metadata: { count: devices.length, devices },
            output,
          }
        }),
    }
  }),
)
```

#### 3.3.5 工具注册

**修改 `src/tool/registry.ts`：**

在 `layer` 中初始化 ADB 工具：

```typescript
// 在现有工具初始化之后添加
const adbShell = yield* AdbShellTool
const adbInstall = yield* AdbInstallTool
const adbPush = yield* AdbPushTool
const adbPull = yield* AdbPullTool
const adbScreenshot = yield* AdbScreenshotTool
const deviceList = yield* DeviceListTool
```

在 `InstanceState.make` 的 `tool` 初始化中添加：

```typescript
const adbTools = yield* Effect.all({
  adb_shell: Tool.init(adbShell),
  adb_install: Tool.init(adbInstall),
  adb_push: Tool.init(adbPush),
  adb_pull: Tool.init(adbPull),
  adb_screenshot: Tool.init(adbScreenshot),
  device_list: Tool.init(deviceList),
})
```

在 `tools()` 方法中根据 agent 类型决定工具可见性：

```typescript
const tools: Interface["tools"] = Effect.fn("ToolRegistry.tools")(function* (input) {
  const filtered = (yield* all()).filter((tool) => {
    // ... 现有过滤逻辑 ...

    // ADB 工具只对 device-operator 和 dispatcher 可见
    const adbToolIds = ["adb_shell", "adb_install", "adb_push", "adb_pull", "adb_screenshot"]
    if (adbToolIds.includes(tool.id) && input.agent.name !== "device-operator") {
      return false
    }
    // device_list 只对 dispatcher 可见
    if (tool.id === "device_list" && input.agent.name !== "dispatcher") {
      return false
    }

    return true
  })
  // ...
})
```

#### 3.3.6 任务分配流程

完整的任务执行流程：

```
上游系统
  │
  │ POST /api/instance/task/dispatch
  │ { task: "在所有设备上安装并启动 com.example.app" }
  │
  ▼
OpenCode Server
  │
  │ 创建 Dispatcher Agent Session
  │ 发送 prompt: "在所有设备上安装并启动 com.example.app"
  │
  ▼
Dispatcher Agent (LLM 推理)
  │
  ├─ Step 1: 调用 device_list 工具
  │  → 返回: [device_A (online), device_B (online), device_C (offline)]
  │
  ├─ Step 2: 调用 task 工具
  │  task(
  │    description="安装应用到device_A",
  │    subagent_type="device-operator",
  │    prompt="目标设备序列号: device_A\n任务: 安装 /path/to/app.apk 并启动 com.example.app/.MainActivity"
  │  )
  │
  ├─ Step 3: 调用 task 工具
  │  task(
  │    description="安装应用到device_B",
  │    subagent_type="device-operator",
  │    prompt="目标设备序列号: device_B\n任务: 安装 /path/to/app.apk 并启动 com.example.app/.MainActivity"
  │  )
  │
  ├─ Step 4: 等待所有子 Agent 返回结果
  │  device_A → 成功: 应用已安装并启动
  │  device_B → 失败: 安装超时
  │  device_C → 跳过: 设备离线
  │
  └─ Step 5: 汇总结果返回
     "## 任务摘要\n- 成功: 1\n- 失败: 1\n- 跳过: 1\n..."
```

### 3.4 配置扩展

**新增文件：`src/config/device.ts`**

```typescript
import { Schema } from "effect"

export const ConfigDevice = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Enable the device management module (default: false)",
  }),
  adbPath: Schema.optional(Schema.String).annotate({
    description: "Path to the ADB executable (default: 'adb')",
  }),
  pollInterval: Schema.optional(Schema.Number).annotate({
    description: "Device polling interval in milliseconds (default: 5000)",
  }),
  autoDiscover: Schema.optional(Schema.Boolean).annotate({
    description: "Automatically discover devices on startup (default: true)",
  }),
}).annotate({ identifier: "ConfigDevice" })
export type ConfigDevice = Schema.Schema.Type<typeof ConfigDevice>
```

**修改 `src/config/config.ts`：**

在 `Info` Schema 中添加 `device` 字段：

```typescript
device: Schema.optional(ConfigDevice),
```

**用户配置示例（`opencode.json`）：**

```jsonc
{
  "device": {
    "enabled": true,
    "adbPath": "/usr/local/bin/adb",
    "pollInterval": 5000,
    "autoDiscover": true
  },
  "agent": {
    "dispatcher": {
      "model": "anthropic/claude-sonnet-4",
      "steps": 100,
      "disable": false
    },
    "device-operator": {
      "model": "anthropic/claude-sonnet-4",
      "steps": 50,
      "disable": false
    }
  },
  "default_agent": "dispatcher"
}
```

### 3.5 默认代理切换

**修改 `src/agent/agent.ts` 中的 `defaultInfo` 逻辑：**

当设备管理模块启用时，将默认代理切换为 dispatcher：

```typescript
const defaultInfo = Effect.fnUntraced(function* () {
  const c = yield* config.get()

  // 设备管理模式：默认使用 dispatcher
  if (c.device?.enabled) {
    const dispatcher = agents["dispatcher"]
    if (dispatcher && !dispatcher.hidden) return dispatcher
  }

  // 用户显式配置的默认代理
  if (c.default_agent) {
    const agent = agents[c.default_agent]
    if (!agent) throw new Error(`default agent "${c.default_agent}" not found`)
    if (agent.mode === "subagent") throw new Error(`default agent "${c.default_agent}" is a subagent`)
    if (agent.hidden === true) throw new Error(`default agent "${c.default_agent}" is hidden`)
    return agent
  }

  // 回退：查找第一个可见的 primary agent
  const visible = Object.values(agents).find((a) => a.mode !== "subagent" && a.hidden !== true)
  if (!visible) throw new Error("no primary visible agent found")
  return visible
})
```

### 3.6 上游任务接入 API

**新增文件：`src/server/routes/instance/httpapi/groups/task-dispatch.ts`**

```typescript
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Schema } from "effect"

const DeviceFilter = Schema.Struct({
  serials: Schema.optional(Schema.Array(Schema.String)),
  models: Schema.optional(Schema.Array(Schema.String)),
  minSdk: Schema.optional(Schema.Number),
})

const DispatchRequest = Schema.Struct({
  task: Schema.String.annotate({
    description: "Task description to dispatch to devices",
  }),
  deviceFilter: Schema.optional(DeviceFilter).annotate({
    description: "Optional filter to select target devices",
  }),
  parallel: Schema.optional(Schema.Boolean).annotate({
    description: "Execute tasks in parallel across devices (default: true)",
  }),
  timeout: Schema.optional(Schema.Number).annotate({
    description: "Timeout in milliseconds for each device task (default: 120000)",
  }),
})

const DeviceTaskResult = Schema.Struct({
  serial: Schema.String,
  status: Schema.Literals(["completed", "failed", "timeout", "skipped"]),
  output: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
})

const DispatchResponse = Schema.Struct({
  taskId: Schema.String,
  status: Schema.Literals(["dispatched", "no_devices", "error"]),
  devices: Schema.Array(Schema.String),
  message: Schema.optional(Schema.String),
})

const TaskStatusResponse = Schema.Struct({
  taskId: Schema.String,
  status: Schema.Literals(["running", "completed", "failed", "partial"]),
  results: Schema.Array(DeviceTaskResult),
})

export const TaskDispatchGroup = HttpApiBuilder.group(
  "task-dispatch",
  HttpApiBuilder.httpApi(),
  (routes) =>
    routes
      .post(
        "/task/dispatch",
        HttpApiBuilder.handler(
          DispatchResponse,
          ({ body }) => /* handler */,
        ),
        { description: "Dispatch a task to Android devices" },
      )
      .get(
        "/task/:taskId/status",
        HttpApiBuilder.handler(
          TaskStatusResponse,
          ({ path }) => /* handler */,
        ),
        { description: "Get task dispatch status and results" },
      ),
)
```

**新增文件：`src/server/routes/instance/httpapi/handlers/task-dispatch.ts`**

实现任务分配的核心逻辑：

1. 接收 `POST /task/dispatch` 请求
2. 查询 DeviceManager 获取匹配的设备列表
3. 创建 Dispatcher Agent Session
4. 构造 prompt 包含任务描述和目标设备信息
5. 发送 prompt 到 Session
6. 返回 `taskId` 供后续状态查询
7. `GET /task/:taskId/status` 查询 Session 状态和子 Session 结果

---

## 四、文件变更清单

### 4.1 新增文件

| 文件路径 | 说明 |
|---------|------|
| `src/device/schema.ts` | 设备数据模型定义（DeviceID, DeviceInfo, DeviceStatus 等） |
| `src/device/device-manager.ts` | 设备管理服务（Effect Service：list/get/watch/refresh/isAvailable） |
| `src/device/device-event.ts` | 设备事件定义（Connected/Disconnected/StatusChanged） |
| `src/device/adb-parser.ts` | ADB 输出解析工具（parseAdbDevices/parseGetprop） |
| `src/device/index.ts` | 设备模块统一导出 |
| `src/tool/adb.ts` | ADB 工具集（adb_shell/adb_install/adb_push/adb_pull/adb_screenshot） |
| `src/tool/device-list.ts` | 设备列表查询工具 |
| `src/agent/prompt/dispatcher.txt` | Dispatcher Agent 系统提示词 |
| `src/agent/prompt/device-operator.txt` | Device Operator Agent 系统提示词 |
| `src/config/device.ts` | 设备配置 Schema（ConfigDevice） |
| `src/server/routes/instance/httpapi/groups/device.ts` | 设备 API 路由定义 |
| `src/server/routes/instance/httpapi/handlers/device.ts` | 设备 API 处理函数 |
| `src/server/routes/instance/httpapi/groups/task-dispatch.ts` | 任务分配 API 路由定义 |
| `src/server/routes/instance/httpapi/handlers/task-dispatch.ts` | 任务分配 API 处理函数 |
| `test/device/adb-parser.test.ts` | ADB 解析器单元测试 |
| `test/device/device-manager.test.ts` | 设备管理服务单元测试 |
| `test/tool/adb.test.ts` | ADB 工具单元测试 |

### 4.2 修改文件

| 文件路径 | 修改内容 | 影响范围 |
|---------|---------|---------|
| `src/agent/agent.ts` | 1. 导入 PROMPT_DISPATCHER 和 PROMPT_DEVICE_OPERATOR<br>2. 在 agents 对象中注册 dispatcher 和 device-operator<br>3. 修改 defaultInfo 逻辑支持设备管理模式 | 核心代理系统 |
| `src/tool/registry.ts` | 1. 导入 ADB 工具和 DeviceListTool<br>2. 在 layer 中初始化新工具<br>3. 在 tools() 方法中根据 agent 类型过滤工具可见性 | 工具注册系统 |
| `src/config/config.ts` | 1. 导入 ConfigDevice<br>2. 在 Info Schema 中添加 device 字段 | 配置系统 |
| `src/server/routes/instance/httpapi/api.ts` | 添加 device 和 task-dispatch API group | API 路由 |
| `src/server/routes/instance/httpapi/server.ts` | 1. 导入新 handler<br>2. 注册新 Layer 依赖（DeviceManager） | 服务器启动 |

---

## 五、关键设计决策

### 5.1 为什么新增 ADB 工具而非直接用 Shell 工具？

| 方案 | 优点 | 缺点 |
|------|------|------|
| 直接用 Shell | 无需新增代码；LLM 可自由组合命令 | 安全风险高（可执行任意命令）；无法校验设备可用性；难以做参数校验；审计困难；LLM 可能生成错误的 ADB 命令 |
| **新增 ADB 工具**（✅ 采用） | 参数强校验；设备可用性前置检查；操作审计；可限制危险操作；更好的 LLM 工具描述（减少幻觉）；可独立控制每个工具的权限 | 需要新增代码；工具数量增加；需要维护工具描述 |

### 5.2 为什么 Dispatcher 是 primary agent 而非独立服务？

| 方案 | 优点 | 缺点 |
|------|------|------|
| 独立微服务 | 完全解耦；独立部署 | 需要重新实现 Session/Agent/Tool 体系；与现有事件系统隔离；ACP 兼容性断裂 |
| **Primary Agent**（✅ 采用） | 复用 Session 机制；复用 Task 工具；兼容 ACP；权限继承自动处理 | 与现有 build agent 互斥（但可通过配置切换） |

选择理由：
- **复用 Session 机制**：Dispatcher 本质上是一个 Session，上游任务作为 prompt 输入，结果作为 assistant 消息输出
- **复用 Task 工具**：子代理委派直接使用现有的 `task` 工具，无需重新实现
- **兼容 ACP**：外部 IDE 仍可通过 ACP 协议与 Dispatcher 交互
- **权限继承**：子代理权限通过 `deriveSubagentSessionPermission()` 自动派生

### 5.3 设备管理为什么是 Effect Service 而非独立进程？

| 方案 | 优点 | 缺点 |
|------|------|------|
| 独立进程 | 隔离性好；可独立重启 | IPC 通信复杂；无法直接注入到 Effect 依赖图；事件集成困难 |
| **Effect Service**（✅ 采用） | 依赖注入一致；直接使用 Bus 发布事件；Scope/Resource 自动管理生命周期；可被任何 Effect 服务注入 | 与主进程共享资源 |

### 5.4 多设备并行任务执行

Dispatcher Agent 通过多次调用 `task` 工具实现并行。由于 opencode 的 Session 系统支持多个子 Session 并行执行，这种设计天然支持并行。

LLM 的并行调用模式：
```
# Dispatcher 的 LLM 推理过程
1. 调用 device_list → 获取 [device_A, device_B, device_C]
2. 同时调用:
   - task(subagent_type="device-operator", prompt="在 device_A 上: ...")
   - task(subagent_type="device-operator", prompt="在 device_B 上: ...")
3. 等待所有 task 返回，汇总结果
```

> 注意：LLM 是否真正并行调用多个工具取决于模型能力和 ai-sdk 的 tool choice 配置。如果模型不支持并行工具调用，Dispatcher 会顺序调用，但每个子 Session 内部仍是异步执行的。

### 5.5 设备状态存储策略

| 方案 | 优点 | 缺点 |
|------|------|------|
| 纯内存（Ref） | 简单；快速 | 重启后丢失；无法跨实例共享 |
| **内存 + 事件持久化**（✅ 采用） | 可通过 SyncEvent 回放；WebSocket 自动同步 | 需要数据库写入 |
| 数据库持久化 | 完整历史记录 | 写入开销大；需要清理策略 |

选择内存 + 事件持久化：设备当前状态保存在 `InstanceState`（内存 Ref），状态变更通过 `SyncEvent` 持久化，客户端通过 WebSocket 实时获取更新。

---

## 六、实施路线图

### Phase 1：设备管理基础（1-2 周）

1. 创建 `src/device/` 模块（schema, device-manager, device-event, adb-parser, index）
2. 实现 ADB 设备发现和状态监控
3. 添加设备配置支持（`src/config/device.ts` + 修改 `config.ts`）
4. 编写设备管理单元测试
5. 验证：手动测试 ADB 设备发现和事件发布

### Phase 2：ADB 工具集（1 周）

1. 创建 `src/tool/adb.ts` 和 `src/tool/device-list.ts`
2. 实现 adb_shell, adb_install, adb_push, adb_pull, adb_screenshot 工具
3. 在 ToolRegistry 中注册并按 agent 过滤
4. 编写工具测试
5. 验证：通过 opencode CLI 测试 ADB 工具调用

### Phase 3：代理系统改造（1 周）

1. 编写 dispatcher.txt 和 device-operator.txt 提示词
2. 在 agent.ts 中注册新代理
3. 修改 defaultInfo 逻辑
4. 端到端测试：任务分配 → 子代理执行 → 结果汇总
5. 验证：通过 CLI 测试完整任务分配流程

### Phase 4：HTTP API 与集成（1 周）

1. 实现设备管理和任务分配的 HTTP API
2. 在 server.ts 中注册新路由和 Layer 依赖
3. SSE 事件流实现（设备状态变更推送）
4. ACP 兼容性测试
5. 验证：通过 curl / HTTP 客户端测试 API

### Phase 5：优化与加固（1 周）

1. 错误处理与重试机制（ADB 命令失败重试）
2. 超时与取消策略（长时间运行的任务）
3. 设备离线时的优雅降级
4. 性能测试与压力测试（多设备并行）
5. 文档与示例

---

## 七、风险与缓解

| 风险 | 影响 | 可能性 | 缓解措施 |
|------|------|--------|---------|
| ADB 命令执行阻塞 | 影响整个服务响应 | 中 | 所有 ADB 命令通过 Shell 工具异步执行，设置超时（默认 30s） |
| 设备频繁上下线 | 产生大量事件，影响性能 | 中 | 事件去重 + 防抖（状态稳定 2 秒后才发布变更事件） |
| LLM 生成错误的 ADB 命令 | 设备操作异常 | 高 | ADB 工具参数校验 + 危险操作（如 `rm -rf`）确认机制 |
| 多设备任务部分失败 | 结果不完整 | 中 | Dispatcher 汇总时标记 partial 状态，提供每设备独立结果 |
| Effect 框架学习曲线 | 开发效率低 | 中 | 参考现有模块（Session、Agent）的实现模式；团队内知识分享 |
| ADB 未安装或版本不兼容 | 设备管理功能不可用 | 低 | 启动时检测 ADB 可用性，不可用时优雅降级（设备管理禁用） |
| 并发 ADB 命令冲突 | 设备操作异常 | 低 | 每设备维护操作队列，串行化同一设备的 ADB 命令 |

---

## 附录A：核心源码引用

| 文件 | 关键接口/类 | 说明 |
|------|------------|------|
| `src/agent/agent.ts` | `Info`, `Interface`, `Service`, `layer` | Agent 定义与注册 |
| `src/agent/subagent-permissions.ts` | `deriveSubagentSessionPermission()` | 子代理权限派生 |
| `src/tool/tool.ts` | `Def`, `Info`, `Context`, `define()` | 工具接口定义 |
| `src/tool/registry.ts` | `Interface`, `Service`, `layer` | 工具注册与发现 |
| `src/tool/task.ts` | `TaskTool`, `TaskPromptOps` | 子代理委派工具 |
| `src/session/session.ts` | `Info`, `Interface`, `Service`, `layer` | 会话管理 |
| `src/session/llm.ts` | `StreamInput`, `Interface`, `Service` | LLM 流式调用 |
| `src/session/prompt.ts` | Session prompt 处理 | 提示构建与发送 |
| `src/bus/index.ts` | `Bus.Service` | 事件总线 |
| `src/bus/bus-event.ts` | `BusEvent.define()` | 事件定义工具 |
| `src/config/config.ts` | `Info`, `Service`, `layer` | 配置管理 |
| `src/config/agent.ts` | `Info`, `load()`, `loadMode()` | Agent 配置加载 |
| `src/server/server.ts` | `listen()`, `Default()` | 服务器启动 |
| `src/acp/agent.ts` | `Agent` | ACP 协议适配 |
| `src/acp/types.ts` | `ACPConfig`, `ACPSessionState` | ACP 类型定义 |
| `src/effect/instance-state.ts` | `InstanceState` | 实例级状态管理 |

---

## 附录B：数据流图

### B.1 设备发现数据流

```
ADB (adb devices -l)
  │
  │ stdout
  ▼
adb-parser.ts (parseAdbDevices)
  │
  │ ParsedDevice[]
  ▼
device-manager.ts (refresh)
  │
  ├─ enrichDevice() → adb shell getprop → parseGetprop()
  │
  ├─ 对比前后状态 → 检测变更
  │
  ├─ 发布事件 → Bus.publish(DeviceEvent.*)
  │                    │
  │                    ▼
  │              WebSocket/SSE → 客户端
  │
  └─ 更新 InstanceState (Ref<Map<string, DeviceInfo>>)
```

### B.2 任务分配数据流

```
上游系统
  │
  │ HTTP POST /task/dispatch
  ▼
task-dispatch handler
  │
  │ 创建 Session (agent="dispatcher")
  │ 发送 prompt
  ▼
Session Prompt
  │
  │ LLM 推理
  ▼
Dispatcher Agent
  │
  ├─ 调用 device_list → DeviceManager.list()
  │
  ├─ 调用 task(subagent_type="device-operator", prompt="...")
  │   │
  │   │ 创建子 Session (agent="device-operator", parentID=dispatcher.sessionID)
  │   │
  │   ▼
  │   Device Operator Agent
  │     │
  │     ├─ 调用 adb_shell(serial, command) → Shell.exec("adb -s ... shell ...")
  │     ├─ 调用 adb_install(serial, apkPath) → Shell.exec("adb -s ... install ...")
  │     ├─ 调用 adb_screenshot(serial) → Shell.exec("adb -s ... screencap ...")
  │     │
  │     └─ 返回结果 → Task Tool → Dispatcher
  │
  └─ 汇总所有子 Agent 结果 → 返回给上游
```

### B.3 事件传播数据流

```
DeviceManager.refresh()
  │
  ├─ Bus.publish(DeviceEvent.Connected)
  ├─ Bus.publish(DeviceEvent.StatusChanged)
  ├─ Bus.publish(DeviceEvent.Disconnected)
  │
  ▼
Bus (进程内事件总线)
  │
  ├─→ SSE Handler → HTTP SSE 响应 → 客户端
  ├─→ WebSocket Handler → WebSocket 推送 → 客户端
  └─→ SyncEvent 持久化 → 数据库
```

---

*文档结束*
