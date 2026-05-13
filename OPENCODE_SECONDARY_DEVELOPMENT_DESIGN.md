# Opencode 二次开发设计文档

## 概述

本文档详细描述了如何在保持 Opencode 原有架构完整性的前提下，进行二次开发，将其改造为一个能够承接上游任务的服务器平台。该平台将具备设备管理、任务分配代理、子代理输出流分发和预留运营打点模块等功能。

---

## 1. 总体设计

### 1.1 设计目标

- **保持原有架构**：不破坏 Opencode 现有的核心架构，通过可插拔的方式扩展功能
- **设备管理**：支持本地连接设备的自动发现、上报和管理
- **任务分配**：提供主代理功能，能够将任务分配给特定设备上的子代理
- **输出流分发**：支持子代理输出流的独立分发和管理
- **预留模块**：为运营打点等功能预留接口

### 1.2 架构设计

采用插件化架构，所有新增功能均通过 Plugin 机制实现，确保对原有代码的最小侵入。

```
┌─────────────────────────────────────────────────────────────────┐
│                         上游任务系统                              │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Opencode Server 扩展层                        │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Device Management Plugin (设备管理插件)                  │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │   │
│  │  │ 设备发现器   │  │ 设备管理器   │  │ 设备上报器   │  │   │
│  │  └──────────────┘  └──────────────┘  └──────────────┘  │   │
│  └─────────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Task Assignment Agent (任务分配代理)                    │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │   │
│  │  │ 任务接收器   │  │ 设备分配器   │  │ 会话管理器   │  │   │
│  │  └──────────────┘  └──────────────┘  └──────────────┘  │   │
│  └─────────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Output Stream Distributor (输出流分发器)                 │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │   │
│  │  │ 流监听       │  │ 流分发       │  │ 流管理       │  │   │
│  │  └──────────────┘  └──────────────┘  └──────────────┘  │   │
│  └─────────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Analytics Hook (预留运营打点模块)                       │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │   │
│  │  │ 事件监听     │  │ 数据收集     │  │ 数据上报     │  │   │
│  │  └──────────────┘  └──────────────┘  └──────────────┘  │   │
│  └─────────────────────────────────────────────────────────┘   │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Opencode 核心服务层                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
│  │  HTTP API    │  │  Session     │  │  Agent       │         │
│  │  服务        │  │  管理        │  │  系统        │         │
│  └──────────────┘  └──────────────┘  └──────────────┘         │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                         设备层                                    │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐       │
│  │ Android  │  │ Harmony  │  │   iOS    │  │ 其他设备  │       │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘       │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. 模块设计

### 2.1 设备管理插件 (Device Management Plugin)

#### 2.1.1 模块概述

设备管理插件负责发现、管理和上报本地连接的设备，支持 Android、鸿蒙 (Harmony)、iOS 等多种平台。

#### 2.1.2 核心组件

```typescript
// packages/opencode/src/plugin/device-management/types.ts
import { Schema } from "effect"

// 设备类型枚举
export const DeviceType = Schema.Literal("android", "harmony", "ios", "other")
export type DeviceType = Schema.Schema.Type<typeof DeviceType>

// 设备状态枚举
export const DeviceStatus = Schema.Literal("available", "busy", "offline", "error")
export type DeviceStatus = Schema.Schema.Type<typeof DeviceStatus>

// 设备信息结构
export const DeviceInfo = Schema.Struct({
  id: Schema.String, // 唯一设备标识
  type: DeviceType,
  status: DeviceStatus,
  name: Schema.String,
  model: Schema.String,
  osVersion: Schema.String,
  serialNumber: Schema.String,
  connectedAt: Schema.Number,
  lastSeen: Schema.Number,
  extra: Schema.Record({ key: Schema.String, value: Schema.Unknown })
})
export type DeviceInfo = Schema.Schema.Type<typeof DeviceInfo>

// 设备事件类型
export const DeviceEventType = Schema.Literal(
  "device.discovered",
  "device.connected",
  "device.disconnected",
  "device.status_changed",
  "device.error"
)
export type DeviceEventType = Schema.Schema.Type<typeof DeviceEventType>
```

#### 2.1.3 设备发现器 (Device Discoverer)

负责自动发现本地连接的设备，支持多种平台的设备识别。

```typescript
// packages/opencode/src/plugin/device-management/discoverer.ts
import { Effect, Layer, Context, Schedule, Stream } from "effect"
import { DeviceInfo, DeviceType } from "./types"

