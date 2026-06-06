/**
 * OpenCode Observer - Frontend Application
 *
 * 实时监控 opencode serve 的 Session 活动
 * 通过 SSE 事件流获取实时数据，通过 HTTP API 获取历史数据
 */

// ============================================
// Configuration
// ============================================

const API_BASE = window.location.origin
const SSE_PATH = "/event"  // V1 SSE 端点，支持实例路由和心跳
const RECONNECT_DELAY = 3000
const SESSION_REFRESH_INTERVAL = 10000

// ============================================
// State
// ============================================

const state = {
  sessions: new Map(),        // sessionID -> session info
  sessionStatus: new Map(),   // sessionID -> status info
  currentSessionID: null,
  eventSource: null,
  connected: false,
  authPassword: "",
  directory: "",              // 项目目录，用于 workspace routing
  // 实时流状态 - 按 sessionID 组织
  liveStreams: new Map(),     // sessionID -> { texts, tools, reasoning, stepInfo }
  // 消息缓存
  messages: new Map(),        // sessionID -> Message[]
}

// ============================================
// DOM References
// ============================================

const dom = {
  connectionStatus: document.getElementById("connection-status"),
  authPassword: document.getElementById("auth-password"),
  directoryInput: document.getElementById("directory-input"),
  btnConnect: document.getElementById("btn-connect"),
  btnRefresh: document.getElementById("btn-refresh"),
  searchInput: document.getElementById("search-input"),
  sessionList: document.getElementById("session-list"),
  noSession: document.getElementById("no-session"),
  sessionView: document.getElementById("session-view"),
  sessionTitle: document.getElementById("session-title"),
  sessionAgent: document.getElementById("session-agent"),
  sessionModel: document.getElementById("session-model"),
  sessionStatus: document.getElementById("session-status"),
  sessionCost: document.getElementById("session-cost"),
  messages: document.getElementById("messages"),
  liveBar: document.getElementById("live-bar"),
  liveText: document.getElementById("live-text"),
}

// ============================================
// API Helpers
// ============================================

function getAuthHeaders() {
  const password = state.authPassword || localStorage.getItem("opencode_password") || ""
  const headers = {}
  if (password) {
    headers["Authorization"] = "Basic " + btoa("opencode:" + password)
  }
  return headers
}

async function apiFetch(path, options = {}) {
  const url = `${API_BASE}${path}`
  const headers = { ...getAuthHeaders(), ...options.headers }
  // 添加 x-opencode-directory header 用于实例路由
  if (state.directory) {
    headers["x-opencode-directory"] = state.directory
  }
  try {
    const response = await fetch(url, { ...options, headers })
    if (response.status === 401) {
      updateConnectionStatus("disconnected", "Auth failed")
      return null
    }
    if (!response.ok) return null
    return await response.json()
  } catch (err) {
    console.error("API fetch error:", path, err)
    return null
  }
}

// ============================================
// Session Management
// ============================================

async function loadSessions() {
  const data = await apiFetch("/session")
  if (!data) return

  // data 是 Session.Info[]
  const sessions = Array.isArray(data) ? data : []
  state.sessions.clear()
  for (const session of sessions) {
    state.sessions.set(session.id, session)
  }

  // 同时加载状态
  await loadSessionStatus()
  renderSessionList()
}

async function loadSessionStatus() {
  const data = await apiFetch("/session/status")
  if (!data) return

  state.sessionStatus.clear()
  for (const [id, status] of Object.entries(data)) {
    state.sessionStatus.set(id, status)
  }
}

async function loadSessionMessages(sessionID) {
  const data = await apiFetch(`/session/${sessionID}/message`)
  if (!data) return

  const messages = Array.isArray(data) ? data : []
  state.messages.set(sessionID, messages)
  renderMessages(sessionID)
}

// ============================================
// SSE Connection
// ============================================

