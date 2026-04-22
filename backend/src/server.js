import 'dotenv/config';

import http from 'node:http';
import { parse } from 'node:url';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';

import { ping, pool } from './db.js';
import redis from './redis.js';
import * as yjsManager from './yjsManager.js';
import { setupConnection } from './wsHandler.js';
import { verifyJwt } from './auth.js';
import authRoutes from './routes/auth.js';
import documentRoutes from './routes/documents.js';

const PORT = parseInt(process.env.PORT || '4000');

// ─────────────────────────────────────────────────────────────────────────────
// Express app
// ─────────────────────────────────────────────────────────────────────────────
const app = express();

app.use(cors({ origin: process.env.CORS_ORIGIN || true, credentials: true }));
app.use(express.json());

// Health-check
app.get('/health', async (_req, res) => {
  const dbTime = await ping().catch(() => null);
  res.json({ status: 'ok', db: dbTime ? 'connected' : 'error', time: dbTime });
});

// REST API
app.use('/api/auth', authRoutes);
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
async function authenticateSocket(req, docId, token) {
  const payload = verifyJwt(token, 'access');
  const result = await pool.query(
    `SELECT u.id, u.email, u.display_name, u.token_version, dm.role
       FROM users u
       JOIN document_members dm ON dm.user_id = u.id
      WHERE u.id = $1 AND dm.document_id = $2`,
    [payload.sub, docId]
  );
  const user = result.rows[0];
  if (!user || user.token_version !== payload.tokenVersion) {
    throw new Error('Unauthorized websocket');
  }
  return { ...user, accessExp: payload.exp };
}

server.on('upgrade', async (req, socket, head) => {
  const { pathname, query } = parse(req.url, true);
  const match = pathname.match(/^\/ws\/([0-9a-f-]{36})$/i);

  if (!match) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  const docId = match[1];
  let socketUser;

  try {
    socketUser = await authenticateSocket(req, docId, query.token);
  } catch (err) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, docId, socketUser);
  });
});

wss.on('connection', (ws, _req, docId, socketUser) => {
  setupConnection(ws, docId, socketUser);
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
