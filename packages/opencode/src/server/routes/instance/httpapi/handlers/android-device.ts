import { AndroidDevice } from "@/android-device/android-device"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

export const androidDeviceHandlers = HttpApiBuilder.group(InstanceHttpApi, "android-device", (handlers) =>
  Effect.gen(function* () {
    const androidDeviceService = yield* AndroidDevice.Service

    const list = Effect.fn("AndroidDeviceHttpApi.list")(function* () {
      return yield* androidDeviceService.list()
    })

    const get = Effect.fn("AndroidDeviceHttpApi.get")(function* (ctx: {
      params: { deviceId: string }
    }) {
      const device = yield* androidDeviceService.get(ctx.params.deviceId)
      if (!device) {
        return yield* HttpApiError.notFound(`Device ${ctx.params.deviceId} not found`)
      }
      return device
    })

    const register = Effect.fn("AndroidDeviceHttpApi.register")(function* (ctx: {
      payload: {
        id: string
        model: string
        brand: string
        osVersion: string
        status: "available" | "busy" | "offline" | "disconnected"
        capabilities: string[]
      }
    }) {
      return yield* androidDeviceService.register(ctx.payload)
    })

    const updateStatus = Effect.fn("AndroidDeviceHttpApi.updateStatus")(function* (ctx: {
      params: { deviceId: string }
      payload: { status: "available" | "busy" | "offline" | "disconnected" }
    }) {
      return yield* androidDeviceService.updateStatus(ctx.params.deviceId, ctx.payload.status)
    })

    const heartbeat = Effect.fn("AndroidDeviceHttpApi.heartbeat")(function* (ctx: {
      params: { deviceId: string }
    }) {
      return yield* androidDeviceService.heartbeat(ctx.params.deviceId)
    })

    const assignAgent = Effect.fn("AndroidDeviceHttpApi.assignAgent")(function* (ctx: {
      params: { deviceId: string }
      payload: { agentId: string }
    }) {
      return yield* androidDeviceService.assignAgent(ctx.params.deviceId, ctx.payload.agentId)
    })

    const releaseAgent = Effect.fn("AndroidDeviceHttpApi.releaseAgent")(function* (ctx: {
      params: { deviceId: string }
    }) {
      return yield* androidDeviceService.releaseAgent(ctx.params.deviceId)
    })

    const unregister = Effect.fn("AndroidDeviceHttpApi.unregister")(function* (ctx: {
      params: { deviceId: string }
    }) {
      yield* androidDeviceService.unregister(ctx.params.deviceId)
      return true
    })

    return handlers
      .handle("list", list)
      .handle("get", get)
      .handle("register", register)
      .handle("updateStatus", updateStatus)
      .handle("heartbeat", heartbeat)
      .handle("assignAgent", assignAgent)
      .handle("releaseAgent", releaseAgent)
      .handle("unregister", unregister)
  }),
)
