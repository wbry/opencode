import { TaskAssignment } from "@/task-assignment/task-assignment"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

export const taskAssignmentHandlers = HttpApiBuilder.group(InstanceHttpApi, "task-assignment", (handlers) =>
  Effect.gen(function* () {
    const taskAssignmentService = yield* TaskAssignment.Service

    const list = Effect.fn("TaskAssignmentHttpApi.list")(function* () {
      return yield* taskAssignmentService.listTasks()
    })

    const get = Effect.fn("TaskAssignmentHttpApi.get")(function* (ctx: { params: { taskId: string } }) {
      const task = yield* taskAssignmentService.getTask(ctx.params.taskId)
      if (!task) {
        return yield* HttpApiError.notFound(`Task ${ctx.params.taskId} not found`)
      }
      return task
    })

    const create = Effect.fn("TaskAssignmentHttpApi.create")(function* (ctx: {
      payload: {
        type: string
        description: string
        priority: "low" | "medium" | "high"
      }
    }) {
      return yield* taskAssignmentService.createTask(ctx.payload)
    })

    const updateStatus = Effect.fn("TaskAssignmentHttpApi.updateStatus")(function* (ctx: {
      params: { taskId: string }
      payload: { status: "pending" | "assigned" | "in-progress" | "completed" | "failed" }
    }) {
      return yield* taskAssignmentService.updateTaskStatus(ctx.params.taskId, ctx.payload.status)
    })

    const assign = Effect.fn("TaskAssignmentHttpApi.assign")(function* (ctx: {
      params: { taskId: string }
      payload: { deviceId: string; agentId: string }
    }) {
      return yield* taskAssignmentService.assignTask(
        ctx.params.taskId,
        ctx.payload.deviceId,
        ctx.payload.agentId,
      )
    })

    const autoAssign = Effect.fn("TaskAssignmentHttpApi.autoAssign")(function* () {
      return yield* taskAssignmentService.autoAssignTasks()
    })

    const deleteTask = Effect.fn("TaskAssignmentHttpApi.delete")(function* (ctx: { params: { taskId: string } }) {
      yield* taskAssignmentService.deleteTask(ctx.params.taskId)
      return true
    })

    return handlers
      .handle("list", list)
      .handle("get", get)
      .handle("create", create)
      .handle("updateStatus", updateStatus)
      .handle("assign", assign)
      .handle("autoAssign", autoAssign)
      .handle("delete", deleteTask)
  }),
)