function connectSSE() {
  if (state.eventSource) {
    state.eventSource.close()
    state.eventSource = null
  }

  updateConnectionStatus("connecting", "Connecting...")

  // V1 /event 端点需要 workspace routing 参数
  // directory 参数用于路由到正确的项目实例
  const directory = state.directory || ""
  let url = `${API_BASE}${SSE_PATH}`
  if (directory) {
    url += `?directory=${encodeURIComponent(directory)}`
  }

  // EventSource 不支持自定义 header
  // 如果需要认证，先通过 fetch 预认证
  const password = state.authPassword || localStorage.getItem("opencode_password") || ""
  if (password) {
    fetch(`${API_BASE}/session`, {
      headers: getAuthHeaders(),
      credentials: "include",
    }).then(() => {
      createEventSource(url)
    }).catch(() => {
      createEventSource(url)
    })
  } else {
    createEventSource(url)
  }
}

function createEventSource(url) {
  try {
    const es = new EventSource(url)
    state.eventSource = es

    es.onopen = () => {
      state.connected = true
      updateConnectionStatus("connected", "Connected")
    }

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        handleSSEEvent(data)
      } catch (err) {
        console.error("SSE parse error:", err)
      }
    }

    es.onerror = () => {
      state.connected = false
      updateConnectionStatus("disconnected", "Disconnected")
      es.close()
      state.eventSource = null

      // 自动重连
      setTimeout(() => {
        if (!state.eventSource) {
          connectSSE()
        }
      }, RECONNECT_DELAY)
    }
  } catch (err) {
    console.error("EventSource creation error:", err)
    updateConnectionStatus("disconnected", "Connection failed")
  }
}

function disconnectSSE() {
  if (state.eventSource) {
    state.eventSource.close()
    state.eventSource = null
  }
  state.connected = false
  updateConnectionStatus("disconnected", "Disconnected")
}

// ============================================
// SSE Event Handling
// ============================================

