# OpenCode 二次开发设计文档：任务承接服务器模式

## 1. 概述

### 1.1 目标

将 OpenCode 从单用户本地编码助手改造为可承接上游任务的 Server 模式，使其能够：

1. 管理本地连接的安卓设备并上报状态
2. 以任务分配代理（Dispatcher Agent）替代原有主代理，按设备维度分发子任务
3. 子 Agent 的输出流可独立分发到指定消费者
4. 预留运营打点（Analytics Tracking）模块接口

### 1.2 现有架构摘要

```
┌─────────────────────────────────────────────────────────┐
│                    packages/opencode                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐ │
│  │  Agent    │  │ Session  │  │   Bus    │  │  Sync   │ │
│  │ (build/  │  │ (create/ │  │ (PubSub  │  │ (Event  │ │
│  │  plan/   │  │  prompt/ │  │  event   │  │  store/ │ │
│  │  explore)│  │  message)│  │  bus)    │  │  replay)│ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬────┘ │
│       │             │             │              │      │
│  ┌────┴─────┐  ┌────┴─────┐  ┌───┴──────────────────┐ │
│  │   Tool   │  │   LLM    │  │     Server            │ │
│  │ (task/   │  │ (stream/ │  │  (HTTP/SSE/WS)        │ │
│  │  shell/  │  │  ai-sdk) │  │  routes/middleware    │ │
│  │  read…)  │  │          │  │                       │ │
│  └──────────┘  └──────────┘  └───────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

**关键模块说明：**

| 模块 | 路径 | 职责 |
|------|------|------|
| Agent | `src/agent/agent.ts` | 定义代理类型（build/plan/general/explore等），管理权限和模型配置 |
| Session | `src/session/session.ts` | 会话生命周期管理，支持父子会话（subagent） |
| TaskTool | `src/tool/task.ts` | 子代理调用工具，创建子会话并执行 prompt |
| Bus | `src/bus/index.ts` | 基于 PubSub 的事件总线，支持类型订阅和通配订阅 |
| SyncEvent | `src/sync/index.ts` | 事件持久化与投影，CQRS 模式 |
| Server | `src/server/server.ts` | HTTP API + SSE 事件流 + WebSocket |
| V2 Session | `src/v2/session.ts` | 新版会话模型，支持 prompt/subagent/switchAgent 等操作 |
| V2 Events | `src/v2/session-event.ts` | 细粒度事件定义（Step/Text/Tool/Reasoning 等） |

**现有 Agent 模式：**

- `primary`：主代理（build、plan），直接与用户交互
- `subagent`：子代理（general、explore、scout），由 TaskTool 调用创建
- `all`：可同时作为主代理和子代理

**现有 TaskTool 工作流：**

1. 主代理调用 `task` 工具，指定 `subagent_type` 和 `prompt`
2. TaskTool 创建子会话（`parentID` 指向父会话）
3. 子会话以指定代理类型运行
4. 子代理输出结果回传给父会话

---

## 2. 总体架构设计

### 2.1 目标架构

```
┌──────────────────────────────────────────────────────────────────────┐
│                       Upstream Task Source                           │
│                    (上游任务调度系统 / HTTP API)                       │
└──────────────────────────┬───────────────────────────────────────────┘
                           │ HTTP/JSON
                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│                      OpenCode Task Server                            │
│                                                                      │
│  ┌─────────────────┐  ┌──────────────────┐  ┌────────────────────┐  │
│  │  Device Manager  │  │ Dispatcher Agent  │  │  Analytics Module  │  │
│  │  (设备发现/上报)  │  │ (任务解析/分发)    │  │  (运营打点接口)     │  │
│  └────────┬────────┘  └────────┬─────────┘  └────────┬───────────┘  │
│           │                    │                      │              │
│           ▼                    ▼                      ▼              │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │                    Core Extensions                             │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │  │
│  │  │  Device   │  │  Stream  │  │   Bus    │  │   Tracker    │  │  │
│  │  │  Registry │  │  Router  │  │ (extend) │  │   Middleware │  │  │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────────┘  │  │
│  └────────────────────────────────────────────────────────────────┘  │
│           │                    │                      │              │
│           ▼                    ▼                      ▼              │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │                  Existing OpenCode Core                        │  │
│  │  Agent / Session / Tool / LLM / Bus / SyncEvent / Server      │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

### 2.2 新增模块清单

| 模块 | 路径 | 类型 | 说明 |
|------|------|------|------|
| DeviceManager | `src/device/` | 新增 | 安卓设备管理模块 |
| DeviceRegistry | `src/device/registry.ts` | 新增 | 设备注册表（Effect Service） |
| DeviceScanner | `src/device/scanner.ts` | 新增 | ADB 设备扫描器 |
| DeviceAPI | `src/server/routes/instance/httpapi/groups/device.ts` | 新增 | 设备管理 HTTP API |
| DispatcherAgent | `src/agent/dispatcher.ts` | 新增 | 任务分发代理定义 |
| DeviceAgent | `src/agent/device-agent.ts` | 新增 | 设备操作子代理定义 |
| DeviceTools | `src/tool/device-*.ts` | 新增 | 设备操作工具集 |
| StreamRouter | `src/stream/router.ts` | 新增 | 输出流路由分发器 |
| StreamAPI | `src/server/routes/instance/httpapi/groups/stream.ts` | 新增 | 流订阅 HTTP API |
| Tracker | `src/tracker/` | 新增 | 运营打点模块 |
| TrackerMiddleware | `src/tracker/middleware.ts` | 新增 | 打点拦截中间件 |

---

## 3. 模块一：安卓设备管理

### 3.1 设计目标

- 自动发现本地通过 ADB 连接的安卓设备
- 实时监控设备连接/断开状态
- 上报设备信息到上游系统
- 提供设备查询 API 供 Dispatcher Agent 使用

### 3.2 数据模型