export interface DeviceDiscoverer {
  readonly discover: () => Effect.Effect<DeviceInfo[]>
  readonly watch: () => Stream.Stream<DeviceInfo>
}

export class DeviceDiscoverer extends Context.Tag("DeviceDiscoverer")<
  DeviceDiscoverer,
  DeviceDiscoverer
>() {}

// Android 设备发现实现
export const AndroidDiscovererLive = Layer.effect(
  DeviceDiscoverer,
  Effect.gen(function* () {
    // 使用 adb 命令发现 Android 设备
    // 实现略
  })
)

// iOS 设备发现实现
export const iOSDiscovererLive = Layer.effect(
  DeviceDiscoverer,
  Effect.gen(function* () {
    // 使用 libimobiledevice 发现 iOS 设备
    // 实现略
  })
)

// 鸿蒙设备发现实现
export const HarmonyDiscovererLive = Layer.effect(
  DeviceDiscoverer,
  Effect.gen(function* () {
    // 使用 hdc 命令发现鸿蒙设备
    // 实现略
  })
)
```

#### 2.1.4 设备管理器 (Device Manager)

负责设备的生命周期管理，包括设备的注册、状态更新、查询等功能。

```typescript
// packages/opencode/src/plugin/device-management/manager.ts
import { Effect, Layer, Context, Schedule } from "effect"
import { DeviceInfo, DeviceStatus, DeviceEventType } from "./types"
import { BusEvent } from "@/bus/bus-event"

// 定义设备事件
export const DeviceEvent = BusEvent.define(
  "device.event",
  Schema.Struct({
    type: DeviceEventType,
    deviceId: Schema.String,
    device: Schema.optional(DeviceInfo),
    previousStatus: Schema.optional(DeviceStatus),
    error: Schema.optional(Schema.String)
  })
)

export interface DeviceManager {
  readonly register: (device: DeviceInfo) => Effect.Effect<void>
  readonly unregister: (deviceId: string) => Effect.Effect<void>
  readonly updateStatus: (deviceId: string, status: DeviceStatus) => Effect.Effect<void>
  readonly get: (deviceId: string) => Effect.Effect<DeviceInfo | undefined>
  readonly list: () => Effect.Effect<DeviceInfo[]>
  readonly listByStatus: (status: DeviceStatus) => Effect.Effect<DeviceInfo[]>
}

export class DeviceManager extends Context.Tag("DeviceManager")<
  DeviceManager,
  DeviceManager
>() {}

export const DeviceManagerLive = Layer.effect(
  DeviceManager,
  Effect.gen(function* () {
    // 设备管理器实现，使用内存存储或数据库存储
    // 实现略
  })
)
```

#### 2.1.5 设备上报器 (Device Reporter)

负责将设备信息上报给上游系统。

```typescript
// packages/opencode/src/plugin/device-management/reporter.ts
import { Effect, Layer, Context, Schedule } from "effect"
import { DeviceInfo } from "./types"

export interface DeviceReporterConfig {
  readonly endpoint: string
  readonly reportInterval: number
  readonly enabled: boolean
}

export interface DeviceReporter {
  readonly report: (devices: DeviceInfo[]) => Effect.Effect<void>
  readonly reportSingle: (device: DeviceInfo) => Effect.Effect<void>
  readonly startAutoReport: () => Effect.Effect<void>
  readonly stopAutoReport: () => Effect.Effect<void>
}

export class DeviceReporter extends Context.Tag("DeviceReporter")<
  DeviceReporter,
  DeviceReporter
>() {}

export const DeviceReporterLive = (config: DeviceReporterConfig) =>
  Layer.effect(
    DeviceReporter,
    Effect.gen(function* () {
      // 设备上报器实现
      // 实现略
    })
  )
```

#### 2.1.6 插件入口

```typescript
// packages/opencode/src/plugin/device-management/index.ts
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { Layer, Effect } from "effect"
import { DeviceManager, DeviceManagerLive } from "./manager"
import { DeviceDiscoverer, AndroidDiscovererLive, iOSDiscovererLive, HarmonyDiscovererLive } from "./discoverer"
import { DeviceReporter, DeviceReporterLive } from "./reporter"