function handleSSEEvent(event) {
  const type = event.type
  const props = event.properties || event.data || {}

  // V2 事件格式：{ id, type, data: { sessionID, ... } }
  // V1 事件格式：{ id, type, properties: { sessionID, ... } }
  const sessionID = props.sessionID

  if (!sessionID) {
    // 非会话事件（如 server.connected, server.heartbeat）
    if (type === "server.connected") {
      updateConnectionStatus("connected", "Connected")
    }
    return
  }

  // 确保该 session 有 liveStream 状态
  if (!state.liveStreams.has(sessionID)) {
    state.liveStreams.set(sessionID, {
      currentStep: null,
      activeTexts: new Map(),    // textID -> { text, element }
      activeTools: new Map(),    // callID -> { name, input, output, status, element }
      activeReasoning: new Map(), // reasoningID -> { text, element }
    })
  }

  const live = state.liveStreams.get(sessionID)

  switch (type) {
    // Step 生命周期
    case "session.next.step.started":
      live.currentStep = {
        assistantMessageID: props.assistantMessageID,
        agent: props.agent,
        model: props.model,
      }
      updateSessionActivity(sessionID, "active")
      if (isCurrentSession(sessionID)) {
        showLiveBar(true, `Running: ${props.agent || "agent"} / ${formatModel(props.model)}`)
        addAssistantMessageBlock(sessionID, props.assistantMessageID)
      }
      break

    case "session.next.step.ended":
      live.currentStep = null
      updateSessionActivity(sessionID, "idle")
      if (isCurrentSession(sessionID)) {
        showLiveBar(false)
        updateStepStats(sessionID, props)
      }
      break

    case "session.next.step.failed":
      live.currentStep = null
      updateSessionActivity(sessionID, "idle")
      if (isCurrentSession(sessionID)) {
        showLiveBar(false)
        addSystemMessage(sessionID, `Step failed: ${props.error?.message || "unknown error"}`, "error")
      }
      break

    // 文本流
    case "session.next.text.started":
      if (isCurrentSession(sessionID)) {
        startTextBlock(sessionID, props.assistantMessageID, props.textID)
      }
      break

    case "session.next.text.delta":
      if (isCurrentSession(sessionID)) {
        appendTextDelta(sessionID, props.assistantMessageID, props.textID, props.delta)
      }
      break

    case "session.next.text.ended":
      if (isCurrentSession(sessionID)) {
        endTextBlock(sessionID, props.assistantMessageID, props.textID, props.text)
      }
      break

    // 推理流
    case "session.next.reasoning.started":
      if (isCurrentSession(sessionID)) {
        startReasoningBlock(sessionID, props.assistantMessageID, props.reasoningID)
      }
      break

    case "session.next.reasoning.delta":
      if (isCurrentSession(sessionID)) {
        appendReasoningDelta(sessionID, props.assistantMessageID, props.reasoningID, props.delta)
      }
      break

    case "session.next.reasoning.ended":
      if (isCurrentSession(sessionID)) {
        endReasoningBlock(sessionID, props.assistantMessageID, props.reasoningID, props.text)
      }
      break

    // Tool 调用
    case "session.next.tool.input.started":
      if (isCurrentSession(sessionID)) {
        startToolCall(sessionID, props.assistantMessageID, props.callID, props.name, "pending")
      }
      break

    case "session.next.tool.input.delta":
      if (isCurrentSession(sessionID)) {
        appendToolInputDelta(sessionID, props.assistantMessageID, props.callID, props.delta)
      }
      break

    case "session.next.tool.input.ended":
      if (isCurrentSession(sessionID)) {
        endToolInput(sessionID, props.assistantMessageID, props.callID, props.text)
      }
      break

    case "session.next.tool.called":
      if (isCurrentSession(sessionID)) {
        updateToolCalled(sessionID, props.assistantMessageID, props.callID, props.tool, props.input, props.provider)
      }
      break

    case "session.next.tool.progress":
      if (isCurrentSession(sessionID)) {
        updateToolProgress(sessionID, props.assistantMessageID, props.callID, props.content, props.structured)
      }
      break

    case "session.next.tool.success":
      if (isCurrentSession(sessionID)) {
        updateToolSuccess(sessionID, props.assistantMessageID, props.callID, props.content, props.structured)
      }
      break

    case "session.next.tool.failed":
      if (isCurrentSession(sessionID)) {
        updateToolFailed(sessionID, props.assistantMessageID, props.callID, props.error)
      }
      break

    // 用户消息
    case "session.next.prompted":
      updateSessionActivity(sessionID, "active")
      if (isCurrentSession(sessionID)) {
        addUserMessage(sessionID, props)
      }
      break

    // Agent/Model 切换
    case "session.next.agent.switched":
      if (isCurrentSession(sessionID)) {
        addSystemMessage(sessionID, `Agent switched to: ${props.agent}`, "info")
      }
      break

    case "session.next.model.switched":
      if (isCurrentSession(sessionID)) {
        addSystemMessage(sessionID, `Model switched to: ${formatModel(props.model)}`, "info")
      }
      break

    // 中断
    case "session.next.interrupt.requested":
      if (isCurrentSession(sessionID)) {
        addSystemMessage(sessionID, "Interrupt requested", "warning")
      }
      break

    // Shell
    case "session.next.shell.started":
      if (isCurrentSession(sessionID)) {
        addSystemMessage(sessionID, `$ ${props.command}`, "shell")
      }
      break

    // 重试
    case "session.next.retried":
      if (isCurrentSession(sessionID)) {
        addSystemMessage(sessionID, `Retrying (attempt ${props.attempt})...`, "warning")
      }
      break

    // 心跳
    case "server.heartbeat":
      break

    default:
      // 忽略未知事件
      break
  }
}

// ============================================
// UI Rendering - Session List
// ============================================

function renderSessionList() {
  const sessions = Array.from(state.sessions.values())
  const search = dom.searchInput.value.toLowerCase()

  const filtered = search
    ? sessions.filter(s => (s.title || "").toLowerCase().includes(search) || s.id.includes(search))
    : sessions

  // 按活跃状态排序：active > idle > 其他
  filtered.sort((a, b) => {
    const statusA = getSessionActivity(a.id)
    const statusB = getSessionActivity(b.id)
    if (statusA === "active" && statusB !== "active") return -1
    if (statusA !== "active" && statusB === "active") return 1
    return (b.time?.updated || 0) - (a.time?.updated || 0)
  })

  if (filtered.length === 0) {
    dom.sessionList.innerHTML = '<div class="empty-state">No sessions found</div>'
    return
  }

  dom.sessionList.innerHTML = filtered.map(session => {
    const activity = getSessionActivity(session.id)
    const isActive = state.currentSessionID === session.id
    const title = session.title || `Session ${session.id.slice(0, 8)}`
    const timeStr = formatTime(session.time?.updated)

    return `
      <div class="session-item ${isActive ? 'active' : ''}" data-session-id="${session.id}" onclick="selectSession('${session.id}')">
        <div class="session-item-title">${escapeHtml(title)}</div>
        <div class="session-item-meta">
          <span class="session-status-dot ${activity}"></span>
          <span>${activity}</span>
          <span>${timeStr}</span>
        </div>
      </div>
    `
  }).join("")
}