```typescript
// src/device/schema.ts

import { Schema } from "effect"

export const DeviceID = Schema.String.pipe(
  Schema.brand("DeviceID"),
)

export const DeviceStatus = Schema.Literals(
  "online",
  "offline",
  "unauthorized",
  "disconnecting",
)

export const DeviceTransport = Schema.Literals("usb", "tcpip")

export const DeviceInfo = Schema.Struct({
  id: DeviceID,
  serial: Schema.String,
  model: Schema.String,
  manufacturer: Schema.String,
  androidVersion: Schema.String,
  sdkVersion: Schema.String,
  status: DeviceStatus,
  transport: DeviceTransport,
  ip: Schema.optional(Schema.String),
  port: Schema.optional(Schema.NumberFromString),
  screenResolution: Schema.optional(Schema.Struct({
    width: Schema.Number,
    height: Schema.Number,
    density: Schema.Number,
  })),
  lastSeen: Schema.Number,
  metadata: Schema.Record(Schema.String, Schema.Unknown),
})
export type DeviceInfo = Schema.Schema.Type<typeof DeviceInfo>

export const DeviceEvent = Schema.Union(
  Schema.Struct({
    type: Schema.Literal("device.connected"),
    device: DeviceInfo,
  }),
  Schema.Struct({
    type: Schema.Literal("device.disconnected"),
    deviceID: DeviceID,
  }),
  Schema.Struct({
    type: Schema.Literal("device.updated"),
    device: DeviceInfo,
  }),
)
```

### 3.3 DeviceRegistry Service

```typescript
// src/device/registry.ts

import { Effect, Layer, Context, PubSub, Stream } from "effect"
import { BusEvent } from "@/bus/bus-event"
import { DeviceInfo, DeviceID, DeviceEvent } from "./schema"

export const DeviceConnected = BusEvent.define(
  "device.connected",
  Schema.Struct({ device: DeviceInfo }),
)

export const DeviceDisconnected = BusEvent.define(
  "device.disconnected",
  Schema.Struct({ deviceID: DeviceID }),
)

export const DeviceUpdated = BusEvent.define(
  "device.updated",
  Schema.Struct({ device: DeviceInfo }),
)

export interface Interface {
  readonly list: () => Effect.Effect<DeviceInfo[]>
  readonly get: (id: DeviceID) => Effect.Effect<DeviceInfo, NotFoundError>
  readonly subscribe: () => Stream.Stream<DeviceEvent>
  readonly refresh: () => Effect.Effect<void>
  readonly report: () => Effect.Effect<DeviceInfo[]>
}

export class Service extends Context.Service<Service, Interface>()(
  "@opencode/DeviceRegistry",
) {}

export const layer = Layer.effect(Service, Effect.gen(function* () {
  const devices = new Map<string, DeviceInfo>()
  const events = yield* PubSub.unbounded<DeviceEvent>()

  const list = Effect.fn("DeviceRegistry.list")(function* () {
    return Array.from(devices.values())
  })

  const get = Effect.fn("DeviceRegistry.get")(function* (id: DeviceID) {
    const device = devices.get(id)
    if (!device) return yield* new NotFoundError({ deviceID: id })
    return device
  })

  const subscribe = () =>
    Stream.fromPubSub(events)

  const refresh = Effect.fn("DeviceRegistry.refresh")(function* () {
    // 由 Scanner 调用，触发设备列表刷新
  })

  const report = Effect.fn("DeviceRegistry.report")(function* () {
    return Array.from(devices.values())
  })

  return Service.of({ list, get, subscribe, refresh, report })
}))
```

### 3.4 ADB Scanner

```typescript
// src/device/scanner.ts

import { Effect, Layer, Schedule, Context } from "effect"
import { DeviceRegistry } from "./registry"
import { DeviceInfo, DeviceID } from "./schema"

export interface Interface {
  readonly start: () => Effect.Effect<void>
  readonly stop: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()(
  "@opencode/DeviceScanner",
) {}

export const layer = Layer.effect(Service, Effect.gen(function* () {
  const registry = yield* DeviceRegistry.Service
  let running = false

  const scan = Effect.fn("DeviceScanner.scan")(function* () {
    // 执行 `adb devices -l` 解析输出
    const output = yield* Effect.promise(() =>
      Bun.$`adb devices -l`.text()
    )
    const parsed = parseAdbOutput(output)
    yield* registry.refresh()
  })

  const start = Effect.fn("DeviceScanner.start")(function* () {
    running = true
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => { running = false })
    )
    // 每 5 秒轮询一次 ADB 设备列表
    yield* scan.pipe(
      Effect.repeat(Schedule.fixed("5 seconds")),
      Effect.fork,
      Effect.interruptible,
    )
  })

  const stop = Effect.fn("DeviceScanner.stop")(function* () {
    running = false
  })

  return Service.of({ start, stop })
}))
```

### 3.5 设备上报 API

```typescript
// src/server/routes/instance/httpapi/groups/device.ts

export const DeviceGroup = HttpApiGroup.make("device")
  .add(
    HttpApiEndpoint.get("list", "/api/device", {
      success: Schema.Array(DeviceInfo),
    })
  )
  .add(
    HttpApiEndpoint.get("get", "/api/device/:deviceID", {
      params: { deviceID: DeviceID },
      success: DeviceInfo,
      error: HttpApiError.NotFound,
    })
  )
  .add(
    HttpApiEndpoint.post("refresh", "/api/device/refresh", {
      success: Schema.Array(DeviceInfo),
    })
  )
  .add(
    HttpApiEndpoint.get("report", "/api/device/report", {
      success: Schema.Struct({
        devices: Schema.Array(DeviceInfo),
        timestamp: Schema.Number,
        serverID: Schema.String,
      }),
    })
  )
  .middleware(Authorization)
```

### 3.6 设备状态 SSE 流

复用现有 Bus + SSE 机制，设备连接/断开事件通过 Bus 发布，客户端通过 `/event` SSE 端点订阅 `device.connected` / `device.disconnected` / `device.updated` 事件。

### 3.7 上游上报机制

