# Android 设备管理与任务分配系统

本项目扩展了 OpenCode 平台，添加了 Android 设备管理和任务分配功能，使 OpenCode 能够作为上游任务的承接服务器。

## 核心功能

### 1. Android 设备管理
- 设备注册与注销
- 设备状态管理（可用、忙碌、离线、断开连接）
- 设备心跳检测
- 设备列表查询
- 设备详细信息查询

### 2. 任务分配系统
- 任务创建与管理
- 任务状态跟踪（待处理、已分配、进行中、已完成、失败）
- 任务优先级排序
- 手动/自动任务分配
- 设备与子 Agent 绑定

## API 端点

### Android 设备管理 API
- `GET /android-devices` - 获取所有设备列表
- `GET /android-devices/:deviceId` - 获取单个设备详情
- `POST /android-devices/register` - 注册新设备
- `PUT /android-devices/:deviceId/status` - 更新设备状态
- `POST /android-devices/:deviceId/heartbeat` - 设备心跳
- `POST /android-devices/:deviceId/assign-agent` - 为设备分配 Agent
- `POST /android-devices/:deviceId/release-agent` - 释放设备上的 Agent
- `DELETE /android-devices/:deviceId` - 注销设备

### 任务分配 API
- `GET /tasks` - 获取所有任务列表
- `GET /tasks/:taskId` - 获取单个任务详情
- `POST /tasks` - 创建新任务
- `PUT /tasks/:taskId/status` - 更新任务状态
- `POST /tasks/:taskId/assign` - 手动分配任务
- `POST /tasks/auto-assign` - 自动分配待处理任务
- `DELETE /tasks/:taskId` - 删除任务

## 使用示例

### 1. 注册 Android 设备
```bash
curl -X POST http://localhost:4096/android-devices/register \
  -H "Content-Type: application/json" \
  -d '{
    "id": "device-serial-123",
    "model": "Pixel 6",
    "brand": "Google",
    "osVersion": "13",
    "status": "available",
    "capabilities": ["rooted", "wifi"]
  }'
```

### 2. 创建任务
```bash
curl -X POST http://localhost:4096/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "type": "ui-test",
    "description": "Run automated UI tests",
    "priority": "high"
  }'
```

### 3. 自动分配任务
```bash
curl -X POST http://localhost:4096/tasks/auto-assign \
  -H "Content-Type: application/json"
```

## 架构设计

### 模块结构
```
packages/opencode/
├── src/
│   ├── android-device/
│   │   ├── schema.ts           # 设备数据模型
│   │   └── android-device.ts   # 设备管理服务
│   ├── task-assignment/
│   │   ├── schema.ts           # 任务数据模型
│   │   └── task-assignment.ts  # 任务分配服务
│   └── server/
│       └── routes/instance/httpapi/
│           ├── groups/
│           │   ├── android-device.ts      # 设备 API 定义
│           │   └── task-assignment.ts     # 任务 API 定义
│           └── handlers/
│               ├── android-device.ts      # 设备 API 处理器
│               └── task-assignment.ts     # 任务 API 处理器
```

### 主要组件

1. **AndroidDevice 服务**：负责管理连接的 Android 设备
2. **TaskAssignment 服务**：负责任务的创建、分配和状态管理
3. **API 端点**：提供 RESTful API 供其他系统交互

## 工作流程

### 设备注册流程
1. Android 设备连接到服务器
2. 设备向 `/android-devices/register` 发送注册请求
3. 服务器存储设备信息并返回确认
4. 设备定期发送心跳以保持活跃状态

### 任务分配流程
1. 上游系统创建任务
2. 任务分配系统按优先级排序待处理任务
3. 自动分配功能查找可用设备
4. 为任务分配设备和子 Agent
5. 设备执行任务并更新状态

### 自动分配逻辑
- 按优先级排序待处理任务（高 > 中 > 低）
- 筛选状态为 "available" 的设备
- 依次为任务分配空闲设备
- 为每个设备创建对应的子 Agent
- 标记设备为 "busy" 状态
