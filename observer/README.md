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

| Variable | Default | Description |
|---|---|---|
| `OBSERVER_PORT` | `3210` | Observer HTTP/WS port |
| `OPENCODE_URL` | `http://localhost:4096` | opencode serve URL |
| `OPENCODE_DIRECTORY` | — | `x-opencode-directory` header value |
| `OPENCODE_PASSWORD` | — | Authorization password |
| `HEARTBEAT_INTERVAL` | `30000` | WebSocket heartbeat interval (ms) |

Example:

```bash
OPENCODE_URL=http://localhost:4096 OPENCODE_DIRECTORY=/path/to/project npm run dev
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