```typescript
// src/device/reporter.ts

export interface ReporterConfig {
  endpoint: string
  interval: number
  headers?: Record<string, string>
}

export const layer = (config: ReporterConfig) => Layer.effect(
  Service,
  Effect.gen(function* () {
    const registry = yield* DeviceRegistry.Service

    const report = Effect.fn("DeviceReporter.report")(function* () {
      const devices = yield* registry.report()
      yield* Effect.promise(() =>
        fetch(config.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...config.headers,
          },
          body: JSON.stringify({
            timestamp: Date.now(),
            devices,
          }),
        })
      )
    })

    yield* report.pipe(
      Effect.repeat(Schedule.fixed(`${config.interval} seconds`)),
      Effect.fork,
    )

    return Service.of({ report })
  }),
)
```

---

## 4. 模块二：任务分发代理（Dispatcher Agent）

### 4.1 设计目标

- 替代原有 `build` 主代理为 `dispatcher` 代理
- 接收上游任务，解析任务意图
- 根据任务类型和设备可用性，将子任务分发到指定设备的子 Agent
- 支持并行分发多个设备的子任务
- 汇总子任务结果

### 4.2 Dispatcher Agent 定义

```typescript
// src/agent/dispatcher.ts

// 在 agent.ts 的 agents 注册表中新增 dispatcher 代理
export const dispatcherAgent: Info = {
  name: "dispatcher",
  description: `任务分发代理。接收上游任务，根据任务类型和设备可用性，
将子任务分发到指定安卓设备的子Agent执行。
支持并行分发和结果汇总。`,
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
  options: {},
  steps: 50,
}
```

### 4.3 Dispatcher System Prompt

```
你是一个任务分发代理（Dispatcher Agent）。你的职责是：

1. 分析上游任务请求，理解任务目标
2. 查询当前可用的安卓设备列表
3. 根据任务类型，决定需要哪些设备执行子任务
4. 为每台目标设备创建子任务（使用 task 工具，指定 subagent_type 为 "device-operator"）
5. 等待所有子任务完成
6. 汇总各设备子任务的结果，生成最终报告

任务分发规则：
- 如果任务指定了目标设备，只分发到指定设备
- 如果任务未指定设备，根据任务类型自动选择合适的设备
- 如果没有可用设备，返回错误信息
- 子任务之间默认并行执行

设备操作子Agent（device-operator）具备以下能力：
- 安装/卸载应用
- 启动/停止应用
- 执行 shell 命令
- 截屏/录屏
- 文件推送/拉取
- UI 自动化操作（点击/滑动/输入）
- 日志采集
```

### 4.4 Device Operator 子代理

```typescript
// src/agent/device-agent.ts

export const deviceOperatorAgent: Info = {
  name: "device-operator",
  description: `设备操作子代理。在指定安卓设备上执行操作任务，
包括应用管理、Shell命令、UI自动化、文件操作等。`,
  mode: "subagent",
  native: true,
  permission: Permission.merge(
    defaults,
    Permission.fromConfig({
      shell: "allow",
      read: "allow",
      write: "allow",
      device_adb: "allow",
      device_screencap: "allow",
      device_install: "allow",
      device_ui: "allow",
      todowrite: "deny",
      task: "deny",
    }),
    user,
  ),
  options: {},
}
```

### 4.5 设备操作工具集

```typescript
// src/tool/device-adb.ts
export const AdbTool = Tool.define("device_adb", Effect.gen(function* () {
  return {
    description: "在指定安卓设备上执行 ADB 命令",
    parameters: Schema.Struct({
      deviceID: DeviceID,
      command: Schema.String,
      timeout: Schema.optional(Schema.Number),
    }),
    execute: (params, ctx) => Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        Bun.$`adb -s ${params.deviceID} ${params.command}`
          .text({ timeout: params.timeout ?? 30000 })
      )
      return { title: `ADB: ${params.command}`, metadata: { deviceID: params.deviceID }, output: result }
    }),
  }
}))

// src/tool/device-install.ts
export const InstallTool = Tool.define("device_install", Effect.gen(function* () {
  return {
    description: "在指定安卓设备上安装 APK",
    parameters: Schema.Struct({
      deviceID: DeviceID,
      apkPath: Schema.String,
      reinstall: Schema.optional(Schema.Boolean),
    }),
    execute: (params, ctx) => Effect.gen(function* () {
      const flags = params.reinstall ? "-r" : ""
      const result = yield* Effect.promise(() =>
        Bun.$`adb -s ${params.deviceID} install ${flags} ${params.apkPath}`.text()
      )
      return { title: `Install APK on ${params.deviceID}`, metadata: { deviceID: params.deviceID }, output: result }
    }),
  }
}))

// src/tool/device-screencap.ts
export const ScreencapTool = Tool.define("device_screencap", Effect.gen(function* () {
  return {
    description: "截取安卓设备屏幕",
    parameters: Schema.Struct({
      deviceID: DeviceID,
      outputPath: Schema.optional(Schema.String),
    }),
    execute: (params, ctx) => Effect.gen(function* () {
      const path = params.outputPath ?? `/tmp/screencap_${params.deviceID}_${Date.now()}.png`
      yield* Effect.promise(() =>
        Bun.$`adb -s ${params.deviceID} shell screencap -p /sdcard/screencap.png && adb -s ${params.deviceID} pull /sdcard/screencap.png ${path}`.text()
      )
      return {
        title: `Screencap ${params.deviceID}`,
        metadata: { deviceID: params.deviceID, imagePath: path },
        output: `Screenshot saved to ${path}`,
        attachments: [{ type: "image", mimeType: "image/png", path }],
      }
    }),
  }
}))

// src/tool/device-ui.ts
export const DeviceUITool = Tool.define("device_ui", Effect.gen(function* () {
  return {
    description: "在安卓设备上执行 UI 自动化操作",
    parameters: Schema.Struct({
      deviceID: DeviceID,
      action: Schema.Union([
        Schema.Literal("tap"),
        Schema.Literal("swipe"),
        Schema.Literal("input"),
        Schema.Literal("press"),
      ]),
      x: Schema.optional(Schema.Number),
      y: Schema.optional(Schema.Number),
      endX: Schema.optional(Schema.Number),
      endY: Schema.optional(Schema.Number),
      text: Schema.optional(Schema.String),
      keyCode: Schema.optional(Schema.String),
      duration: Schema.optional(Schema.Number),
    }),
    execute: (params, ctx) => Effect.gen(function* () {
      let cmd: string
      switch (params.action) {
        case "tap":
          cmd = `input tap ${params.x} ${params.y}`
          break
        case "swipe":
          cmd = `input swipe ${params.x} ${params.y} ${params.endX} ${params.endY} ${params.duration ?? 300}`
          break
        case "input":
          cmd = `input text ${params.text}`
          break
        case "press":
          cmd = `input keyevent ${params.keyCode}`
          break
      }
      const result = yield* Effect.promise(() =>
        Bun.$`adb -s ${params.deviceID} shell ${cmd}`.text()
      )
      return { title: `UI: ${params.action}`, metadata: { deviceID: params.deviceID }, output: result }
    }),
  }
}))

// src/tool/device-logcat.ts
export const LogcatTool = Tool.define("device_logcat", Effect.gen(function* () {
  return {
    description: "采集安卓设备日志",
    parameters: Schema.Struct({
      deviceID: DeviceID,
      filter: Schema.optional(Schema.String),
      lines: Schema.optional(Schema.Number),
      dump: Schema.optional(Schema.Boolean),
    }),
    execute: (params, ctx) => Effect.gen(function* () {
      const dumpFlag = params.dump ? "-d" : ""
      const lineFlag = params.lines ? `-t ${params.lines}` : ""
      const filter = params.filter ?? ""
      const result = yield* Effect.promise(() =>
        Bun.$`adb -s ${params.deviceID} logcat ${dumpFlag} ${lineFlag} ${filter}`.text({ timeout: 10000 })
      )
      return { title: `Logcat ${params.deviceID}`, metadata: { deviceID: params.deviceID }, output: result }
    }),
  }
}))
```

