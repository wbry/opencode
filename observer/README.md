# OpenCode Observer

Real-time web observer for `opencode serve` sessions. Provides a TUI-like web interface to monitor session activity, including LLM text output, reasoning, tool calls, and sub-agent invocations.

## Prerequisites

- Node.js >= 18
- A running `opencode serve` instance

## Install

```bash
npm install
```

## Development

Start both the backend and frontend in watch mode:

```bash
npm run dev
```

- Frontend dev server: http://localhost:5173 (proxies API/WS to backend)
- Backend server: http://localhost:3210

## Production Build

```bash
npm run build
```

This runs `vite build` for the frontend and `tsc` for the server, outputting to `dist/`.

## Production Start

```bash
npm run start
```

Starts the server with `node dist/server/index.js`. The frontend is served as static assets from `dist/client/`.

## Configuration

All configuration is via environment variables:

### Observer Service

| Variable | Default | Description |
|---|---|---|
| `OBSERVER_PORT` | `3210` | Observer HTTP/WS listen port |
| `HEARTBEAT_INTERVAL` | `30000` | WebSocket heartbeat interval (ms) |

### OpenCode Serve Connection

| Variable | Default | Description |
|---|---|---|
| `OPENCODE_URL` | `http://localhost:4096` | opencode serve address |
| `OPENCODE_DIRECTORY` | — | Project directory, sent as `x-opencode-directory` header to opencode serve |
| `OPENCODE_PASSWORD` | — | Password for opencode serve authentication. Must match the `OPENCODE_SERVER_PASSWORD` set on the opencode serve side. Sent as `Authorization: Bearer <password>` header |

### Vite Dev Server

| Variable | Default | Description |
|---|---|---|
| — | `5173` | Frontend dev server port (configured in `vite.config.ts`) |

> **Note:** The Observer server currently listens on `localhost` only. To allow external access, modify the `server.listen()` call in `src/server/index.ts` to use `"0.0.0.0"`.

### Example

```bash
# Basic usage
npm run dev

# With opencode serve on a custom address and password
OPENCODE_URL=http://192.168.1.100:4096 \
OPENCODE_PASSWORD=my_secret_password \
npm run dev

# With project directory and custom port
OBSERVER_PORT=8080 \
OPENCODE_DIRECTORY=/path/to/project \
npm run dev
```

## Architecture

```
Browser (React)  ←→  Observer Server  ←→  opencode serve
     WebSocket          SSE (/global/event)
```

- **SSE Client** connects to opencode serve, receives real-time events
- **State Manager** maintains in-memory session/message state
- **WebSocket Hub** broadcasts state changes to browser clients
- **REST API** provides initial data loading endpoints

## Project Structure

```
observer/
├── src/
│   ├── server/          # Backend (Express + WebSocket)
│   ├── client/          # Frontend (React + Vite)
│   └── shared/          # Shared TypeScript types
├── docs/
│   └── design.md        # Design document
├── vite.config.ts
├── tsconfig.json
└── tsconfig.server.json
```