function getSessionActivity(sessionID) {
  const live = state.liveStreams.get(sessionID)
  if (live?.currentStep) return "active"
  const status = state.sessionStatus.get(sessionID)
  if (status?.status === "active" || status?.busy) return "active"
  return "idle"
}

function updateSessionActivity(sessionID, activity) {
  renderSessionList()
}

// ============================================
// UI Rendering - Messages
// ============================================

function renderMessages(sessionID) {
  if (!isCurrentSession(sessionID)) return

  const messages = state.messages.get(sessionID) || []
  dom.messages.innerHTML = ""

  for (const msg of messages) {
    renderHistoryMessage(sessionID, msg)
  }

  scrollToBottom()
}

function renderHistoryMessage(sessionID, msg) {
  const info = msg.info || msg
  const parts = msg.parts || []
  const role = info.role

  if (role === "user") {
    const text = parts
      .filter(p => p.type === "text")
      .map(p => p.text)
      .join("\n")
    if (text) {
      appendMessageHTML("user", text)
    }
  } else if (role === "assistant") {
    for (const part of parts) {
      if (part.type === "text") {
        appendMessageHTML("assistant", part.text)
      } else if (part.type === "tool-invocation") {
        renderToolPart(part)
      } else if (part.type === "reasoning") {
        appendReasoningHTML(part.text)
      }
    }
  }
}

function renderToolPart(part) {
  const tool = part.toolInvocation || part
  const name = tool.toolName || tool.name || "unknown"
  const status = tool.state || "pending"
  const args = tool.args || tool.input || {}

  const el = document.createElement("div")
  el.className = "tool-call"
  el.innerHTML = `
    <div class="tool-call-header">
      <span class="tool-call-icon">🔧</span>
      <span class="tool-call-name">${escapeHtml(name)}</span>
      <span class="tool-call-status ${status}">${status}</span>
    </div>
    <div class="tool-call-body">
      <div class="tool-call-input">
        <div class="tool-call-input-label">Input</div>
        <div class="tool-call-input-content">${escapeHtml(formatJSON(args))}</div>
      </div>
      ${tool.result ? `
        <div class="tool-call-output">
          <div class="tool-call-output-label">Output</div>
          <div class="tool-call-output-content">${escapeHtml(typeof tool.result === "string" ? tool.result : formatJSON(tool.result))}</div>
        </div>
      ` : ""}
    </div>
  `
  dom.messages.appendChild(el)
}

// ============================================
// UI Rendering - Real-time Stream
// ============================================

function addAssistantMessageBlock(sessionID, messageID) {
  // 创建一个 assistant 消息容器
  let container = document.getElementById(`msg-${messageID}`)
  if (!container) {
    container = document.createElement("div")
    container.id = `msg-${messageID}`
    container.className = "message message-assistant"
    container.innerHTML = `<div class="message-label"><span class="icon">🤖</span> Assistant</div>`
    dom.messages.appendChild(container)
    scrollToBottom()
  }
}

function startTextBlock(sessionID, messageID, textID) {
  const container = document.getElementById(`msg-${messageID}`)
  if (!container) return

  let textEl = container.querySelector(`[data-text-id="${textID}"]`)
  if (!textEl) {
    textEl = document.createElement("div")
    textEl.dataset.textId = textID
    textEl.className = "message-text streaming-cursor"
    container.appendChild(textEl)
  }
}

function appendTextDelta(sessionID, messageID, textID, delta) {
  const container = document.getElementById(`msg-${messageID}`)
  if (!container) return

  const textEl = container.querySelector(`[data-text-id="${textID}"]`)
  if (!textEl) return

  textEl.textContent += delta || ""
  scrollToBottom()
}

