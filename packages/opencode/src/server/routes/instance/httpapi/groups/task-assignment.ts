import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Task, TaskList } from "@/task-assignment/schema"
import { described } from "./metadata"

export const TaskAssignmentPaths = {
  list: "/tasks",
  task: "/tasks/:taskId",
  create: "/tasks",
  status: "/tasks/:taskId/status",
  assign: "/tasks/:taskId/assign",
  autoAssign: "/tasks/auto-assign",
} as const

const TaskIdParams = Schema.Struct({
  taskId: Schema.String,
})

const CreateTaskInput = Schema.Struct({
  type: Schema.String.annotate({ description: "Type of task (e.g., 'ui-test', 'performance-test')" }),
  description: Schema.String.annotate({ description: "Task description" }),
  priority: Schema.Union([Schema.Literal("low"), Schema.Literal("medium"), Schema.Literal("high")]).annotate({
    description: "Task priority",
  }),
})

const UpdateTaskStatusInput = Schema.Struct({
  status: Schema.Union([
    Schema.Literal("pending"),
    Schema.Literal("assigned"),
    Schema.Literal("in-progress"),
    Schema.Literal("completed"),
    Schema.Literal("failed"),
  ]),
})

const AssignTaskInput = Schema.Struct({
  deviceId: Schema.String.annotate({ description: "ID of device to assign" }),
  agentId: Schema.String.annotate({ description: "ID of agent to assign" }),
})

export const TaskAssignmentApi = HttpApi.make("task-assignment").add(
  HttpApiGroup.make("task-assignment")
    .add(
      HttpApiEndpoint.get("list", TaskAssignmentPaths.list, {
        success: described(TaskList, "List of all tasks"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "task-assignment.list",
          summary: "List tasks",
          description: "Get a list of all tasks",
        }),
      ),
      HttpApiEndpoint.get("get", TaskAssignmentPaths.task, {
        params: TaskIdParams,
        success: described(Task, "Task details"),
        error: HttpApiError.NotFound,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "task-assignment.get",
          summary: "Get task",
          description: "Get details of a specific task",
        }),
      ),
      HttpApiEndpoint.post("create", TaskAssignmentPaths.create, {
        payload: CreateTaskInput,
        success: described(Task, "Created task"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "task-assignment.create",
          summary: "Create task",
          description: "Create a new task",
        }),
      ),
      HttpApiEndpoint.put("updateStatus", TaskAssignmentPaths.status, {
        params: TaskIdParams,
        payload: UpdateTaskStatusInput,
        success: described(Task, "Updated task"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "task-assignment.updateStatus",
          summary: "Update task status",
          description: "Update the status of a task",
        }),
      ),
      HttpApiEndpoint.post("assign", TaskAssignmentPaths.assign, {
        params: TaskIdParams,
        payload: AssignTaskInput,
        success: described(Task, "Updated task with assignment"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "task-assignment.assign",
          summary: "Assign task",
          description: "Assign a task to a device and agent",
        }),
      ),
      HttpApiEndpoint.post("autoAssign", TaskAssignmentPaths.autoAssign, {
        success: described(TaskList, "List of auto-assigned tasks"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "task-assignment.autoAssign",
          summary: "Auto-assign tasks",
          description: "Automatically assign pending tasks to available devices",
        }),
      ),
      HttpApiEndpoint.delete("delete", TaskAssignmentPaths.task, {
        params: TaskIdParams,
        success: described(Schema.Boolean, "Successfully deleted task"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "task-assignment.delete",
          summary: "Delete task",
          description: "Delete a task",
        }),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({ title: "task-assignment", description: "Task assignment and management routes." }),
    ),
)