### 4.6 任务分发流程

```
上游请求 ──► POST /api/session/:sessionID/prompt
                    │
                    ▼
            Dispatcher Agent 接收任务
                    │
                    ├── 1. 调用 device_list 工具查询可用设备
                    │
                    ├── 2. 分析任务，决定分发策略
                    │
                    ├── 3. 为每台设备创建子任务
                    │       │
                    │       ├── task(subagent_type="device-operator",
                    │       │        prompt="在设备 {deviceID} 上执行...",
                    │       │        device_context={deviceID: "xxx"})
                    │       │
                    │       ├── task(subagent_type="device-operator",
                    │       │        prompt="在设备 {deviceID} 上执行...",
                    │       │        device_context={deviceID: "yyy"})
                    │       │
                    │       └── ... (并行)
                    │
                    └── 4. 汇总结果，返回最终报告
```

### 4.7 任务接收 API 扩展

在现有 V2 Session API 基础上新增任务接收端点：

```typescript
// src/server/routes/instance/httpapi/groups/task.ts

export const TaskGroup = HttpApiGroup.make("task")
  .add(
    HttpApiEndpoint.post("submit", "/api/task/submit", {
      payload: Schema.Struct({
        taskID: Schema.String,
        taskType: Schema.String,
        description: Schema.String,
        targetDevices: Schema.optional(Schema.Array(DeviceID)),
        priority: Schema.optional(Schema.Literals("high", "medium", "low")),
        parameters: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
        callback: Schema.optional(Schema.Struct({
          url: Schema.String,
          headers: Schema.Record(Schema.String, Schema.String),
        })),
      }),
      success: Schema.Struct({
        sessionID: SessionID,
        status: Schema.Literal("accepted"),
      }),
    })
  )
  .add(
    HttpApiEndpoint.get("status", "/api/task/:taskID/status", {
      params: { taskID: Schema.String },
      success: Schema.Struct({
        taskID: Schema.String,
        status: Schema.Literals("pending", "running", "completed", "failed"),
        subtasks: Schema.Array(Schema.Struct({
          deviceID: DeviceID,
          sessionID: SessionID,
          status: Schema.Literals("pending", "running", "completed", "failed"),
          result: Schema.optional(Schema.String),
        })),
      }),
    })
  )
```

---

## 5. 模块三：子 Agent 输出流独立分发

### 5.1 设计目标

- 每个子 Agent（设备操作代理）的输出流可独立订阅
- 支持多种消费者：SSE、WebSocket、回调
- 流内容包含：文本增量、工具调用进度、状态变更
- 支持流的过滤（按事件类型、按设备 ID）

### 5.2 现有流机制分析

当前 OpenCode 的流机制：

1. **Bus 事件流**：通过 `Bus.subscribeAll()` 订阅所有事件，SSE 端点 `/event` 对外暴露
2. **V2 事件模型**：`SessionEvent` 定义了细粒度事件（Text.Delta、Tool.Called 等）
3. **SyncEvent 投影**：事件持久化后通过 projector 更新数据库视图

**问题**：现有 SSE 流是全局的，所有会话的事件混在一起，无法按子 Agent / 设备维度独立订阅。

### 5.3 StreamRouter 设计