function endTextBlock(sessionID, messageID, textID, text) {
  const container = document.getElementById(`msg-${messageID}`)
  if (!container) return

  const textEl = container.querySelector(`[data-text-id="${textID}"]`)
  if (!textEl) return

  textEl.classList.remove("streaming-cursor")
  if (text) textEl.textContent = text
  scrollToBottom()
}

function startReasoningBlock(sessionID, messageID, reasoningID) {
  const container = document.getElementById(`msg-${messageID}`)
  if (!container) return

  let el = container.querySelector(`[data-reasoning-id="${reasoningID}"]`)
  if (!el) {
    el = document.createElement("div")
    el.dataset.reasoningId = reasoningID
    el.className = "reasoning-block"
    el.innerHTML = `
      <div class="reasoning-header">💭 Reasoning</div>
      <div class="reasoning-text streaming-cursor"></div>
    `
    container.appendChild(el)
    scrollToBottom()
  }
}

function appendReasoningDelta(sessionID, messageID, reasoningID, delta) {
  const container = document.getElementById(`msg-${messageID}`)
  if (!container) return

  const el = container.querySelector(`[data-reasoning-id="${reasoningID}"] .reasoning-text`)
  if (!el) return

  el.textContent += delta || ""
  scrollToBottom()
}

function endReasoningBlock(sessionID, messageID, reasoningID, text) {
  const container = document.getElementById(`msg-${messageID}`)
  if (!container) return

  const el = container.querySelector(`[data-reasoning-id="${reasoningID}"] .reasoning-text`)
  if (!el) return

  el.classList.remove("streaming-cursor")
  if (text) el.textContent = text
}

function startToolCall(sessionID, messageID, callID, name, status) {
  const container = document.getElementById(`msg-${messageID}`)
  if (!container) return

  let el = container.querySelector(`[data-tool-id="${callID}"]`)
  if (!el) {
    el = document.createElement("div")
    el.dataset.toolId = callID
    el.className = "tool-call"
    el.innerHTML = `
      <div class="tool-call-header">
        <span class="tool-call-icon">🔧</span>
        <span class="tool-call-name">${escapeHtml(name || "tool")}</span>
        <span class="tool-call-status ${status}">${status}</span>
      </div>
      <div class="tool-call-body" style="display:none">
        <div class="tool-call-input">
          <div class="tool-call-input-label">Input</div>
          <div class="tool-call-input-content"></div>
        </div>
        <div class="tool-call-output" style="display:none">
          <div class="tool-call-output-label">Output</div>
          <div class="tool-call-output-content"></div>
        </div>
      </div>
    `
    // 点击 header 展开/折叠 body
    el.querySelector(".tool-call-header").addEventListener("click", () => {
      const body = el.querySelector(".tool-call-body")
      body.style.display = body.style.display === "none" ? "block" : "none"
    })
    container.appendChild(el)
    scrollToBottom()
  }
}

function appendToolInputDelta(sessionID, messageID, callID, delta) {
  const container = document.getElementById(`msg-${messageID}`)
  if (!container) return

  const el = container.querySelector(`[data-tool-id="${callID}"]`)
  if (!el) return

  const inputContent = el.querySelector(".tool-call-input-content")
  inputContent.textContent += delta || ""
  el.querySelector(".tool-call-body").style.display = "block"
}

function endToolInput(sessionID, messageID, callID, text) {
  const container = document.getElementById(`msg-${messageID}`)
  if (!container) return

  const el = container.querySelector(`[data-tool-id="${callID}"]`)
  if (!el) return

  const inputContent = el.querySelector(".tool-call-input-content")
  if (text) inputContent.textContent = text
}

function updateToolCalled(sessionID, messageID, callID, tool, input, provider) {
  const container = document.getElementById(`msg-${messageID}`)
  if (!container) return

  const el = container.querySelector(`[data-tool-id="${callID}"]`)
  if (!el) return

  const nameEl = el.querySelector(".tool-call-name")
  nameEl.textContent = tool || "tool"

  const statusEl = el.querySelector(".tool-call-status")
  statusEl.className = "tool-call-status running"
  statusEl.textContent = "running"

  const inputContent = el.querySelector(".tool-call-input-content")
  if (input && Object.keys(input).length > 0) {
    inputContent.textContent = formatJSON(input)
  }

  el.querySelector(".tool-call-body").style.display = "block"
}

