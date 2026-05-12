import { Context, Effect, Layer, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { AndroidDevice, type DeviceList } from "./schema"

export interface Interface {
  readonly list: () => Effect.Effect<DeviceList>
  readonly get: (deviceId: string) => Effect.Effect<AndroidDevice | undefined>
  readonly register: (device: Omit<AndroidDevice, "connectedAt" | "lastSeen">) => Effect.Effect<AndroidDevice>
  readonly updateStatus: (deviceId: string, status: AndroidDevice["status"]) => Effect.Effect<AndroidDevice>
  readonly heartbeat: (deviceId: string) => Effect.Effect<AndroidDevice>
  readonly assignAgent: (deviceId: string, agentId: string) => Effect.Effect<AndroidDevice>
  readonly releaseAgent: (deviceId: string) => Effect.Effect<AndroidDevice>
  readonly unregister: (deviceId: string) => Effect.Effect<void>
}

type State = {
  devices: Map<string, AndroidDevice>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AndroidDevice") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make<State>(
      Effect.fn("AndroidDevice.state")(function* () {
        return {
          devices: new Map(),
        } satisfies State
      }),
    )

    const list = Effect.fn("AndroidDevice.list")(function* () {
      return yield* InstanceState.useEffect(state, (s) => Array.from(s.devices.values()))
    })

    const get = Effect.fn("AndroidDevice.get")(function* (deviceId: string) {
      return yield* InstanceState.useEffect(state, (s) => s.devices.get(deviceId))
    })

    const register = Effect.fn("AndroidDevice.register")(function* (
      device: Omit<AndroidDevice, "connectedAt" | "lastSeen">,
    ) {
      const now = Date.now()
      const newDevice: AndroidDevice = {
        ...device,
        connectedAt: now,
        lastSeen: now,
      }
      yield* InstanceState.useEffect(state, (s) => {
        s.devices.set(device.id, newDevice)
      })
      return newDevice
    })

    const updateStatus = Effect.fn("AndroidDevice.updateStatus")(function* (
      deviceId: string,
      status: AndroidDevice["status"],
    ) {
      return yield* InstanceState.useEffect(state, (s) => {
        const device = s.devices.get(deviceId)
        if (!device) {
          throw new Error(`Device ${deviceId} not found`)
        }
        const updatedDevice = { ...device, status, lastSeen: Date.now() }
        s.devices.set(deviceId, updatedDevice)
        return updatedDevice
      })
    })

    const heartbeat = Effect.fn("AndroidDevice.heartbeat")(function* (deviceId: string) {
      return yield* InstanceState.useEffect(state, (s) => {
        const device = s.devices.get(deviceId)
        if (!device) {
          throw new Error(`Device ${deviceId} not found`)
        }
        const updatedDevice = { ...device, lastSeen: Date.now() }
        s.devices.set(deviceId, updatedDevice)
        return updatedDevice
      })
    })

    const assignAgent = Effect.fn("AndroidDevice.assignAgent")(function* (deviceId: string, agentId: string) {
      return yield* InstanceState.useEffect(state, (s) => {
        const device = s.devices.get(deviceId)
        if (!device) {
          throw new Error(`Device ${deviceId} not found`)
        }
        const updatedDevice = { ...device, agentId, status: "busy" as const, lastSeen: Date.now() }
        s.devices.set(deviceId, updatedDevice)
        return updatedDevice
      })
    })

    const releaseAgent = Effect.fn("AndroidDevice.releaseAgent")(function* (deviceId: string) {
      return yield* InstanceState.useEffect(state, (s) => {
        const device = s.devices.get(deviceId)
        if (!device) {
          throw new Error(`Device ${deviceId} not found`)
        }
        const updatedDevice = { ...device, agentId: undefined, status: "available" as const, lastSeen: Date.now() }
        s.devices.set(deviceId, updatedDevice)
        return updatedDevice
      })
    })

    const unregister = Effect.fn("AndroidDevice.unregister")(function* (deviceId: string) {
      yield* InstanceState.useEffect(state, (s) => {
        s.devices.delete(deviceId)
      })
    })

    return Service.of({
      list,
      get,
      register,
      updateStatus,
      heartbeat,
      assignAgent,
      releaseAgent,
      unregister,
    })
  }),
)

export const defaultLayer = layer

export * as AndroidDevice from "./android-device"
