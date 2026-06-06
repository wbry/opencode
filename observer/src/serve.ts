/**
 * Observer 静态文件服务
 *
 * 提供一个独立的轻量 HTTP 服务器，用于在 opencode serve 之外
 * 提供 Observer Web UI 的静态文件服务。
 *
 * 使用方式：
 *   bun run src/serve.ts [--port 4097] [--api-url http://localhost:4096]
 *
 * 也可以作为 opencode serve 的子进程自动启动。
 */

import { createServer } from "node:http"
import { readFile, stat } from "node:fs/promises"
import { join, extname, resolve } from "node:path"

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
}

const STATIC_DIR = resolve(import.meta.dir, "..", "static")

function parseArgs() {
  const args = process.argv.slice(2)
  let port = 4097
  let apiUrl = "http://localhost:4096"

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) {
      port = parseInt(args[i + 1], 10)
      i++
    } else if (args[i] === "--api-url" && args[i + 1]) {
      apiUrl = args[i + 1]
      i++
    }
  }

  return { port, apiUrl }
}

async function serveStatic(path: string): Promise<{ body: Buffer; contentType: string } | null> {
  // 安全：防止路径遍历
  const safePath = path.replace(/\.\./g, "").replace(/\/\//g, "/")
  const filePath = join(STATIC_DIR, safePath === "/" ? "index.html" : safePath)

  try {
    const fileStat = await stat(filePath)
    if (!fileStat.isFile()) return null

    const body = await readFile(filePath)
    const ext = extname(filePath)
    const contentType = MIME_TYPES[ext] || "application/octet-stream"
    return { body, contentType }
  } catch {
    // 如果文件不存在，回退到 index.html (SPA)
    if (path !== "/" && !path.startsWith("/api")) {
      try {
        const body = await readFile(join(STATIC_DIR, "index.html"))
        return { body, contentType: MIME_TYPES[".html"] }
      } catch {
        return null
      }
    }
    return null
  }
}

async function main() {
  const { port, apiUrl } = parseArgs()

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`)
    const path = url.pathname

    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-opencode-directory")

    if (req.method === "OPTIONS") {
      res.writeHead(204)
      res.end()
      return
    }

    // API 代理 - 将 /api/* 请求代理到 opencode serve
    if (path.startsWith("/api/")) {
      try {
        const targetUrl = `${apiUrl}${path}${url.search}`
        const headers: Record<string, string> = {
          "Content-Type": req.headers["content-type"] || "application/json",
        }
        // 转发认证头
        if (req.headers["authorization"]) {
          headers["Authorization"] = req.headers["authorization"]
        }
        if (req.headers["x-opencode-directory"]) {
          headers["x-opencode-directory"] = req.headers["x-opencode-directory"]
        }

        const body = req.method !== "GET" && req.method !== "HEAD"
          ? await new Promise<Buffer>((resolve) => {
              const chunks: Buffer[] = []
              req.on("data", (chunk) => chunks.push(chunk))
              req.on("end", () => resolve(Buffer.concat(chunks)))
            })
          : undefined

        const response = await fetch(targetUrl, {
          method: req.method,
          headers,
          body: body?.length ? body : undefined,
        })

        // SSE 特殊处理
        if (response.headers.get("content-type")?.includes("text/event-stream")) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            Connection: "keep-alive",
          })

          const reader = response.body?.getReader()
          if (reader) {
            const pump = async () => {
              try {
                while (true) {
                  const { done, value } = await reader.read()
                  if (done) break
                  res.write(value)
                }
              } catch {
                // 连接断开
              } finally {
                res.end()
              }
            }
            pump()

            req.on("close", () => {
              reader.cancel().catch(() => {})
            })
          }
          return
        }

        // 普通 HTTP 响应
        const responseBody = await response.arrayBuffer()
        const responseHeaders: Record<string, string> = {}
        response.headers.forEach((value, key) => {
          if (!["transfer-encoding", "content-encoding"].includes(key.toLowerCase())) {
            responseHeaders[key] = value
          }
        })

        res.writeHead(response.status, responseHeaders)
        res.end(Buffer.from(responseBody))
      } catch (err) {
        console.error("API proxy error:", err)
        res.writeHead(502, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "Bad Gateway" }))
      }
      return
    }

    // 静态文件服务
    const result = await serveStatic(path)
    if (result) {
      res.writeHead(200, {
        "Content-Type": result.contentType,
        "Cache-Control": path === "/" ? "no-cache" : "public, max-age=3600",
      })
      res.end(result.body)
    } else {
      res.writeHead(404, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "Not Found" }))
    }
  })

  server.listen(port, () => {
    console.log(`OpenCode Observer running at http://localhost:${port}`)
    console.log(`Proxying API requests to ${apiUrl}`)
  })
}

main().catch(console.error)