function updateToolProgress(sessionID, messageID, callID, content, structured) {
  const container = document.getElementById(`msg-${messageID}`)
  if (!container) return

  const el = container.querySelector(`[data-tool-id="${callID}"]`)
  if (!el) return

  const outputEl = el.querySelector(".tool-call-output")
  const outputContent = el.querySelector(".tool-call-output-content")

  if (content && content.length > 0) {
    const text = content.map(c => c.text || c.data || formatJSON(c)).join("\n")
    outputContent.textContent = text
    outputEl.style.display = "block"
  }

  if (structured) {
    const title = structured.title || ""
    if (title) {
      const nameEl = el.querySelector(".tool-call-name")
      nameEl.textContent = title
    }
  }
}

function updateToolSuccess(sessionID, messageID, callID, content, structured) {
  const container = document.getElementById(`msg-${messageID}`)
  if (!container) return

  const el = container.querySelector(`[data-tool-id="${callID}"]`)
  if (!el) return

  const statusEl = el.querySelector(".tool-call-status")
  statusEl.className = "tool-call-status completed"
  statusEl.textContent = "completed"

  const outputEl = el.querySelector(".tool-call-output")
  const outputContent = el.querySelector(".tool-call-output-content")

  if (content && content.length > 0) {
    const text = content.map(c => c.text || c.data || formatJSON(c)).join("\n")
    outputContent.textContent = text
    outputEl.style.display = "block"
  }
}

function updateToolFailed(sessionID, messageID, callID, error) {
  const container = document.getElementById(`msg-${messageID}`)
  if (!container) return

  const el = container.querySelector(`[data-tool-id="${callID}"]`)
  if (!el) return

  const statusEl = el.querySelector(".tool-call-status")
  statusEl.className = "tool-call-status error"
  statusEl.textContent = "error"

  const outputEl = el.querySelector(".tool-call-output")
  const outputContent = el.querySelector(".tool-call-output-content")
  outputContent.textContent = error?.message || "Tool execution failed"
  outputEl.style.display = "block"
}

function addUserMessage(sessionID, props) {
  const text = props.prompt?.text || ""
  if (!text) return
  appendMessageHTML("user", text)
  scrollToBottom()
}

function addSystemMessage(sessionID, text, type = "info") {
  const icons = { info: "ℹ️", warning: "⚠️", error: "❌", shell: "💻" }
  const el = document.createElement("div")
  el.className = "system-message"
  el.innerHTML = `<span>${icons[type] || "ℹ️"}</span> ${escapeHtml(text)}`
  dom.messages.appendChild(el)
  scrollToBottom()
}

function appendMessageHTML(role, text) {
  const el = document.createElement("div")
  el.className = `message message-${role}`
  const icon = role === "user" ? "👤" : "🤖"
  const label = role === "user" ? "User" : "Assistant"
  el.innerHTML = `
    <div class="message-label"><span class="icon">${icon}</span> ${label}</div>
    <div class="message-text">${escapeHtml(text)}</div>
  `
  dom.messages.appendChild(el)
}

function appendReasoningHTML(text) {
  const el = document.createElement("div")
  el.className = "reasoning-block"
  el.innerHTML = `
    <div class="reasoning-header">💭 Reasoning</div>
    <div class="reasoning-text">${escapeHtml(text)}</div>
  `
  dom.messages.appendChild(el)
}

function updateStepStats(sessionID, props) {
  if (!props) return
  const tokens = props.tokens
  const cost = props.cost
  if (tokens || cost) {
    dom.sessionCost.textContent = formatStats(tokens, cost)
  }
}

// ============================================
// Session Selection
// ============================================