```typescript
// src/stream/router.ts

import { Effect, Layer, Context, PubSub, Stream, Hub } from "effect"
import { BusEvent } from "@/bus/bus-event"
import { SessionID } from "@/session/schema"
import { DeviceID } from "@/device/schema"

export type StreamFilter = {
  sessionID?: SessionID
  deviceID?: DeviceID
  eventTypes?: string[]
}

export type RoutedEvent = {
  source: {
    sessionID: SessionID
    parentSessionID?: SessionID
    deviceID?: DeviceID
  }
  event: BusEvent.Payload
}

export interface Interface {
  readonly publish: (event: RoutedEvent) => Effect.Effect<void>
  readonly subscribe: (filter: StreamFilter) => Stream.Stream<RoutedEvent>
  readonly subscribeAll: () => Stream.Stream<RoutedEvent>
}

export class Service extends Context.Service<Service, Interface>()(
  "@opencode/StreamRouter",
) {}

export const layer = Layer.effect(Service, Effect.gen(function* () {
  const hub = yield* Hub.unbounded<RoutedEvent>()
  const subscriptions = new Map<string, PubSub.PubSub<RoutedEvent>>()

  const publish = Effect.fn("StreamRouter.publish")(function* (event: RoutedEvent) {
    yield* Hub.publish(hub, event)

    // 分发到匹配的订阅
    for (const [key, ps] of subscriptions) {
      if (matchesFilter(key, event)) {
        yield* PubSub.publish(ps, event)
      }
    }
  })

  const subscribe = (filter: StreamFilter): Stream.Stream<RoutedEvent> => {
    const key = filterKey(filter)
    return Stream.unwrap(
      Effect.gen(function* () {
        let ps = subscriptions.get(key)
        if (!ps) {
          ps = yield* PubSub.unbounded<RoutedEvent>()
          subscriptions.set(key, ps)
        }
        return Stream.fromPubSub(ps)
      }),
    )
  }

  const subscribeAll = () => Stream.fromHub(hub)

  return Service.of({ publish, subscribe, subscribeAll })
}))

function filterKey(filter: StreamFilter): string {
  return JSON.stringify(filter)
}

function matchesFilter(key: string, event: RoutedEvent): boolean {
  const filter: StreamFilter = JSON.parse(key)
  if (filter.sessionID && event.source.sessionID !== filter.sessionID) return false
  if (filter.deviceID && event.source.deviceID !== filter.deviceID) return false
  if (filter.eventTypes && !filter.eventTypes.includes(event.event.type)) return false
  return true
}
```

### 5.4 Bus 事件增强

在现有 Bus 事件中注入设备上下文，使事件可按设备维度路由：

```typescript
// src/stream/device-context.ts

import { Bus } from "@/bus"
import { DeviceID } from "@/device/schema"
import { SessionID } from "@/session/schema"
import { InstanceState } from "@/effect/instance-state"

// 维护 sessionID -> deviceID 的映射
const sessionDeviceMap = new Map<string, DeviceID>()

export function bindSessionToDevice(sessionID: SessionID, deviceID: DeviceID) {
  sessionDeviceMap.set(sessionID, deviceID)
}

export function unbindSession(sessionID: SessionID) {
  sessionDeviceMap.delete(sessionID)
}

export function getDeviceForSession(sessionID: SessionID): DeviceID | undefined {
  return sessionDeviceMap.get(sessionID)
}
```

### 5.5 流订阅 API

```typescript
// src/server/routes/instance/httpapi/groups/stream.ts

export const StreamGroup = HttpApiGroup.make("stream")
  .add(
    // 按 sessionID 订阅子 Agent 输出流
    HttpApiEndpoint.get("session", "/api/stream/session/:sessionID", {
      params: { sessionID: SessionID },
      query: Schema.Struct({
        eventTypes: Schema.optional(Schema.String),
      }),
      success: Schema.String.pipe(
        HttpApiSchema.asText({ contentType: "text/event-stream" }),
      ),
    })
  )
  .add(
    // 按 deviceID 订阅设备相关所有子 Agent 输出流
    HttpApiEndpoint.get("device", "/api/stream/device/:deviceID", {
      params: { deviceID: DeviceID },
      query: Schema.Struct({
        eventTypes: Schema.optional(Schema.String),
      }),
      success: Schema.String.pipe(
        HttpApiSchema.asText({ contentType: "text/event-stream" }),
      ),
    })
  )
  .add(
    // 订阅所有子 Agent 输出流
    HttpApiEndpoint.get("all", "/api/stream/all", {
      success: Schema.String.pipe(
        HttpApiSchema.asText({ contentType: "text/event-stream" }),
      ),
    })
  )
  .middleware(Authorization)
```

### 5.6 SSE 流 Handler 实现

```typescript
// src/server/routes/instance/httpapi/handlers/stream.ts

export const streamHandlers = HttpApiBuilder.group(StreamApi, "stream", (handlers) =>
  Effect.gen(function* () {
    const router = yield* StreamRouter.Service

    return handlers
      .handleRaw("session", Effect.fn("StreamHttpApi.session")(function* (req) {
        const sessionID = req.params.sessionID
        const eventTypes = req.query.eventTypes?.split(",")
        const filter: StreamFilter = { sessionID, eventTypes }

        const events = router.subscribe(filter).pipe(
          Stream.map((e) => eventData(e)),
          Stream.pipeThroughChannel(Sse.encode()),
          Stream.encodeText,
        )

        return HttpServerResponse.stream(events, {
          contentType: "text/event-stream",
          headers: {
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
          },
        })
      }))
      .handleRaw("device", Effect.fn("StreamHttpApi.device")(function* (req) {
        const deviceID = req.params.deviceID
        const filter: StreamFilter = { deviceID }

        const events = router.subscribe(filter).pipe(
          Stream.map((e) => eventData(e)),
          Stream.pipeThroughChannel(Sse.encode()),
          Stream.encodeText,
        )

        return HttpServerResponse.stream(events, {
          contentType: "text/event-stream",
          headers: {
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
          },
        })
      }))
  }),
)
```

### 5.7 回调模式

对于不支持 SSE 的消费者，支持回调模式：

```typescript
// src/stream/callback.ts

export interface CallbackConfig {
  url: string
  headers?: Record<string, string>
  filter: StreamFilter
  retryPolicy?: { maxRetries: number; backoffMs: number }
}

export const CallbackDispatcher = Layer.effect(
  Service,
  Effect.gen(function* () {
    const router = yield* StreamRouter.Service

    const register = (config: CallbackConfig) =>
      Effect.gen(function* () {
        const stream = router.subscribe(config.filter)
        yield* stream.pipe(
          Stream.runForEach((event) =>
            Effect.promise(() =>
              fetch(config.url, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  ...config.headers,
                },
                body: JSON.stringify(event),
              })
            ).pipe(Effect.retry(Schedule.exponential("1 second"))),
          ),
          Effect.fork,
        )
      })

    return Service.of({ register })
  }),
)
```

---

## 6. 模块四：运营打点模块

### 6.1 设计目标

