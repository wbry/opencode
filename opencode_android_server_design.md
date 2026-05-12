# OpenCode 安卓设备管理服务器架构设计

## 1. 概述

本设计文档详细说明了如何将 OpenCode 改造为一个承接上游任务的服务器，主要包含两个核心功能：
1. **安卓设备管理模块**：能够发现、监控和上报本地连接的安卓设备
2. **任务分配代理架构**：主代理能够为单台设备分配子 Agent 进行设备操作相关任务

## 2. 现有架构分析

### 2.1 核心模块
OpenCode 已经具备完整的服务端架构，包括：
- **HTTP API Server**：提供 RESTful 接口服务
- **Agent 系统**：支持主代理和子代理模式
- **Session 系统**：完整的会话管理
- **Websocket 支持**：实时通信
- **数据库存储**：基于 Drizzle ORM

### 2.2 关键现有功能
- 已有的 Agent 管理 ([`agent/agent.ts`](file:///workspace/packages/opencode/src/agent/agent.ts))
- HTTP API 服务器 ([`server/server.ts`](file:///workspace/packages/opencode/src/server/server.ts))
- 服务发现支持 (mDNS)
- WebSocket 跟踪器

## 3. 总体架构设计

```
┌─────────────────────────────────────────────────────────────┐
│                      上游任务系统                             │
└────────────────────────────┬────────────────────────────────┘
                             │
                             │ HTTP/WebSocket API
                             │
┌────────────────────────────▼────────────────────────────────┐
│                   OpenCode 任务分配代理层                      │
│  ┌───────────────────────────────────────────────────────┐  │
│  │            任务分配器 (Task Orchestrator)             │  │
│  └───────────────────────────────────────────────────────┘  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │  设备管理器   │  │  Agent 池    │  │  Session 管理 │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
└────────────────────────────┬────────────────────────────────┘
                             │
                             │
            ┌────────────────┴────────────────┐
            │                                 │
┌───────────▼───────────┐        ┌───────────▼───────────┐
│   Android Device 1    │  ...   │   Android Device N    │
│  ┌─────────────────┐  │        │  ┌─────────────────┐  │
│  │  Device Agent 1 │  │        │  │  Device Agent N │  │
│  └─────────────────┘  │        │  └─────────────────┘  │
└───────────────────────┘        └───────────────────────┘
```

## 4. 安卓设备管理模块设计

### 4.1 模块架构
```
android-device-manager/
├── core/
│   ├── device-detector.ts      # 设备发现 (adb 集成)
│   ├── device-monitor.ts       # 设备状态监控
│   └── device-info.ts          # 设备信息模型
├── storage/
│   ├── device-schema.sql.ts    # 数据库 schema
│   └── device-repo.ts          # 设备仓库
├── service/
│   ├── device-service.ts       # 设备管理服务
│   └── device-reporting.ts     # 设备上报服务
├── api/
│   ├── device-api.ts           # HTTP API 定义
│   └── device-handlers.ts      # API 处理逻辑
└── types.ts                    # 类型定义
```

### 4.2 数据模型

```typescript
// 设备状态
export type DeviceStatus = "connected" | "disconnected" | "offline" | "busy" | "idle"

// 设备信息
export interface AndroidDevice {
  id: string                    // 设备唯一 ID (serial)
  name?: string                // 设备名称
  model?: string               // 设备型号
  brand?: string               // 品牌
  androidVersion?: string      // Android 版本
  apiLevel?: number            // API 级别
  status: DeviceStatus         // 当前状态
  ipAddress?: string           // IP 地址
  port?: number                // 端口 (用于网络连接)
  lastSeen: Date               // 最后在线时间
  tags: string[]               // 设备标签
  capabilities: string[]       // 设备能力
  currentTaskId?: string       // 当前执行的任务 ID
  currentAgentId?: string      // 当前分配的 Agent ID
  createdAt: Date
  updatedAt: Date
}

// 设备事件
export interface DeviceEvent {
  id: string
  deviceId: string
  type: "connected" | "disconnected" | "status_changed" | "info_updated"
  timestamp: Date
  data: Record<string, unknown>
}
```

### 4.3 核心功能

#### 4.3.1 设备发现
- 使用 ADB (Android Debug Bridge) 命令检测连接设备
- 支持 USB 连接和网络连接的设备
- 定期扫描和自动发现
- 设备信息自动获取（型号、版本等）

```typescript
// 设备检测器核心接口
export interface DeviceDetector {
  // 扫描并获取所有连接的设备
  scanDevices(): Effect.Effect<AndroidDevice[]>
  // 监听设备连接/断开事件
  watchDevices(callback: (devices: AndroidDevice[]) => void): Effect.Effect<void>
  // 获取设备详细信息
  getDeviceInfo(serial: string): Effect.Effect<AndroidDevice>
}
```

#### 4.3.2 设备监控
- 持续监控设备状态变化
- 心跳检测
- 设备性能指标收集
- 事件通知系统

#### 4.3.3 设备上报
- 向上游系统报告设备状态
- 支持事件驱动上报和定期上报
- 支持自定义上报格式

### 4.4 数据库 Schema

```typescript
// packages/opencode/src/android-device-manager/storage/device-schema.sql.ts
import { sqliteTable, text, integer, blob, index } from "drizzle-orm/sqlite-core"

export const AndroidDeviceTable = sqliteTable("android_device", {
  id: text("id").primaryKey(),
  name: text("name"),
  model: text("model"),
  brand: text("brand"),
  androidVersion: text("android_version"),
  apiLevel: integer("api_level"),
  status: text("status", { enum: ["connected", "disconnected", "offline", "busy", "idle"] }).notNull(),
  ipAddress: text("ip_address"),
  port: integer("port"),
  lastSeen: integer("last_seen", { mode: "timestamp_ms" }).notNull(),
  tags: blob("tags", { mode: "json" }).$type<string[]>(),
  capabilities: blob("capabilities", { mode: "json" }).$type<string[]>(),
  currentTaskId: text("current_task_id"),
  currentAgentId: text("current_agent_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  index("idx_device_status").on(table.status),
  index("idx_device_last_seen").on(table.lastSeen),
])

export const DeviceEventTable = sqliteTable("device_event", {
  id: text("id").primaryKey(),
  deviceId: text("device_id").notNull(),
  type: text("type", { enum: ["connected", "disconnected", "status_changed", "info_updated"] }).notNull(),
  timestamp: integer("timestamp", { mode: "timestamp_ms" }).notNull(),
  data: blob("data", { mode: "json" }),
}, (table) => [
  index("idx_event_device").on(table.deviceId),
  index("idx_event_timestamp").on(table.timestamp),
])
```

### 4.5 HTTP API 设计

```typescript
// 新增 API 端点
// GET /api/v1/android-devices - 获取设备列表
// GET /api/v1/android-devices/:id - 获取单个设备
// POST /api/v1/android-devices/:id/assign - 分配任务
// POST /api/v1/android-devices/:id/release - 释放设备
// GET /api/v1/android-devices/:id/events - 获取设备事件
// POST /api/v1/android-devices/:id/refresh - 刷新设备信息
```

## 5. 任务分配代理架构设计

### 5.1 架构概览

```
上游任务请求
    │
    ▼
┌─────────────────────────────────────┐
│    Task Orchestrator (主代理)       │
│  ┌───────────────────────────────┐ │
│  │  1. 任务解析和验证            │ │
│  │  2. 设备选择策略              │ │
│  │  3. Agent 分配和管理          │ │
│  │  4. 任务状态跟踪              │ │
│  └───────────────────────────────┘ │
└────────────────┬────────────────────┘
                 │
         ┌───────┴───────┐
         │               │
         ▼               ▼
    ┌─────────┐     ┌─────────┐
    │ Agent A │ ... │ Agent N │
    │(Device1)│     │(DeviceN)│
    └────┬────┘     └────┬────┘
         │               │
         └───────┬───────┘
                 │
         ┌───────▼───────┐
         │   设备操作层   │
         └───────────────┘
```

### 5.2 核心组件

#### 5.2.1 任务模型

```typescript
export interface AndroidTask {
  id: string
  type: "device_interaction" | "app_install" | "test_execution" | "custom"
  description: string
  deviceId?: string  // 指定设备，可选
  requirements: {
    minAndroidVersion?: string
    requiredTags?: string[]
    requiredCapabilities?: string[]
  }
  status: "pending" | "assigned" | "in_progress" | "completed" | "failed" | "cancelled"
  agentId?: string
  result?: any
  error?: string
  createdAt: Date
  startedAt?: Date
  completedAt?: Date
}
```

#### 5.2.2 任务编排器 (Task Orchestrator)

```typescript
export interface TaskOrchestrator {
  // 提交新任务
  submitTask(task: Omit<AndroidTask, "id" | "status" | "createdAt">): Effect.Effect<AndroidTask>

  // 取消任务
  cancelTask(taskId: string): Effect.Effect<void>

  // 获取任务状态
  getTask(taskId: string): Effect.Effect<AndroidTask>

  // 列出所有任务
  listTasks(filters?: { status?: string; deviceId?: string }): Effect.Effect<AndroidTask[]>

  // 选择合适的设备
  selectDevice(requirements: AndroidTask["requirements"]): Effect.Effect<AndroidDevice | null>

  // 为任务分配 Agent
  assignAgentToTask(taskId: string, deviceId: string): Effect.Effect<void>
}
```

#### 5.2.3 设备专用 Agent

创建专用的设备操作 Agent，具有以下特点：
- 预配置的设备操作权限
- 内置 ADB 工具集成
- 设备状态感知
- 任务执行报告

```typescript
// Agent 配置示例
const deviceAgentConfig = {
  name: "device-operator",
  description: "Android device operation agent",
  mode: "subagent",
  permission: {
    // 允许执行设备操作相关工具
    "*": "allow",
  },
  // 自定义工具集
  customTools: [
    // ADB 操作工具
    // 截图工具
    // 应用安装工具
    // 测试执行工具
  ],
}
```

### 5.3 工作流程

1. **任务接收**：上游系统通过 API 提交任务
2. **设备选择**：根据任务要求选择合适的可用设备
3. **Agent 分配**：为任务创建设备专用 Agent
4. **任务执行**：Agent 在设备上执行操作
5. **状态更新**：实时更新任务和设备状态
6. **结果报告**：任务完成后向上游报告结果

### 5.4 扩展现有 Agent 系统

在现有 Agent 系统基础上扩展：
- 支持任务绑定到特定设备
- Agent 生命周期与任务关联
- 设备状态与 Agent 状态同步

## 6. HTTP API 扩展设计

### 6.1 新增 API 组

```typescript
// packages/opencode/src/android-device-manager/api/device-api.ts
import { HttpApi } from "effect/unstable/httpapi"
import { Schema } from "effect"

export const AndroidDeviceApi = HttpApi.make("android-devices")
  // 设备管理
  .add(HttpApi.get("listDevices", "/devices").addSuccess(Schema.Array(DeviceSchema)))
  .add(HttpApi.get("getDevice", "/devices/:id").addSuccess(DeviceSchema))
  .add(HttpApi.post("refreshDevice", "/devices/:id/refresh").addSuccess(DeviceSchema))
  .add(HttpApi.post("assignDevice", "/devices/:id/assign")
    .addPayload(Schema.Struct({ taskId: Schema.String }))
    .addSuccess(DeviceSchema))
  .add(HttpApi.post("releaseDevice", "/devices/:id/release").addSuccess(DeviceSchema))

  // 设备事件
  .add(HttpApi.get("listDeviceEvents", "/devices/:id/events").addSuccess(Schema.Array(DeviceEventSchema)))

  // 任务管理
  .add(HttpApi.get("listTasks", "/tasks").addSuccess(Schema.Array(TaskSchema)))
  .add(HttpApi.get("getTask", "/tasks/:id").addSuccess(TaskSchema))
  .add(HttpApi.post("submitTask", "/tasks")
    .addPayload(SubmitTaskSchema)
    .addSuccess(TaskSchema))
  .add(HttpApi.post("cancelTask", "/tasks/:id/cancel").addSuccess(TaskSchema))
```

### 6.2 WebSocket 事件

```typescript
// 新增 WebSocket 事件类型
export type ServerEvent = 
  | { type: "device_connected"; device: AndroidDevice }
  | { type: "device_disconnected"; deviceId: string }
  | { type: "device_status_changed"; deviceId: string; status: DeviceStatus }
  | { type: "task_created"; task: AndroidTask }
  | { type: "task_updated"; task: AndroidTask }
  | { type: "task_completed"; task: AndroidTask }
```

## 7. 实施步骤

### 阶段一：基础架构
1. 创建安卓设备管理模块目录结构
2. 实现设备检测核心功能 (ADB 集成)
3. 实现设备数据模型和存储
4. 实现基础的设备管理服务

### 阶段二：API 集成
1. 创建 HTTP API 端点
2. 实现 API 处理程序
3. 集成到现有 OpenCode API 系统
4. 实现 WebSocket 事件推送

### 阶段三：任务分配系统
1. 实现任务模型和存储
2. 实现任务编排器
3. 创建设备专用 Agent
4. 实现任务-设备-Agent 绑定逻辑

### 阶段四：测试和优化
1. 单元测试和集成测试
2. 性能优化
3. 文档完善
4. 部署配置

## 8. 技术考虑

### 8.1 依赖项
- `adbkit` 或直接 ADB 命令调用（用于设备交互）
- 保持现有技术栈（Effect、Drizzle、TypeScript）

### 8.2 安全考虑
- 设备操作权限控制
- API 访问认证（复用现有认证机制）
- 敏感信息保护

### 8.3 扩展性
- 支持设备插件系统
- 支持自定义 Agent 模板
- 支持自定义任务类型

## 9. 总结

本设计方案通过以下方式实现了需求：
1. 新增独立的安卓设备管理模块，负责设备发现、监控和上报
2. 扩展现有 Agent 系统，实现任务分配代理功能
3. 通过 HTTP API 和 WebSocket 提供完整的接口
4. 保持与现有 OpenCode 架构的兼容性
5. 提供清晰的扩展路径

该设计充分利用了 OpenCode 现有的架构优势，特别是 Agent 系统、HTTP API 服务器和 Session 管理等功能，在此基础上进行最小化的改动和扩展。