function selectSession(sessionID) {
  state.currentSessionID = sessionID
  const session = state.sessions.get(sessionID)

  // 更新 UI
  dom.noSession.style.display = "none"
  dom.sessionView.style.display = "flex"

  // 更新 header
  dom.sessionTitle.textContent = session?.title || `Session ${sessionID.slice(0, 8)}`
  dom.sessionAgent.textContent = session?.agent ? `Agent: ${session.agent}` : ""
  dom.sessionModel.textContent = session?.model ? `Model: ${formatModel(session.model)}` : ""
  const activity = getSessionActivity(sessionID)
  dom.sessionStatus.innerHTML = `<span class="session-status-dot ${activity}"></span> ${activity}`
  dom.sessionCost.textContent = formatStats(session?.tokens, session?.cost)

  // 清空消息区
  dom.messages.innerHTML = ""

  // 加载历史消息
  loadSessionMessages(sessionID)

  // 更新侧边栏选中状态
  renderSessionList()

  // 如果有活跃流，显示 live bar
  const live = state.liveStreams.get(sessionID)
  if (live?.currentStep) {
    showLiveBar(true, `Running: ${live.currentStep.agent || "agent"} / ${formatModel(live.currentStep.model)}`)
  } else {
    showLiveBar(false)
  }
}

// Make selectSession globally accessible for onclick
window.selectSession = selectSession

// ============================================
// UI Helpers
// ============================================

function updateConnectionStatus(status, text) {
  dom.connectionStatus.className = `status-badge ${status}`
  dom.connectionStatus.textContent = text
}

function showLiveBar(show, text = "") {
  dom.liveBar.style.display = show ? "flex" : "none"
  if (text) dom.liveText.textContent = text
}

function isCurrentSession(sessionID) {
  return state.currentSessionID === sessionID
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    dom.messages.scrollTop = dom.messages.scrollHeight
  })
}

// ============================================
// Formatting Helpers
// ============================================

function escapeHtml(text) {
  if (!text) return ""
  const div = document.createElement("div")
  div.textContent = text
  return div.innerHTML
}

function formatJSON(obj) {
  try {
    return JSON.stringify(obj, null, 2)
  } catch {
    return String(obj)
  }
}

function formatModel(model) {
  if (!model) return ""
  if (typeof model === "string") return model
  const parts = []
  if (model.providerID) parts.push(model.providerID)
  if (model.id) parts.push(model.id)
  if (model.modelID) parts.push(model.modelID)
  return parts.join("/") || JSON.stringify(model)
}

function formatTime(ts) {
  if (!ts) return ""
  const date = new Date(typeof ts === "number" ? ts : ts)
  const now = new Date()
  const diff = now - date

  if (diff < 60000) return "just now"
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return date.toLocaleDateString()
}

function formatStats(tokens, cost) {
  const parts = []
  if (tokens) {
    const input = tokens.input ? `${(tokens.input / 1000).toFixed(1)}k in` : ""
    const output = tokens.output ? `${(tokens.output / 1000).toFixed(1)}k out` : ""
    if (input || output) parts.push(`${input} ${output}`.trim())
  }
  if (cost) parts.push(`$${cost.toFixed(4)}`)
  return parts.join(" | ") || ""
}

// ============================================
// Event Listeners
// ============================================

dom.btnConnect.addEventListener("click", () => {
  state.authPassword = dom.authPassword.value
  state.directory = dom.directoryInput.value.trim()
  if (state.authPassword) {
    localStorage.setItem("opencode_password", state.authPassword)
  }
  if (state.directory) {
    localStorage.setItem("opencode_directory", state.directory)
  }

  if (state.connected) {
    disconnectSSE()
    dom.btnConnect.textContent = "Connect"
  } else {
    connectSSE()
    loadSessions()
    dom.btnConnect.textContent = "Disconnect"
  }
})

dom.btnRefresh.addEventListener("click", () => {
  loadSessions()
})

dom.searchInput.addEventListener("input", () => {
  renderSessionList()
})

// 定期刷新 Session 列表
setInterval(() => {
  if (state.connected) {
    loadSessionStatus()
    renderSessionList()
  }
}, SESSION_REFRESH_INTERVAL)

// 初始化：尝试自动连接
window.addEventListener("load", () => {
  const savedPassword = localStorage.getItem("opencode_password")
  if (savedPassword) {
    dom.authPassword.value = savedPassword
    state.authPassword = savedPassword
  }
  const savedDirectory = localStorage.getItem("opencode_directory")
  if (savedDirectory) {
    dom.directoryInput.value = savedDirectory
    state.directory = savedDirectory
  }

  // 自动连接
  connectSSE()
  loadSessions()
  dom.btnConnect.textContent = "Disconnect"
})