export default function deviceManagementPlugin(input: PluginInput): Hooks {
  const layer = Layer.mergeAll(
    DeviceManagerLive,
    // 根据平台选择合适的设备发现器
    // AndroidDiscovererLive,
    // iOSDiscovererLive,
    // HarmonyDiscovererLive,
  )

  return {
    async config(config) {
      // 初始化配置
    },
    async event({ event }) {
      // 监听相关事件
    },
    // 其他钩子
  }
}
```

---

### 2.2 任务分配代理 (Task Assignment Agent)

#### 2.2.1 模块概述

任务分配代理作为主代理，负责接收上游任务并将其分配给特定设备上的子代理执行。

#### 2.2.2 核心组件

```typescript
// packages/opencode/src/plugin/task-assignment/types.ts
import { Schema } from "effect"
import { DeviceInfo } from "../device-management/types"

// 任务状态
export const TaskStatus = Schema.Literal(
  "pending",
  "assigned",
  "running",
  "completed",
  "failed",
  "cancelled"
)
export type TaskStatus = Schema.Schema.Type<typeof TaskStatus>

// 任务信息
export const TaskInfo = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  description: Schema.String,
  payload: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  targetDeviceId: Schema.optional(Schema.String), // 可选的目标设备
  status: TaskStatus,
  assignedDeviceId: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.String)
})
export type TaskInfo = Schema.Schema.Type<typeof TaskInfo>

// 任务分配策略
export const AssignmentStrategy = Schema.Literal(
  "round_robin",
  "least_busy",
  "specific_device",
  "first_available"
)
export type AssignmentStrategy = Schema.Schema.Type<typeof AssignmentStrategy>
```

#### 2.2.3 任务接收器 (Task Receiver)

负责从上游系统接收任务。

```typescript
// packages/opencode/src/plugin/task-assignment/receiver.ts
import { Effect, Layer, Context } from "effect"
import { TaskInfo } from "./types"

export interface TaskReceiver {
  readonly receive: () => Effect.Effect<TaskInfo | null>
  readonly start: () => Effect.Effect<void>
  readonly stop: () => Effect.Effect<void>
}

export class TaskReceiver extends Context.Tag("TaskReceiver")<
  TaskReceiver,
  TaskReceiver
>() {}

export const TaskReceiverLive = (endpoint: string) =>
  Layer.effect(
    TaskReceiver,
    Effect.gen(function* () {
      // 实现任务接收逻辑，支持轮询或 Webhook
      // 实现略
    })
  )
```

#### 2.2.4 设备分配器 (Device Assigner)

负责将任务分配给合适的设备。

```typescript
// packages/opencode/src/plugin/task-assignment/assigner.ts
import { Effect, Layer, Context } from "effect"
import { TaskInfo, AssignmentStrategy } from "./types"
import { DeviceInfo, DeviceManager } from "../device-management/manager"

export interface DeviceAssigner {
  readonly assign: (task: TaskInfo, strategy?: AssignmentStrategy) => Effect.Effect<DeviceInfo>
}

export class DeviceAssigner extends Context.Tag("DeviceAssigner")<
  DeviceAssigner,
  DeviceAssigner
>() {}

export const DeviceAssignerLive = Layer.effect(
  DeviceAssigner,
  Effect.gen(function* () {
    const deviceManager = yield* DeviceManager

    return {
      assign: (task: TaskInfo, strategy: AssignmentStrategy = "first_available") =>
        Effect.gen(function* () {
          // 实现设备分配策略
          // 实现略
        })
    }
  })
).pipe(Layer.provide(DeviceManagerLive))
```

#### 2.2.5 会话管理器 (Session Manager)

负责管理子代理会话，创建和监控在特定设备上运行的子代理。

```typescript
// packages/opencode/src/plugin/task-assignment/session-manager.ts
import { Effect, Layer, Context } from "effect"
import { TaskInfo } from "./types"
import { DeviceInfo } from "../device-management/types"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"

