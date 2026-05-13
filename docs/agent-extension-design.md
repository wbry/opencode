# OpenCode Agent 扩展设计文档

## 1. 概述

本文档描述如何在**不破坏 OpenCode 现有代码结构**的前提下，新增一个 **Primary Agent** 和一个 **Subagent**。设计原则是：**优先使用 OpenCode 已有的扩展机制（配置文件、Markdown Agent 文件），仅在必要时才修改核心代码，且修改方式应与现有模式一致，以便于后续合并 OpenCode 的持续演进。**

---

## 2. 现有架构分析

### 2.1 Agent 体系结构

OpenCode 的 Agent 系统由以下核心部分组成：

| 层级 | 文件 | 职责 |
|------|------|------|
| **Agent 定义** | [agent.ts](file:///workspace/packages/opencode/src/agent/agent.ts) | 定义 `Agent.Info` Schema、内置 Agent 列表（build/plan/general/explore/scout/compaction/title/summary）、`Agent.Service` 服务 |
| **Agent 配置** | [config/agent.ts](file:///workspace/packages/opencode/src/config/agent.ts) | 从 `.opencode/agent/*.md` 和 `.opencode/agents/*.md` 加载用户自定义 Agent，解析 frontmatter + markdown body |
| **Agent 权限** | [agent/subagent-permissions.ts](file:///workspace/packages/opencode/src/agent/subagent-permissions.ts) | 子 Agent 派生权限规则：继承父 Agent 的 deny 规则 + 父 Session 的 deny/external_directory 规则 |
| **Task 工具** | [tool/task.ts](file:///workspace/packages/opencode/src/tool/task.ts) | Subagent 的执行入口，通过 `TaskTool` 创建子 Session 并运行指定 Agent |
| **工具注册** | [tool/registry.ts](file:///workspace/packages/opencode/src/tool/registry.ts) | 注册所有内置工具，根据 Agent 权限过滤可用工具，动态生成 Task 工具描述（列出可用 subagent） |
| **系统提示** | [session/system.ts](file:///workspace/packages/opencode/src/session/system.ts) | 根据 model 选择系统提示模板，注入 skill 信息 |
| **全局配置** | [config/config.ts](file:///workspace/packages/opencode/src/config/config.ts) | `opencode.jsonc` 中的 `agent` 字段，可覆盖/新增 Agent 配置 |

### 2.2 Agent 类型

OpenCode 定义了三种 Agent 模式（`mode`）：

- **`primary`**：主 Agent，用户直接交互的入口（如 `build`、`plan`）
- **`subagent`**：子 Agent，由主 Agent 通过 `Task` 工具调用（如 `general`、`explore`、`scout`）
- **`all`**：可同时作为主 Agent 和子 Agent 使用

### 2.3 内置 Agent 一览

| Agent 名 | Mode | Native | Hidden | 说明 |
|-----------|------|--------|--------|------|
| `build` | primary | ✓ | ✗ | 默认主 Agent，完整工具权限 |
| `plan` | primary | ✓ | ✗ | 计划模式，禁止编辑工具 |
| `general` | subagent | ✓ | ✗ | 通用多步任务 Agent |
| `explore` | subagent | ✓ | ✗ | 代码库搜索专家 |
| `scout` | subagent | ✓ | ✗ | 外部文档/依赖研究 Agent（实验性） |
| `compaction` | primary | ✓ | ✓ | 上下文压缩（隐藏） |
| `title` | primary | ✓ | ✓ | 标题生成（隐藏） |
| `summary` | primary | ✓ | ✓ | 摘要生成（隐藏） |

### 2.4 Agent 的两种扩展路径

OpenCode 提供了**两种**扩展 Agent 的方式：

1. **Markdown Agent 文件**（推荐，零代码修改）：在 `.opencode/agent/` 或 `.opencode/agents/` 目录下创建 `.md` 文件
2. **配置文件覆盖**（零代码修改）：在 `opencode.jsonc` 的 `agent` 字段中配置

---

## 3. 新增 Agent 的方案设计

### 3.1 方案 A：纯配置方式（推荐，零代码修改）

这是最安全的方式，完全不修改 OpenCode 源码，仅通过配置文件和 Markdown 文件新增 Agent。

#### 3.1.1 新增 Primary Agent

**步骤 1：创建 Agent Markdown 文件**

在项目的 `.opencode/agent/` 目录下创建 Markdown 文件，例如 `.opencode/agent/review.md`：

```markdown
---
mode: primary
description: "Code review specialist. Use this agent when you need a thorough code review of recent changes."
model: anthropic/claude-sonnet-4-20250514
color: "#9B59B6"
permission:
  bash: deny
  edit: deny
  write: deny
  apply_patch: deny
  read: allow
  glob: allow
  grep: allow
  webfetch: allow
  websearch: allow
  question: allow
---

You are a code review specialist. Your job is to thoroughly review code changes
and provide actionable feedback.

When reviewing code:
1. Check for bugs, security issues, and performance problems
2. Verify error handling and edge cases
3. Assess code readability and maintainability
4. Check adherence to project conventions
5. Suggest improvements with specific examples

Focus on the most important issues first. Be concise but thorough.
```

**Frontmatter 字段说明**（参考 [config/agent.ts](file:///workspace/packages/opencode/src/config/agent.ts)）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `mode` | `"primary" \| "subagent" \| "all"` | Agent 模式 |
| `description` | `string` | Agent 描述（用于 Task 工具的 agent 列表） |
| `model` | `string` | 指定模型，格式 `provider/model` |
| `color` | `string` | 主题色，hex 或主题色名 |
| `hidden` | `boolean` | 是否隐藏 |
| `temperature` | `number` | 温度参数 |
| `top_p` | `number` | Top-P 参数 |
| `steps` | `number` | 最大 agentic 迭代步数 |
| `permission` | `object` | 权限配置，key 为权限名，value 为 `"allow" \| "deny" \| "ask"` 或嵌套 pattern |
| `variant` | `string` | 默认模型变体 |

Markdown body 部分即为 Agent 的系统提示词（`prompt` 字段）。

**步骤 2（可选）：在 opencode.jsonc 中覆盖配置**

如果需要进一步自定义，可以在 `opencode.jsonc` 中覆盖：

```jsonc
{
  "agent": {
    "review": {
      "model": "anthropic/claude-sonnet-4-20250514",
      "steps": 50,
      "temperature": 0.3
    }
  }
}
```

#### 3.1.2 新增 Subagent

**步骤 1：创建 Agent Markdown 文件**

在 `.opencode/agent/` 目录下创建，例如 `.opencode/agent/test-writer.md`：

```markdown
---
mode: subagent
description: "Test generation specialist. Use this agent when you need to write unit tests, integration tests, or test fixtures for code."
model: anthropic/claude-sonnet-4-20250514
color: "#2ECC71"
permission:
  bash: allow
  edit: allow
  write: allow
  read: allow
  glob: allow
  grep: allow
  webfetch: allow
  websearch: allow
  todowrite: deny
  task: deny
---

You are a test generation specialist. Your job is to write high-quality tests
for the code you are given.

Guidelines:
1. First, understand the code being tested by reading it carefully
2. Look for existing test patterns in the project
3. Write tests that cover: happy paths, edge cases, error conditions
4. Follow the project's existing test conventions
5. Use descriptive test names that explain the expected behavior
6. Keep tests focused and independent

Always verify your tests can run by executing them before reporting completion.
```

**Subagent 的关键约束**：
- `mode: subagent` 使其仅能通过 Task 工具调用
- 默认情况下，subagent 的 `todowrite` 和 `task` 权限会被自动 deny（除非显式允许）
- subagent 会继承父 Agent 的 deny 规则和父 Session 的 deny/external_directory 规则

#### 3.1.3 方案 A 的优缺点

**优点**：
- **零代码修改**，完全不会与 OpenCode 上游更新冲突
- 使用 OpenCode 官方支持的扩展机制
- Agent 定义与项目代码分离，易于管理
- 可通过 `opencode agent create` CLI 命令交互式创建

**缺点**：
- 无法添加自定义工具（只能使用内置工具 + 插件工具）
- 无法修改 Agent 的核心行为逻辑
- 系统提示词只能通过 Markdown 文件定义，无法动态生成

---

### 3.2 方案 B：代码扩展方式（需要修改源码）

如果需要更深度的定制（如自定义工具、动态提示词、特殊行为），则需要修改 OpenCode 源码。以下是**最小侵入性**的修改方案。

#### 3.2.1 修改清单

##### 修改 1：在 `agent.ts` 中注册内置 Agent

**文件**：[agent.ts](file:///workspace/packages/opencode/src/agent/agent.ts#L122-L274)

在 `agents` 对象中添加新的 Agent 定义，遵循现有模式：

```typescript
// 在 agents 对象中添加（约 L274 之前）
review: {
  name: "review",
  description: "Code review specialist. Use this agent for thorough code review of recent changes.",
  permission: Permission.merge(
    defaults,
    Permission.fromConfig({
      "*": "deny",
      grep: "allow",
      glob: "allow",
      read: "allow",
      webfetch: "allow",
      websearch: "allow",
      question: "allow",
      external_directory: readonlyExternalDirectory,
    }),
    user,
  ),
  prompt: PROMPT_REVIEW,  // 需要新增 prompt 文件
  options: {},
  mode: "primary",
  native: true,
},
testwriter: {
  name: "testwriter",
  description: "Test generation specialist. Use this agent to write unit tests, integration tests, or test fixtures.",
  permission: Permission.merge(
    defaults,
    Permission.fromConfig({
      todowrite: "deny",
    }),
    user,
  ),
  prompt: PROMPT_TESTWRITER,  // 需要新增 prompt 文件
  options: {},
  mode: "subagent",
  native: true,
},
```

**注意事项**：
- 将新 Agent 放在 `scout` 之后、`compaction` 之前（即 visible agent 区域）
- `native: true` 标记为内置 Agent
- 权限使用 `Permission.merge(defaults, ...)` 模式，与现有 Agent 保持一致

##### 修改 2：创建 Prompt 文件

**文件**：`src/agent/prompt/review.txt` 和 `src/agent/prompt/testwriter.txt`

按照现有 prompt 文件格式（如 [explore.txt](file:///workspace/packages/opencode/src/agent/prompt/explore.txt)）创建。

##### 修改 3：在 `agent.ts` 中导入 Prompt

**文件**：[agent.ts](file:///workspace/packages/opencode/src/agent/agent.ts#L9-L14)

```typescript
import PROMPT_REVIEW from "./prompt/review.txt"
import PROMPT_TESTWRITER from "./prompt/testwriter.txt"
```

##### 修改 4（可选）：在 `config.ts` 的 agent Schema 中添加已知 key

**文件**：[config.ts](file:///workspace/packages/opencode/src/config/config.ts#L188-L205)

在 `agent` 字段的 `Schema.StructWithRest` 中添加新 Agent 的 key，以获得更好的 JSON Schema 验证和编辑器补全：

```typescript
agent: Schema.optional(
  Schema.StructWithRest(
    Schema.Struct({
      // primary
      plan: Schema.optional(ConfigAgent.Info),
      build: Schema.optional(ConfigAgent.Info),
      // subagent
      general: Schema.optional(ConfigAgent.Info),
      explore: Schema.optional(ConfigAgent.Info),
      scout: Schema.optional(ConfigAgent.Info),
      review: Schema.optional(ConfigAgent.Info),       // 新增
      testwriter: Schema.optional(ConfigAgent.Info),   // 新增
      // specialized
      title: Schema.optional(ConfigAgent.Info),
      summary: Schema.optional(ConfigAgent.Info),
      compaction: Schema.optional(ConfigAgent.Info),
    }),
    [Schema.Record(Schema.String, ConfigAgent.Info)],
  ),
)
```

> **注意**：这一步是可选的。由于使用了 `Schema.StructWithRest`，即使不在此处添加 key，用户也可以通过 `Schema.Record` 部分配置新 Agent。添加 key 的好处仅是 JSON Schema 补全。**如果不添加，也不会影响功能**，但建议添加以保持一致性。

#### 3.2.2 方案 B 的合并冲突风险分析

| 修改点 | 冲突风险 | 说明 |
|--------|----------|------|
| `agent.ts` 的 `agents` 对象 | **中** | 上游可能新增/修改内置 Agent |
| `agent.ts` 的 import 区域 | **低** | 仅新增 import 行 |
| `prompt/*.txt` 新文件 | **无** | 新文件不会冲突 |
| `config.ts` 的 agent Schema | **中** | 上游可能修改 Schema 结构 |

**降低冲突风险的策略**：
1. 将自定义 Agent 的定义放在 `agents` 对象的**末尾**（`summary` 之后），这样上游在中间插入新 Agent 时不会冲突
2. 考虑使用 Git merge 策略（如 `.gitattributes` 中的 `merge=union`）处理 `agent.ts` 的合并
3. Prompt 文件作为独立文件，零冲突风险

---

### 3.3 方案 C：混合方式（推荐的最佳实践）

结合方案 A 和方案 B 的优点：

1. **Primary Agent** 使用**方案 A**（Markdown 文件），因为 Primary Agent 通常不需要自定义工具
2. **Subagent** 如果需要深度定制则使用**方案 B**（代码扩展），否则也使用方案 A

这种方式最大限度减少源码修改，同时保留深度定制能力。

---

## 4. 完整修改清单（以方案 C 为例）

### 4.1 新增 Primary Agent（Markdown 方式）

| 操作 | 文件路径 | 说明 |
|------|----------|------|
| **新建** | `.opencode/agent/review.md` | Primary Agent 定义文件（frontmatter + system prompt） |

无需修改任何源码文件。

### 4.2 新增 Subagent（代码方式，如需深度定制）

| 操作 | 文件路径 | 修改内容 | 冲突风险 |
|------|----------|----------|----------|
| **新建** | `src/agent/prompt/testwriter.txt` | Subagent 的系统提示词 | 无 |
| **修改** | `src/agent/agent.ts` L9-14 | 添加 `import PROMPT_TESTWRITER` | 低 |
| **修改** | `src/agent/agent.ts` L274 附近 | 在 `agents` 对象末尾添加 `testwriter` 定义 | 中 |
| **可选修改** | `src/config/config.ts` L188-205 | 在 agent Schema 中添加 `testwriter` key | 中 |

### 4.3 新增 Subagent（Markdown 方式，无需深度定制）

| 操作 | 文件路径 | 说明 |
|------|----------|------|
| **新建** | `.opencode/agent/testwriter.md` | Subagent 定义文件 |

无需修改任何源码文件。

---

## 5. 关键实现细节

### 5.1 Agent 加载流程

```
opencode.jsonc (agent 字段)
        ↓ merge
.opencode/agent/*.md / .opencode/agents/*.md
        ↓ merge
.opencode/mode/*.md / .opencode/modes/*.md (→ 强制 mode: primary)
        ↓ merge
内置 Agent 定义 (agent.ts 中的 agents 对象)
```

配置的合并顺序为：内置定义 → Markdown 文件 → JSON 配置，后者覆盖前者。这意味着：
- Markdown 文件可以覆盖内置 Agent 的 `prompt`、`model`、`permission` 等
- `opencode.jsonc` 可以进一步覆盖 Markdown 文件的配置
- 如果内置 Agent 被设置 `disable: true`，则完全移除

### 5.2 Subagent 的权限继承

当主 Agent 通过 Task 工具调用 Subagent 时，权限按以下规则派生（参考 [subagent-permissions.ts](file:///workspace/packages/opencode/src/agent/subagent-permissions.ts)）：

1. 继承**父 Agent** 的所有 deny 规则
2. 继承**父 Session** 的 deny 规则和 external_directory 规则
3. 如果 Subagent 自身未显式允许 `todowrite`，则自动 deny
4. 如果 Subagent 自身未显式允许 `task`，则自动 deny（防止无限递归）

### 5.3 Task 工具的 Agent 列表动态生成

Task 工具的描述会动态列出所有可用的 Subagent（参考 [registry.ts](file:///workspace/packages/opencode/src/tool/registry.ts#L289-L301)）：

```typescript
const describeTask = Effect.fn("ToolRegistry.describeTask")(function* (agent: Agent.Info) {
  const items = (yield* agents.list()).filter((item) => item.mode !== "primary")
  const filtered = items.filter(
    (item) => Permission.evaluate("task", item.name, agent.permission).action !== "deny",
  )
  // ...
})
```

这意味着新增的 Subagent 会自动出现在 Task 工具的可用列表中，无需额外配置。

### 5.4 Primary Agent 的选择

Primary Agent 会出现在 TUI 的 Agent 选择对话框中（[dialog-agent.tsx](file:///workspace/packages/opencode/src/cli/cmd/tui/component/dialog-agent.tsx)），以及 ACP 协议的 mode 选择中。过滤条件是 `mode !== "subagent" && hidden !== true`。

### 5.5 默认 Agent 的确定

默认 Agent 的确定逻辑（参考 [agent.ts](file:///workspace/packages/opencode/src/agent/agent.ts#L337-L349)）：

1. 如果配置了 `default_agent`，使用指定的 Agent
2. 否则，选择第一个 `mode !== "subagent" && hidden !== true` 的 Agent
3. 默认 Agent 不能是 subagent 或 hidden

---

## 6. 测试验证

### 6.1 验证 Agent 注册

```bash
opencode agent list
```

应能看到新增的 Agent 出现在列表中。

### 6.2 验证 Primary Agent

1. 启动 opencode TUI
2. 通过 Agent 选择对话框切换到新 Primary Agent
3. 验证权限、模型、提示词是否正确

### 6.3 验证 Subagent

1. 在主 Agent 中请求调用 Subagent
2. 验证 Task 工具描述中包含新 Subagent
3. 验证 Subagent 的权限继承是否正确
4. 验证 Subagent 的输出是否返回给主 Agent

### 6.4 验证配置覆盖

1. 在 `opencode.jsonc` 中覆盖新 Agent 的配置
2. 重启 opencode，验证配置是否生效

---

## 7. 与上游合并的维护策略

### 7.1 优先使用 Markdown Agent

Markdown Agent 文件位于 `.opencode/agent/` 目录，不在 OpenCode 源码树中，因此**永远不会与上游冲突**。

### 7.2 代码修改的合并策略

如果必须修改源码：

1. **将自定义 Agent 定义放在 `agents` 对象末尾**，避免与上游新增的内置 Agent 冲突
2. **使用 Git rebase 而非 merge** 跟踪上游，便于解决冲突
3. **定期同步上游**，避免分支偏离过大
4. **将修改最小化**，仅添加必要的 Agent 定义和 prompt 文件

### 7.3 配置文件优先

始终优先通过 `opencode.jsonc` 调整 Agent 行为，而非修改源码。配置文件的修改不会与上游冲突。

---

## 8. 示例：完整的 Agent Markdown 文件

### 8.1 Primary Agent 示例

文件：`.opencode/agent/review.md`

```markdown
---
mode: primary
description: "Code review specialist. Use this agent for thorough code review of recent changes, security audits, and quality assessments."
model: anthropic/claude-sonnet-4-20250514
color: "#9B59B6"
permission:
  bash: deny
  edit: deny
  write: deny
  apply_patch: deny
  read: allow
  glob: allow
  grep: allow
  webfetch: allow
  websearch: allow
  question: allow
  lsp: allow
  skill: allow
---

You are a code review specialist. Your job is to thoroughly review code changes
and provide actionable feedback.

Review Process:
1. Use Glob and Grep to understand the changed files and their context
2. Read the relevant source files carefully
3. Analyze the changes for:
   - Bugs and logic errors
   - Security vulnerabilities
   - Performance issues
   - Error handling gaps
   - Code style and convention violations
   - Missing tests
4. Provide structured feedback with severity levels (Critical/Warning/Suggestion)

Output Format:
- Start with an overall assessment
- List issues by severity
- Include specific file paths and line references
- Suggest concrete fixes for each issue
```

### 8.2 Subagent 示例

文件：`.opencode/agent/testwriter.md`

```markdown
---
mode: subagent
description: "Test generation specialist. Use this agent to write unit tests, integration tests, or test fixtures for code."
color: "#2ECC71"
steps: 30
permission:
  bash: allow
  edit: allow
  write: allow
  read: allow
  glob: allow
  grep: allow
  webfetch: allow
  websearch: allow
  question: allow
  skill: allow
---

You are a test generation specialist. Your job is to write high-quality tests
for the code you are given.

Workflow:
1. Read the source code that needs tests
2. Search for existing test patterns in the project (Glob for test files, Grep for test imports)
3. Read existing test files to understand conventions
4. Write comprehensive tests covering:
   - Happy path scenarios
   - Edge cases and boundary conditions
   - Error handling paths
   - Integration points (if applicable)
5. Run the tests using Bash to verify they pass
6. Fix any failing tests

Guidelines:
- Follow the project's existing test conventions
- Use descriptive test names
- Keep tests focused and independent
- Mock external dependencies appropriately
- Aim for meaningful coverage, not just line coverage
```

---

## 9. 总结

| 方案 | 代码修改量 | 冲突风险 | 定制能力 | 推荐场景 |
|------|-----------|----------|----------|----------|
| **A: 纯配置** | 无 | 无 | 中（仅 prompt + 权限 + 模型） | 大多数场景 |
| **B: 纯代码** | 3-4 文件 | 中 | 高（可加自定义工具/逻辑） | 需要深度定制 |
| **C: 混合** | 0-2 文件 | 低 | 高 | **推荐** |

**最终建议**：优先使用**方案 A（纯配置）**，仅在确实需要自定义工具或动态行为时才考虑方案 B/C。这样可以在享受 OpenCode 持续演进的同时，保持自定义 Agent 的灵活性。
