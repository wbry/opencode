import { Schema } from "effect"
import type { DeepMutable } from "@opencode-ai/core/schema"

export const Task = Schema.Struct({
  id: Schema.String.annotate({ description: "Unique task identifier" }),
  type: Schema.String.annotate({ description: "Type of task (e.g., 'ui-test', 'performance-test')" }),
  description: Schema.String.annotate({ description: "Task description" }),
  status: Schema.Union([
    Schema.Literal("pending"),
    Schema.Literal("assigned"),
    Schema.Literal("in-progress"),
    Schema.Literal("completed"),
    Schema.Literal("failed"),
  ]).annotate({ description: "Current task status" }),
  deviceId: Schema.optional(Schema.String).annotate({ description: "ID of device assigned to this task" }),
  agentId: Schema.optional(Schema.String).annotate({ description: "ID of agent assigned to this task" }),
  createdAt: Schema.Number.annotate({ description: "Timestamp when task was created" }),
  updatedAt: Schema.Number.annotate({ description: "Timestamp when task was last updated" }),
  priority: Schema.Union([Schema.Literal("low"), Schema.Literal("medium"), Schema.Literal("high")]).annotate({
    description: "Task priority",
  }),
}).annotate({ identifier: "Task" })
export type Task = DeepMutable<Schema.Schema.Type<typeof Task>>

export const TaskList = Schema.Array(Task).annotate({ identifier: "TaskList" })
export type TaskList = Schema.Schema.Type<typeof TaskList>