export interface SessionManager {
  readonly createSubagentSession: (task: TaskInfo, device: DeviceInfo) => Effect.Effect<string>
  readonly sendTaskToSession: (sessionId: string, task: TaskInfo) => Effect.Effect<void>
  readonly monitorSession: (sessionId: string) => Effect.Effect<void>
  readonly closeSession: (sessionId: string) => Effect.Effect<void>
}

export class SessionManager extends Context.Tag("SessionManager")<
  SessionManager,
  SessionManager
>() {}

export const SessionManagerLive = Layer.effect(
  SessionManager,
  Effect.gen(function* () {
    // 实现会话管理逻辑，利用 Opencode 原有的 Agent 和 Session 系统
    // 实现略
  })
)
```

---

### 2.3 输出流分发器 (Output Stream Distributor)

#### 2.3.1 模块概述

输出流分发器负责监听子代理的输出流，并将其独立分发到不同的消费者。

#### 2.3.2 核心组件

```typescript
// packages/opencode/src/plugin/output-stream/types.ts
import { Schema } from "effect"

// 流类型
export const StreamType = Schema.Literal("stdout", "stderr", "events", "tools")
export type StreamType = Schema.Schema.Type<typeof StreamType>

// 流数据
export const StreamData = Schema.Struct({
  sessionId: Schema.String,
  taskId: Schema.String,
  type: StreamType,
  timestamp: Schema.Number,
  content: Schema.String,
  metadata: Schema.Record({ key: Schema.String, value: Schema.Unknown })
})
export type StreamData = Schema.Schema.Type<typeof StreamData>

// 流消费者配置
export const StreamConsumerConfig = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("webhook", "websocket", "file", "internal"),
  endpoint: Schema.optional(Schema.String),
  filter: Schema.optional(
    Schema.Struct({
      sessionIds: Schema.optional(Schema.Array(Schema.String)),
      taskIds: Schema.optional(Schema.Array(Schema.String)),
      streamTypes: Schema.optional(Schema.Array(StreamType))
    })
  )
})
export type StreamConsumerConfig = Schema.Schema.Type<typeof StreamConsumerConfig>
```

#### 2.3.3 流监听器 (Stream Listener)

```typescript
// packages/opencode/src/plugin/output-stream/listener.ts
import { Effect, Layer, Context, Stream } from "effect"
import { StreamData } from "./types"
import { Bus } from "@/bus"

export interface StreamListener {
  readonly listen: () => Stream.Stream<StreamData>
  readonly listenToSession: (sessionId: string) => Stream.Stream<StreamData>
}

export class StreamListener extends Context.Tag("StreamListener")<
  StreamListener,
  StreamListener
>() {}

export const StreamListenerLive = Layer.effect(
  StreamListener,
  Effect.gen(function* () {
    const bus = yield* Bus.Service

    return {
      listen: () =>
        // 通过 Bus 监听会话输出事件
        Stream.empty, // 实现略
      listenToSession: (sessionId: string) =>
        Stream.empty // 实现略
    }
  })
)
```

#### 2.3.4 流分发器 (Stream Distributor)

```typescript
// packages/opencode/src/plugin/output-stream/distributor.ts
import { Effect, Layer, Context, Stream } from "effect"
import { StreamData, StreamConsumerConfig } from "./types"
import { StreamListener } from "./listener"

export interface StreamDistributor {
  readonly registerConsumer: (config: StreamConsumerConfig) => Effect.Effect<void>
  readonly unregisterConsumer: (consumerId: string) => Effect.Effect<void>
  readonly start: () => Effect.Effect<void>
  readonly stop: () => Effect.Effect<void>
}

export class StreamDistributor extends Context.Tag("StreamDistributor")<
  StreamDistributor,
  StreamDistributor
>() {}

export const StreamDistributorLive = Layer.effect(
  StreamDistributor,
  Effect.gen(function* () {
    const listener = yield* StreamListener

    // 实现流分发逻辑
    // 实现略
  })
).pipe(Layer.provide(StreamListenerLive))
```

---

### 2.4 运营打点模块 (Analytics Hook)

#### 2.4.1 模块概述

预留运营打点模块，提供统一的事件打点接口，便于后续接入数据分析系统。

#### 2.4.2 核心组件

```typescript
// packages/opencode/src/plugin/analytics/types.ts
import { Schema } from "effect"