- 定义统一的打点接口（Tracker Interface）
- 在关键路径插入打点钩子
- 支持自定义打点后端（本地日志、远程服务、数据仓库等）
- 不侵入核心业务逻辑

### 6.2 打点事件定义

```typescript
// src/tracker/schema.ts

import { Schema } from "effect"
import { SessionID } from "@/session/schema"
import { DeviceID } from "@/device/schema"

export const TrackerEvent = Schema.Struct({
  id: Schema.String,
  timestamp: Schema.Number,
  type: Schema.String,
  sessionID: Schema.optional(SessionID),
  deviceID: Schema.optional(DeviceID),
  data: Schema.Record(Schema.String, Schema.Unknown),
})
export type TrackerEvent = Schema.Schema.Type<typeof TrackerEvent>

// 预定义事件类型
export namespace TrackerEvents {
  export const TaskReceived = Schema.Struct({
    type: Schema.Literal("task.received"),
    data: Schema.Struct({
      taskID: Schema.String,
      taskType: Schema.String,
      targetDevices: Schema.Array(Schema.String),
      priority: Schema.String,
    }),
  })

  export const TaskDispatched = Schema.Struct({
    type: Schema.Literal("task.dispatched"),
    data: Schema.Struct({
      taskID: Schema.String,
      sessionID: SessionID,
      deviceID: DeviceID,
      agentType: Schema.String,
    }),
  })

  export const SubagentStarted = Schema.Struct({
    type: Schema.Literal("subagent.started"),
    data: Schema.Struct({
      sessionID: SessionID,
      parentSessionID: SessionID,
      deviceID: Schema.optional(DeviceID),
      agentType: Schema.String,
      model: Schema.String,
    }),
  })

  export const SubagentCompleted = Schema.Struct({
    type: Schema.Literal("subagent.completed"),
    data: Schema.Struct({
      sessionID: SessionID,
      parentSessionID: SessionID,
      deviceID: Schema.optional(DeviceID),
      duration: Schema.Number,
      tokenUsage: Schema.Struct({
        input: Schema.Number,
        output: Schema.Number,
      }),
      cost: Schema.Number,
      toolCalls: Schema.Number,
      success: Schema.Boolean,
    }),
  })

  export const ToolExecuted = Schema.Struct({
    type: Schema.Literal("tool.executed"),
    data: Schema.Struct({
      sessionID: SessionID,
      toolName: Schema.String,
      deviceID: Schema.optional(DeviceID),
      duration: Schema.Number,
      success: Schema.Boolean,
      truncated: Schema.Boolean,
    }),
  })

  export const DeviceStatusChanged = Schema.Struct({
    type: Schema.Literal("device.status_changed"),
    data: Schema.Struct({
      deviceID: DeviceID,
      previousStatus: Schema.String,
      newStatus: Schema.String,
    }),
  })

  export const StreamConsumerSubscribed = Schema.Struct({
    type: Schema.Literal("stream.consumer_subscribed"),
    data: Schema.Struct({
      consumerID: Schema.String,
      filterType: Schema.String,
      filterValue: Schema.String,
      protocol: Schema.String,
    }),
  })

  export const LLMCall = Schema.Struct({
    type: Schema.Literal("llm.call"),
    data: Schema.Struct({
      sessionID: SessionID,
      providerID: Schema.String,
      modelID: Schema.String,
      inputTokens: Schema.Number,
      outputTokens: Schema.Number,
      latency: Schema.Number,
      success: Schema.Boolean,
    }),
  })
}
```

### 6.3 Tracker Service 接口

```typescript
// src/tracker/tracker.ts

import { Effect, Layer, Context } from "effect"
import { TrackerEvent } from "./schema"

export interface Interface {
  readonly track: (event: Omit<TrackerEvent, "id" | "timestamp">) => Effect.Effect<void>
  readonly flush: () => Effect.Effect<void>
  readonly setContext: (key: string, value: unknown) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()(
  "@opencode/Tracker",
) {}

// NoOp 实现 - 默认不发送任何打点
export const noopLayer = Layer.succeed(Service, Service.of({
  track: () => Effect.void,
  flush: () => Effect.void,
  setContext: () => Effect.void,
}))

// 控制台日志实现 - 开发调试用
export const consoleLayer = Layer.effect(Service, Effect.gen(function* () {
  const context: Record<string, unknown> = {}

  return Service.of({
    track: (event) => Effect.sync(() => {
      console.log("[Tracker]", JSON.stringify({ ...event, context }))
    }),
    flush: () => Effect.void,
    setContext: (key, value) => Effect.sync(() => { context[key] = value }),
  })
}))

// 远程上报实现 - 生产环境用
export const remoteLayer = (config: {
  endpoint: string
  apiKey?: string
  batchSize?: number
  flushInterval?: number
}) => Layer.effect(Service, Effect.gen(function* () {
  const context: Record<string, unknown> = {}
  const buffer: TrackerEvent[] = []
  const batchSize = config.batchSize ?? 50
  const flushInterval = config.flushInterval ?? 5000

  const flush = Effect.fn("Tracker.flush")(function* () {
    if (buffer.length === 0) return
    const batch = buffer.splice(0)
    yield* Effect.promise(() =>
      fetch(config.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({ events: batch, context }),
      })
    ).pipe(Effect.retry({ times: 3 }))
  })

  // 定时刷新
  yield* flush.pipe(
    Effect.repeat(Schedule.fixed(`${flushInterval} millis`)),
    Effect.fork,
  )

  return Service.of({
    track: (event) => Effect.gen(function* () {
      const fullEvent: TrackerEvent = {
        ...event,
        id: crypto.randomUUID(),
        timestamp: Date.now(),
      }
      buffer.push(fullEvent)
      if (buffer.length >= batchSize) {
        yield* flush
      }
    }),
    flush,
    setContext: (key, value) => Effect.sync(() => { context[key] = value }),
  })
}))
```

### 6.4 打点中间件

在关键路径插入打点钩子，通过 Bus 事件订阅实现非侵入式打点：

