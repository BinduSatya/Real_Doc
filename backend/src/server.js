import 'dotenv/config';

import http from 'node:http';
import { parse } from 'node:url';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';

import { ping } from './db.js';
import redis from './redis.js';
import * as yjsManager from './yjsManager.js';
import { setupConnection } from './wsHandler.js';
import documentRoutes from './routes/documents.js';

const PORT = parseInt(process.env.PORT || '4000');

// ─────────────────────────────────────────────────────────────────────────────
// Express app
// ─────────────────────────────────────────────────────────────────────────────
const app = express();

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());

// Health-check
app.get('/health', async (_req, res) => {
  const dbTime = await ping().catch(() => null);
  res.json({ status: 'ok', db: dbTime ? 'connected' : 'error', time: dbTime });
});

// REST API
app.use('/api/documents', documentRoutes);

// ─────────────────────────────────────────────────────────────────────────────
// HTTP + WebSocket server (single port, upgraded for WS)
// ─────────────────────────────────────────────────────────────────────────────
const server = http.createServer(app);

const wss = new WebSocketServer({ noServer: true });

/**
 * WebSocket URL format:  ws://host:PORT/ws/<documentId>
 *
 * The documentId must match a UUID in the `documents` table.
 */
server.on('upgrade', (req, socket, head) => {
  const { pathname } = parse(req.url);
  const match = pathname.match(/^\/ws\/([0-9a-f-]{36})$/i);

  if (!match) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  const docId = match[1];

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, docId);
  });
});

wss.on('connection', (ws, _req, docId) => {
  setupConnection(ws, docId);
});

// ─────────────────────────────────────────────────────────────────────────────
// Startup
// ─────────────────────────────────────────────────────────────────────────────
async function start() {
  // Connect Redis (non-fatal if unavailable)
  await redis.connect();

  // Verify DB
  try {
    const t = await ping();
    console.log(`[DB] PostgreSQL connected (server time: ${t})`);
  } catch (err) {
    console.error('[DB] Cannot connect to PostgreSQL:', err.message);
    process.exit(1);
  }

  server.listen(PORT, () => {
    console.log(`[Server] HTTP + WS listening on http://localhost:${PORT}`);
    console.log(`[Server] WS endpoint: ws://localhost:${PORT}/ws/<documentId>`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Graceful shutdown
// ─────────────────────────────────────────────────────────────────────────────
async function shutdown(signal) {
  console.log(`\n[Server] ${signal} received — shutting down gracefully`);

  // Stop accepting new connections
  server.close();

  // Flush all dirty Yjs docs to PostgreSQL
  await yjsManager.flushAll();

  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

start();
