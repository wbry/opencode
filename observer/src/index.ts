/**
 * OpenCode Observer - Server Plugin
 *
 * 作为 opencode server plugin 运行，提供：
 * 1. 静态文件服务（Observer Web UI）
 * 2. 事件收集与转发
 *
 * 集成方式：在 opencode.jsonc 中配置 plugin 指向此模块
 */

import type { Plugin, Hooks, PluginInput } from "@opencode-ai/plugin"

const observerPlugin: Plugin = async (input: PluginInput) => {
  const { client, serverUrl } = input

  return {
    // 监听所有事件 - Observer 前端通过 SSE 直接获取事件
    // 此处仅做日志记录，核心数据流通过 SSE 推送
    async event({ event }) {
      // 事件已通过 /event SSE 端点推送，无需额外处理
    },
  }
}

export default observerPlugin

// 同时导出为 PluginModule 格式
export const server = observerPlugin