```typescript
// src/tracker/middleware.ts

import { Bus } from "@/bus"
import { Tracker } from "./tracker"
import { SessionEvent } from "@/v2/session-event"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"

export const TrackerMiddleware = Layer.effect(
  Effect.gen(function* () {
    const tracker = yield* Tracker.Service
    const bus = yield* Bus.Service

    // 订阅会话事件并打点
    yield* bus.subscribeCallback(Session.Event.Created, (event) => {
      yield* tracker.track({
        type: "session.created",
        sessionID: event.properties.sessionID,
        data: { agent: event.properties.info.agent },
      })
    })

    yield* bus.subscribeCallback(MessageV2.Event.PartDelta, (event) => {
      // 文本增量打点（可配置采样率）
    })

    // 订阅 V2 Step 事件
    yield* bus.subscribeCallback(SessionEvent.Step.Started, (event) => {
      yield* tracker.track({
        type: "subagent.started",
        sessionID: event.properties.data.sessionID,
        data: {
          agent: event.properties.data.agent,
          model: event.properties.data.model,
        },
      })
    })

    yield* bus.subscribeCallback(SessionEvent.Step.Ended, (event) => {
      yield* tracker.track({
        type: "subagent.completed",
        sessionID: event.properties.data.sessionID,
        data: {
          duration: Date.now() - event.properties.data.timestamp.getTime(),
          tokenUsage: {
            input: event.properties.data.tokens.input,
            output: event.properties.data.tokens.output,
          },
          cost: event.properties.data.cost,
          success: true,
        },
      })
    })

    yield* bus.subscribeCallback(SessionEvent.Step.Failed, (event) => {
      yield* tracker.track({
        type: "subagent.completed",
        sessionID: event.properties.data.sessionID,
        data: {
          success: false,
          error: event.properties.data.error,
        },
      })
    })

    // 订阅设备事件
    yield* bus.subscribeCallback(DeviceConnected, (event) => {
      yield* tracker.track({
        type: "device.status_changed",
        deviceID: event.properties.device.id,
        data: {
          previousStatus: "disconnected",
          newStatus: "connected",
        },
      })
    })
  }),
)
```

### 6.5 打点配置

```typescript
// src/tracker/config.ts

import { Schema } from "effect"

export const TrackerConfig = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  backend: Schema.optional(Schema.Literals("noop", "console", "remote")),
  remoteEndpoint: Schema.optional(Schema.String),
  apiKey: Schema.optional(Schema.String),
  batchSize: Schema.optional(Schema.Number),
  flushInterval: Schema.optional(Schema.Number),
  samplingRate: Schema.optional(Schema.Number),
  events: Schema.optional(Schema.Struct({
    taskReceived: Schema.optional(Schema.Boolean),
    taskDispatched: Schema.optional(Schema.Boolean),
    subagentStarted: Schema.optional(Schema.Boolean),
    subagentCompleted: Schema.optional(Schema.Boolean),
    toolExecuted: Schema.optional(Schema.Boolean),
    deviceStatusChanged: Schema.optional(Schema.Boolean),
    llmCall: Schema.optional(Schema.Boolean),
    streamConsumerSubscribed: Schema.optional(Schema.Boolean),
  })),
})
```

---

## 7. 集成与启动流程

### 7.1 配置文件扩展

在 `opencode.jsonc` 中新增配置项：

```jsonc
{
  // 现有配置...

  // 任务服务器模式配置
  "task_server": {
    "enabled": true,
    "upstream_endpoint": "https://upstream.example.com/api",
    "upstream_api_key": "",
    "callback_timeout": 30000
  },

  // 设备管理配置
  "device": {
    "scan_interval": 5,
    "adb_path": "adb",
    "report_endpoint": "https://upstream.example.com/api/devices/report",
    "report_interval": 30,
    "report_headers": {}
  },

  // 流分发配置
  "stream": {
    "max_subscriptions_per_device": 10,
    "heartbeat_interval": 10,
    "callback_retry": { "max_retries": 3, "backoff_ms": 1000 }
  },

  // 打点配置
  "tracker": {
    "enabled": true,
    "backend": "remote",
    "remote_endpoint": "https://analytics.example.com/api/events",
    "api_key": "",
    "batch_size": 50,
    "flush_interval": 5000,
    "sampling_rate": 1.0,
    "events": {
      "task_received": true,
      "task_dispatched": true,
      "subagent_started": true,
      "subagent_completed": true,
      "tool_executed": true,
      "device_status_changed": true,
      "llm_call": true
    }
  },

  // 代理配置覆盖
  "agent": {
    "dispatcher": {
      "model": "anthropic/claude-sonnet-4",
      "steps": 50
    },
    "device-operator": {
      "model": "anthropic/claude-sonnet-4",
      "steps": 30
    }
  }
}
```

### 7.2 启动流程

```
1. Server.listen() 启动 HTTP 服务
       │
       ├── 2. DeviceScanner.start() 启动 ADB 设备扫描
       │       └── 定期扫描 → 更新 DeviceRegistry → 上报上游
       │
       ├── 3. TrackerMiddleware 初始化
       │       └── 订阅 Bus 事件 → 打点
       │
       ├── 4. StreamRouter 初始化
       │       └── 订阅 Bus 事件 → 路由分发
       │
       └── 5. 注册新 Agent（dispatcher, device-operator）
               注册新 Tool（device_adb, device_install, device_screencap, device_ui, device_logcat）
               注册新 API Group（device, task, stream）
```

### 7.3 Layer 依赖图

```
AppRuntime
  ├── ConfigService
  ├── DeviceRegistry.layer
  │     └── Bus.layer
  ├── DeviceScanner.layer
  │     └── DeviceRegistry.layer
  ├── DeviceReporter.layer
  │     └── DeviceRegistry.layer
  ├── StreamRouter.layer
  │     └── Bus.layer
  ├── Tracker.layer (noop | console | remote)
  │     └── ConfigService
  ├── TrackerMiddleware.layer
  │     ├── Tracker.layer
  │     └── Bus.layer
  ├── Agent.layer (扩展 dispatcher + device-operator)
  │     └── ... (现有依赖)
  ├── ToolRegistry (扩展 device tools)
  │     └── ... (现有依赖)
  └── Server.layer (扩展 API groups)
        ├── DeviceAPI
        ├── TaskAPI
        ├── StreamAPI
        └── ... (现有 API groups)
```