// 打点事件类型
export const AnalyticsEventType = Schema.Literal(
  "task.received",
  "task.assigned",
  "task.started",
  "task.completed",
  "task.failed",
  "device.connected",
  "device.disconnected",
  "session.created",
  "session.closed",
  "stream.delivered"
)
export type AnalyticsEventType = Schema.Schema.Type<typeof AnalyticsEventType>

// 打点事件
export const AnalyticsEvent = Schema.Struct({
  id: Schema.String,
  type: AnalyticsEventType,
  timestamp: Schema.Number,
  properties: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  sessionId: Schema.optional(Schema.String),
  taskId: Schema.optional(Schema.String),
  deviceId: Schema.optional(Schema.String)
})
export type AnalyticsEvent = Schema.Schema.Type<typeof AnalyticsEvent>
```

#### 2.4.3 打点接口

```typescript
// packages/opencode/src/plugin/analytics/index.ts
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { Effect, Layer, Context } from "effect"
import { AnalyticsEvent, AnalyticsEventType } from "./types"
import { BusEvent } from "@/bus/bus-event"

// 定义分析事件
export const AnalyticsBusEvent = BusEvent.define(
  "analytics.event",
  AnalyticsEvent
)

export interface Analytics {
  readonly track: (event: Omit<AnalyticsEvent, "id" | "timestamp">) => Effect.Effect<void>
  readonly trackSimple: (
    type: AnalyticsEventType,
    properties?: Record<string, unknown>
  ) => Effect.Effect<void>
  readonly flush: () => Effect.Effect<void>
}

export class Analytics extends Context.Tag("Analytics")<
  Analytics,
  Analytics
>() {}

export const AnalyticsLive = Layer.effect(
  Analytics,
  Effect.gen(function* () {
    return {
      track: (event) =>
        Effect.gen(function* () {
          // 实现打点逻辑
          // 实现略
        }),
      trackSimple: (type, properties = {}) =>
        Effect.gen(function* () {
          // 实现简化打点
          // 实现略
        }),
      flush: () => Effect.void
    }
  })
)

export default function analyticsPlugin(input: PluginInput): Hooks {
  return {
    async event({ event }) {
      // 自动监听相关事件并打点
    },
    // 其他钩子
  }
}
```

---

### 2.5 HTTP API 扩展

为了支持上述功能，需要扩展 Opencode 的 HTTP API。

```typescript
// packages/opencode/src/server/routes/instance/httpapi/groups/device.ts
import { HttpApi } from "effect/httpapi"
import { Schema } from "effect"
import { DeviceInfo, DeviceStatus, DeviceType } from "../../../../plugin/device-management/types"

export const DeviceApi = HttpApi.group("Device").pipe(
  HttpApi.add(
    HttpApi.get("listDevices", "/devices").pipe(
      HttpApi.setResponseBody(Schema.Array(DeviceInfo))
    )
  ),
  HttpApi.add(
    HttpApi.get("getDevice", "/devices/:id").pipe(
      HttpApi.setPath(Schema.Struct({ id: Schema.String })),
      HttpApi.setResponseBody(DeviceInfo)
    )
  ),
  HttpApi.add(
    HttpApi.patch("updateDeviceStatus", "/devices/:id/status").pipe(
      HttpApi.setPath(Schema.Struct({ id: Schema.String })),
      HttpApi.setRequestBody(Schema.Struct({ status: DeviceStatus })),
      HttpApi.setResponseBody(DeviceInfo)
    )
  )
)

// packages/opencode/src/server/routes/instance/httpapi/groups/task.ts
import { HttpApi } from "effect/httpapi"
import { Schema } from "effect"
import { TaskInfo, TaskStatus, AssignmentStrategy } from "../../../../plugin/task-assignment/types"

