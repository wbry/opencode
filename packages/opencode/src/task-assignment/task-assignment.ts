import { Context, Effect, Layer } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { AndroidDevice } from "@/android-device/android-device"
import { Task, TaskList } from "./schema"
import { ulid } from "ulid"

export interface Interface {
  readonly createTask: (
    task: Omit<Task, "id" | "createdAt" | "updatedAt" | "status" | "agentId" | "deviceId">,
  ) => Effect.Effect<Task>
  readonly getTask: (taskId: string) => Effect.Effect<Task | undefined>
  readonly listTasks: () => Effect.Effect<TaskList>
  readonly listTasksByStatus: (
    status: "pending" | "assigned" | "in-progress" | "completed" | "failed",
  ) => Effect.Effect<TaskList>
  readonly assignTask: (taskId: string, deviceId: string, agentId: string) => Effect.Effect<Task>
  readonly updateTaskStatus: (
    taskId: string,
    status: "pending" | "assigned" | "in-progress" | "completed" | "failed",
  ) => Effect.Effect<Task>
  readonly autoAssignTasks: () => Effect.Effect<TaskList>
  readonly deleteTask: (taskId: string) => Effect.Effect<void>
}

type State = {
  tasks: Map<string, Task>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/TaskAssignment") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const androidDeviceService = yield* AndroidDevice.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("TaskAssignment.state")(function* () {
        return {
          tasks: new Map(),
        } satisfies State
      }),
    )

    const createTask = Effect.fn("TaskAssignment.createTask")(function* (
      task: Omit<Task, "id" | "createdAt" | "updatedAt" | "status" | "agentId" | "deviceId">,
    ) {
      const now = Date.now()
      const newTask: Task = {
        ...task,
        id: ulid(),
        status: "pending",
        createdAt: now,
        updatedAt: now,
      }
      yield* InstanceState.useEffect(state, (s) => {
        s.tasks.set(newTask.id, newTask)
      })
      return newTask
    })

    const getTask = Effect.fn("TaskAssignment.getTask")(function* (taskId: string) {
      return yield* InstanceState.useEffect(state, (s) => s.tasks.get(taskId))
    })

    const listTasks = Effect.fn("TaskAssignment.listTasks")(function* () {
      return yield* InstanceState.useEffect(state, (s) => Array.from(s.tasks.values()))
    })

    const listTasksByStatus = Effect.fn("TaskAssignment.listTasksByStatus")(function* (
      status: "pending" | "assigned" | "in-progress" | "completed" | "failed",
    ) {
      return yield* InstanceState.useEffect(state, (s) =>
        Array.from(s.tasks.values()).filter((task) => task.status === status),
      )
    })

    const assignTask = Effect.fn("TaskAssignment.assignTask")(function* (
      taskId: string,
      deviceId: string,
      agentId: string,
    ) {
      return yield* InstanceState.useEffect(state, (s) => {
        const task = s.tasks.get(taskId)
        if (!task) {
          throw new Error(`Task ${taskId} not found`)
        }

        const updatedTask: Task = {
          ...task,
          deviceId,
          agentId,
          status: "assigned",
          updatedAt: Date.now(),
        }
        s.tasks.set(taskId, updatedTask)
        return updatedTask
      })
    })

    const updateTaskStatus = Effect.fn("TaskAssignment.updateTaskStatus")(function* (
      taskId: string,
      status: "pending" | "assigned" | "in-progress" | "completed" | "failed",
    ) {
      return yield* InstanceState.useEffect(state, (s) => {
        const task = s.tasks.get(taskId)
        if (!task) {
          throw new Error(`Task ${taskId} not found`)
        }
        const updatedTask: Task = {
          ...task,
          status,
          updatedAt: Date.now(),
        }
        s.tasks.set(taskId, updatedTask)
        return updatedTask
      })
    })

    const autoAssignTasks = Effect.fn("TaskAssignment.autoAssignTasks")(function* () {
      const devices = yield* androidDeviceService.list()
      const availableDevices = devices.filter((device) => device.status === "available")

      if (availableDevices.length === 0) {
        return [] as TaskList
      }

      const pendingTasks = yield* listTasksByStatus("pending")

      const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 }
      const sortedTasks = pendingTasks.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority])

      const assignedTasks: Task[] = []
      let deviceIndex = 0

      for (const task of sortedTasks) {
        if (deviceIndex >= availableDevices.length) {
          break
        }

        const device = availableDevices[deviceIndex]
        const agentId = `agent-${device.id}`

        const updatedTask = yield* assignTask(task.id, device.id, agentId)
        yield* androidDeviceService.assignAgent(device.id, agentId)

        assignedTasks.push(updatedTask)
        deviceIndex++
      }

      return assignedTasks
    })

    const deleteTask = Effect.fn("TaskAssignment.deleteTask")(function* (taskId: string) {
      yield* InstanceState.useEffect(state, (s) => {
        s.tasks.delete(taskId)
      })
    })

    return Service.of({
      createTask,
      getTask,
      listTasks,
      listTasksByStatus,
      assignTask,
      updateTaskStatus,
      autoAssignTasks,
      deleteTask,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(AndroidDevice.defaultLayer))

export * as TaskAssignment from "./task-assignment"