---

## 8. 关键修改点

### 8.1 需要修改的现有文件

| 文件 | 修改内容 |
|------|----------|
| `src/agent/agent.ts` | 在 agents 注册表中新增 `dispatcher` 和 `device-operator` |
| `src/tool/registry.ts` | 注册新的设备操作工具 |
| `src/server/routes/instance/httpapi/api.ts` | 添加 DeviceApi、TaskApi、StreamApi 到 InstanceHttpApi |
| `src/server/server.ts` | 集成 DeviceScanner、StreamRouter、Tracker 的 Layer |
| `src/config/config.ts` | 解析新增的 task_server/device/stream/tracker 配置 |
| `src/session/prompt.ts` | 在 TaskTool 调用时注入设备上下文到子会话 |
| `src/tool/task.ts` | 扩展 TaskTool 参数，支持 device_context 传递 |

### 8.2 TaskTool 扩展

```typescript
// src/tool/task.ts 扩展

export const Parameters = Schema.Struct({
  description: Schema.String,
  prompt: Schema.String,
  subagent_type: Schema.String,
  task_id: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
  // 新增：设备上下文
  device_context: Schema.optional(Schema.Struct({
    deviceID: DeviceID,
    deviceModel: Schema.String,
    androidVersion: Schema.String,
  })),
})
```

在 TaskTool 执行时，将 `device_context` 绑定到子会话：

```typescript
// 在 TaskTool.execute 中
if (params.device_context) {
  bindSessionToDevice(nextSession.id, params.device_context.deviceID)
}
```

### 8.3 Bus 事件增强

在 Bus 发布事件时，自动注入设备上下文：

```typescript
// 在 Bus.publish 中增强
function publish<D extends BusEvent.Definition>(def: D, properties: BusProperties<D>, options?: { id?: string }) {
  return Effect.gen(function* () {
    const payload: Payload = { id: options?.id ?? createID(), type: def.type, properties }

    // 增强设备上下文
    if (payload.properties.sessionID) {
      const deviceID = getDeviceForSession(payload.properties.sessionID)
      if (deviceID) {
        payload.properties._deviceID = deviceID
      }
    }

    // 发布到 StreamRouter
    yield* StreamRouter.publish({
      source: {
        sessionID: payload.properties.sessionID,
        parentSessionID: payload.properties.parentID,
        deviceID: payload.properties._deviceID,
      },
      event: payload,
    })

    // 原有发布逻辑
    const s = yield* InstanceState.get(state)
    const ps = s.typed.get(def.type)
    if (ps) yield* PubSub.publish(ps, payload)
    yield* PubSub.publish(s.wildcard, payload)
    GlobalBus.emit("event", { directory, project, workspace, payload })
  })
}
```

---

## 9. API 接口汇总

### 9.1 设备管理 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/device` | 列出所有设备 |
| GET | `/api/device/:deviceID` | 获取设备详情 |
| POST | `/api/device/refresh` | 刷新设备列表 |
| GET | `/api/device/report` | 获取设备上报数据 |

### 9.2 任务管理 API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/task/submit` | 提交任务 |
| GET | `/api/task/:taskID/status` | 查询任务状态 |

### 9.3 流订阅 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/stream/session/:sessionID` | SSE 订阅子 Agent 输出 |
| GET | `/api/stream/device/:deviceID` | SSE 订阅设备相关流 |
| GET | `/api/stream/all` | SSE 订阅所有流 |

### 9.4 现有 API（保持兼容）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/event` | 全局 SSE 事件流（增强设备上下文） |
| POST | `/api/session/:sessionID/prompt` | 发送消息（兼容 V2） |
| GET | `/api/session` | 列出会话 |

---

## 10. 部署与运维

### 10.1 环境要求

- Node.js >= 20 或 Bun >= 1.1
- Android SDK Platform Tools（adb 命令可用）
- 网络可达上游任务调度系统

### 10.2 启动命令

```bash
opencode serve --port 4096 --hostname 0.0.0.0 --task-server
```

### 10.3 健康检查

```typescript
// 新增健康检查端点
GET /api/health
Response: {
  status: "ok",
  uptime: number,
  devices: { online: number, offline: number },
  activeSessions: number,
  trackerStatus: "ok" | "degraded" | "disabled"
}
```

### 10.4 监控指标

- 设备在线率
- 任务接收/完成/失败数
- 子 Agent 平均执行时间
- LLM Token 消耗
- 流订阅数
- 打点上报延迟

---

## 11. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| ADB 连接不稳定 | 设备状态误报 | 增加重试和心跳检测，设备状态变更需连续 2 次确认 |
| 子 Agent 并行数过多 | LLM API 限流 | 实现并发控制队列，限制同时运行的子 Agent 数量 |
| 流消费者过多 | 内存压力 | 限制每设备最大订阅数，实现背压机制 |
| 打点数据丢失 | 运营数据不完整 | 本地缓冲 + 批量上报 + 重试机制 |
| 上游系统不可用 | 任务无法接收 | 本地任务队列，支持离线模式 |

---

## 12. 开发优先级建议

| 阶段 | 内容 | 预计工作量 |
|------|------|-----------|
| P0 | Tracker 接口定义 + NoOp 实现 | 1 天 |
| P0 | DeviceRegistry + ADB Scanner | 2 天 |
| P1 | Dispatcher Agent + Device Operator Agent | 2 天 |
| P1 | 设备操作工具集（ADB/Install/Screencap/UI/Logcat） | 3 天 |
| P1 | Task 提交/状态 API | 1 天 |
| P2 | StreamRouter + 流订阅 API | 2 天 |
| P2 | 设备上报 + 回调模式 | 1 天 |
| P3 | Tracker 远程后端 + 中间件 | 2 天 |
| P3 | 配置系统完善 + 健康检查 | 1 天 |