export const TaskApi = HttpApi.group("Task").pipe(
  HttpApi.add(
    HttpApi.post("submitTask", "/tasks").pipe(
      HttpApi.setRequestBody(
        Schema.Struct({
          type: Schema.String,
          description: Schema.String,
          payload: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
          targetDeviceId: Schema.optional(Schema.String),
          strategy: Schema.optional(AssignmentStrategy)
        })
      ),
      HttpApi.setResponseBody(TaskInfo)
    )
  ),
  HttpApi.add(
    HttpApi.get("getTask", "/tasks/:id").pipe(
      HttpApi.setPath(Schema.Struct({ id: Schema.String })),
      HttpApi.setResponseBody(TaskInfo)
    )
  ),
  HttpApi.add(
    HttpApi.get("listTasks", "/tasks").pipe(
      HttpApi.setRequestQuery(
        Schema.Struct({
          status: Schema.optional(TaskStatus),
          deviceId: Schema.optional(Schema.String)
        })
      ),
      HttpApi.setResponseBody(Schema.Array(TaskInfo))
    )
  ),
  HttpApi.add(
    HttpApi.post("cancelTask", "/tasks/:id/cancel").pipe(
      HttpApi.setPath(Schema.Struct({ id: Schema.String })),
      HttpApi.setResponseBody(TaskInfo)
    )
  )
)
```

---

## 3. 集成方案

### 3.1 插件注册

在 `packages/opencode/src/plugin/index.ts` 中注册新插件：

```typescript
// 在 INTERNAL_PLUGINS 数组中添加
const INTERNAL_PLUGINS: PluginInstance[] = [
  CodexAuthPlugin,
  CopilotAuthPlugin,
  GitlabAuthPlugin,
  PoeAuthPlugin,
  CloudflareWorkersAuthPlugin,
  CloudflareAIGatewayAuthPlugin,
  AzureAuthPlugin,
  // 新增插件
  deviceManagementPlugin,
  taskAssignmentPlugin,
  outputStreamPlugin,
  analyticsPlugin,
]
```

### 3.2 API 路由集成

将新增的 API 路由集成到主 API 中：

```typescript
// packages/opencode/src/server/routes/instance/httpapi/api.ts
import { DeviceApi } from "./groups/device"
import { TaskApi } from "./groups/task"

export const OpenCodeHttpApi = HttpApi.empty.pipe(
  // 原有 API
  HttpApi.addGroup(ConfigApi),
  // ...
  // 新增 API
  HttpApi.addGroup(DeviceApi),
  HttpApi.addGroup(TaskApi)
)
```

---

## 4. 配置管理

新增配置项，支持通过配置文件或环境变量控制各模块行为：

```typescript
// packages/opencode/src/config/config.ts
export const Config = Schema.Struct({
  // 原有配置
  // ...
  // 新增配置
  deviceManagement: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean),
      discoverInterval: Schema.optional(Schema.Number),
      reportEndpoint: Schema.optional(Schema.String),
      reportInterval: Schema.optional(Schema.Number)
    })
  ),
  taskAssignment: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean),
      defaultStrategy: Schema.optional(AssignmentStrategy),
      taskReceiveEndpoint: Schema.optional(Schema.String)
    })
  ),
  outputStream: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean),
      consumers: Schema.optional(Schema.Array(StreamConsumerConfig))
    })
  ),
  analytics: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean),
      endpoint: Schema.optional(Schema.String),
      batchSize: Schema.optional(Schema.Number),
      flushInterval: Schema.optional(Schema.Number)
    })
  )
})
```

---

## 5. 实施计划

### 阶段 1: 基础框架搭建
- 创建插件基础结构
- 定义核心类型和接口
- 集成到现有架构

### 阶段 2: 设备管理模块
- 实现设备发现器（支持 Android/iOS/Harmony）
- 实现设备管理器
- 实现设备上报器

### 阶段 3: 任务分配模块
- 实现任务接收器
- 实现设备分配器
- 实现会话管理器

### 阶段 4: 输出流分发模块
- 实现流监听器
- 实现流分发器
- 支持多种消费者类型

### 阶段 5: 运营打点模块
- 实现打点接口
- 集成到各个业务模块
- 支持批量上报

### 阶段 6: API 扩展和测试
- 扩展 HTTP API
- 编写单元测试
- 集成测试和性能测试

---

## 6. 总结

本设计方案通过插件化架构实现了 Opencode 的功能扩展，保持了原有架构的完整性。新增的四个模块（设备管理、任务分配、输出流分发、运营打点）相互协作，使 Opencode 能够作为一个强大的设备任务管理平台，承接上游任务并分配给多设备执行。

整个方案遵循可插拔设计原则，各个模块可以独立启用或禁用，便于维护和扩展。
