import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { AndroidDevice, DeviceList } from "@/android-device/schema"
import { described } from "./metadata"

export const AndroidDevicePaths = {
  list: "/android-devices",
  device: "/android-devices/:deviceId",
  register: "/android-devices/register",
  status: "/android-devices/:deviceId/status",
  heartbeat: "/android-devices/:deviceId/heartbeat",
  assignAgent: "/android-devices/:deviceId/assign-agent",
  releaseAgent: "/android-devices/:deviceId/release-agent",
} as const

const DeviceIdParams = Schema.Struct({
  deviceId: Schema.String,
})

const RegisterDeviceInput = Schema.Struct({
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
  capabilities: Schema.Array(Schema.String).annotate({ description: "Device capabilities (e.g., 'rooted', 'wifi')" }),
})

const UpdateStatusInput = Schema.Struct({
  status: Schema.Union([
    Schema.Literal("available"),
    Schema.Literal("busy"),
    Schema.Literal("offline"),
    Schema.Literal("disconnected"),
  ]),
})

const AssignAgentInput = Schema.Struct({
  agentId: Schema.String.annotate({ description: "ID of agent to assign to this device" }),
})

export const AndroidDeviceApi = HttpApi.make("android-device").add(
  HttpApiGroup.make("android-device")
    .add(
      HttpApiEndpoint.get("list", AndroidDevicePaths.list, {
        success: described(DeviceList, "List of all connected Android devices"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "android-device.list",
          summary: "List Android devices",
          description: "Get a list of all connected Android devices",
        }),
      ),
      HttpApiEndpoint.get("get", AndroidDevicePaths.device, {
        params: DeviceIdParams,
        success: described(AndroidDevice, "Android device details"),
        error: HttpApiError.NotFound,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "android-device.get",
          summary: "Get Android device",
          description: "Get details of a specific Android device",
        }),
      ),
      HttpApiEndpoint.post("register", AndroidDevicePaths.register, {
        payload: RegisterDeviceInput,
        success: described(AndroidDevice, "Registered Android device"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "android-device.register",
          summary: "Register Android device",
          description: "Register a new Android device with the server",
        }),
      ),
      HttpApiEndpoint.put("updateStatus", AndroidDevicePaths.status, {
        params: DeviceIdParams,
        payload: UpdateStatusInput,
        success: described(AndroidDevice, "Updated Android device"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "android-device.updateStatus",
          summary: "Update device status",
          description: "Update the status of an Android device",
        }),
      ),
      HttpApiEndpoint.post("heartbeat", AndroidDevicePaths.heartbeat, {
        params: DeviceIdParams,
        success: described(AndroidDevice, "Updated Android device"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "android-device.heartbeat",
          summary: "Device heartbeat",
          description: "Send a heartbeat from an Android device to keep it active",
        }),
      ),
      HttpApiEndpoint.post("assignAgent", AndroidDevicePaths.assignAgent, {
        params: DeviceIdParams,
        payload: AssignAgentInput,
        success: described(AndroidDevice, "Updated Android device with assigned agent"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "android-device.assignAgent",
          summary: "Assign agent to device",
          description: "Assign an agent to a specific Android device",
        }),
      ),
      HttpApiEndpoint.post("releaseAgent", AndroidDevicePaths.releaseAgent, {
        params: DeviceIdParams,
        success: described(AndroidDevice, "Updated Android device after releasing agent"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "android-device.releaseAgent",
          summary: "Release agent from device",
          description: "Release the currently assigned agent from an Android device",
        }),
      ),
      HttpApiEndpoint.delete("unregister", AndroidDevicePaths.device, {
        params: DeviceIdParams,
        success: described(Schema.Boolean, "Successfully unregistered device"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "android-device.unregister",
          summary: "Unregister device",
          description: "Unregister an Android device from the server",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "android-device", description: "Android device management routes." })),
)
