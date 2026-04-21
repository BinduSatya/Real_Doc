# Collab Editor

A production-ready real-time collaborative document editor built with **CRDT (Yjs)**, **WebSockets**, **React**, **Express**, **PostgreSQL**, and **Redis**.

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                           CLIENTS (React)                            │
│                                                                      │
│   TipTap Editor ──► Yjs Y.Doc ──► WebsocketProvider ──► WS /ws/:id   │
│   (ProseMirror)       (CRDT)        (y-websocket)       Awareness    │
└───────────────────────────────────┬──────────────────────────────────┘
                                    │ WebSocket (binary frames)
                                    ▼
┌──────────────────────────────────────────────────────────────────────┐
│                       EXPRESS SERVER (Node.js)                       │
│                                                                      │
│   HTTP /api/documents  ──► REST CRUD  ──► PostgreSQL                 │
│                                                                      │
│   WS  /ws/:docId  ──► wsHandler.js                                   │
│                          │  Sync protocol (step1/step2/update)       │
│                          │  Awareness protocol (cursors/presence)    │
│                          ▼                                           │
│                      yjsManager.js                                   │
│                          │  In-memory Y.Doc registry                 │
│                          │  Periodic flush → PostgreSQL (BYTEA)      │
│                          │  Redis pub/sub ──► peer servers           │
└──────────────────────────────────────────────────────────────────────┘
                            │               │
                    ┌───────┴────┐   ┌──────┴──────┐
                    │ PostgreSQL │   │    Redis    │
                    │  documents │   │  pub/sub    │
                    │  (BYTEA)   │   │  ydoc:<id>  │
                    └────────────┘   └─────────────┘
```

## CRDT & Sync Protocol

### How Yjs CRDT works
- Every document is a **`Y.Doc`** — a conflict-free replicated data type
- Text is stored as a **`Y.XmlFragment`** (used internally by TipTap)
- Every edit produces a **binary update** (compact diff), not a full snapshot
- Updates from any client can be applied in any order and will converge to the same result — **no conflicts, no last-write-wins**

### y-websocket protocol (wire format)
```
Message byte layout (lib0 variable-length encoding):
  [messageType: varint][payload...]

messageType 0 = Sync
  payload[0] = 0  →  syncStep1:  client sends its state vector
  payload[0] = 1  →  syncStep2:  server replies with missing updates
  payload[0] = 2  →  update:     incremental update (bidirectional)

messageType 1 = Awareness
  payload = encoded awareness update (cursor pos, user name/color)
```

**Connection flow:**
1. Client opens WS to `/ws/<docId>`
2. Server → Client: `syncStep1` (server's state vector)
3. Client → Server: `syncStep2` (client's diff based on server's SV)
4. Client → Server: `syncStep1` (client's own state vector)
5. Server → Client: `syncStep2` (server's diff based on client's SV)
6. Both sides are now **fully synced**
7. Every subsequent edit → `update` message → broadcast to all peers

### Persistence
- `yjsManager` calls `Y.encodeStateAsUpdate(ydoc)` and stores it as `BYTEA` in PostgreSQL
- Flush happens: (a) every 5 s if dirty, (b) on last client disconnect, (c) on `SIGTERM`
- On first load: `Y.applyUpdate(ydoc, storedBytes)` restores exact document state

### Redis pub/sub (multi-server)
```
Client → Server A: Yjs update
  Server A: applyUpdate(doc) + PUBLISH "ydoc:<docId>" bytes
    Redis → Server B: receives bytes
      Server B: applyUpdate(doc, bytes, origin='redis')
        Server B: broadcasts to its own WS clients
```
The `origin !== 'redis'` guard prevents rebroadcast loops.

## Quick Start

### Development
```bash
# 1. Start PostgreSQL + Redis
docker-compose up postgres redis -d

# 2. Backend
cd backend
cp .env.example .env
npm install
npm run migrate
npm run dev        # http://localhost:4000

# 3. Frontend
cd frontend
npm install
npm run dev        # http://localhost:5173
```

### Production (Docker)
```bash
docker-compose up --build
# Frontend: http://localhost:5173
# Backend:  http://localhost:4000
```

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET    | `/api/documents` | List all documents |
| POST   | `/api/documents` | Create document (`{ title }`) |
| GET    | `/api/documents/:id` | Get document metadata |
| PATCH  | `/api/documents/:id` | Update title |
| DELETE | `/api/documents/:id` | Delete document |
| GET    | `/api/documents/:id/snapshots` | List version history |
| WS     | `/ws/:id` | Real-time collaboration socket |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 4000 | HTTP + WS server port |
| `PG_HOST` | localhost | PostgreSQL host |
| `PG_DATABASE` | collab_editor | Database name |
| `REDIS_HOST` | localhost | Redis host |
| `PERSIST_INTERVAL_MS` | 5000 | How often to flush to DB |
| `DOC_IDLE_TIMEOUT_MS` | 30000 | Unload idle docs after this delay |

## Scaling

To run multiple backend instances behind a load balancer:
1. Ensure all instances share the same **PostgreSQL** and **Redis**
2. Use **sticky sessions** OR rely on Redis pub/sub (both work)
3. Redis pub/sub ensures every instance's in-memory Y.Doc stays in sync
