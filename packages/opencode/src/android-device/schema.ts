import { Schema } from "effect"
import type { DeepMutable } from "@opencode-ai/core/schema"

export const AndroidDevice = Schema.Struct({
  id: Schema.String.annotate({ description: "Unique device identifier (serial number)" }),
  model: Schema.String.annotate({ description: "Device model name" }),
  brand: Schema.String.annotate({ description: "Device brand" }),
  osVersion: Schema.String.annotate({ description: "Android OS version" }),
  status: Schema.Union([
    Schema.Literal("available"),
    Schema.Literal("busy"),
    Schema.Literal("offline"),
    Schema.Literal("disconnected"),
  ]).annotate({ description: "Current device status" }),
  connectedAt: Schema.Number.annotate({ description: "Timestamp when device was connected" }),
  lastSeen: Schema.Number.annotate({ description: "Last heartbeat timestamp" }),
  capabilities: Schema.Array(Schema.String).annotate({ description: "Device capabilities (e.g., 'rooted', 'wifi')" }),
  agentId: Schema.optional(Schema.String).annotate({ description: "ID of agent currently using this device" }),
}).annotate({ identifier: "AndroidDevice" })
export type AndroidDevice = DeepMutable<Schema.Schema.Type<typeof AndroidDevice>>

export const DeviceList = Schema.Array(AndroidDevice).annotate({ identifier: "DeviceList" })
export type DeviceList = Schema.Schema.Type<typeof DeviceList>
