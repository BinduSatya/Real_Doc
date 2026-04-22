/**
 * YjsManager
 * ----------
 * Central registry for all live Y.Doc instances.
 *
 * Responsibilities:
 *   • Load doc state from PostgreSQL on first connection
 *   • Flush state to PostgreSQL on a timer and on last-client-disconnect
 *   • Fan out updates to all local WebSocket connections for that doc
 *   • Publish outgoing updates to Redis (for peer servers)
 *   • Apply incoming Redis updates from peer servers
 *   • Unload idle docs from memory
 */

import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';

import { pool } from './db.js';
import redis from './redis.js';

const PERSIST_INTERVAL   = parseInt(process.env.PERSIST_INTERVAL_MS  || '5000');
const IDLE_TIMEOUT       = parseInt(process.env.DOC_IDLE_TIMEOUT_MS   || '30000');
const SNAPSHOT_INTERVAL  = parseInt(process.env.SNAPSHOT_INTERVAL_MS || '60000');
const SNAPSHOT_CHANGES   = parseInt(process.env.SNAPSHOT_CHANGE_COUNT || '12');

/**
 * @typedef {Object} DocEntry
 * @property {Y.Doc}                     ydoc
 * @property {awarenessProtocol.Awareness} awareness
 * @property {Set<import('ws').WebSocket>} connections   — live WS clients for this doc
 * @property {NodeJS.Timeout|null}        persistTimer
 * @property {NodeJS.Timeout|null}        idleTimer
 * @property {boolean}                   dirty          — unsaved changes exist
 */

/** @type {Map<string, DocEntry>} */
const docs = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function encodeState(ydoc) {
  return Buffer.from(Y.encodeStateAsUpdate(ydoc));
}

async function loadFromDB(docId) {
  const res = await pool.query(
    'SELECT ydoc_state FROM documents WHERE id = $1',
    [docId]
  );
  return res.rows[0]?.ydoc_state ?? null; // Buffer or null
}

async function getCurrentState(docId) {
  const entry = docs.get(docId);
  if (entry) return encodeState(entry.ydoc);
  return loadFromDB(docId);
}

async function saveToDB(docId, entry) {
  const ydoc = entry.ydoc;
  const state = encodeState(ydoc);
  await pool.query(
    `UPDATE documents
        SET ydoc_state = $1, updated_at = NOW()
      WHERE id = $2`,
    [state, docId]
  );

  const shouldSnapshot =
    entry.changesSinceSnapshot >= SNAPSHOT_CHANGES ||
    Date.now() - entry.lastSnapshotAt >= SNAPSHOT_INTERVAL;

  if (shouldSnapshot) {
    await pool.query(
      `INSERT INTO document_snapshots (document_id, version_number, ydoc_state, label)
       SELECT $1, COALESCE(MAX(version_number), 0) + 1, $2, $3
         FROM document_snapshots
        WHERE document_id = $1`,
      [docId, state, 'Autosave']
    );
    entry.changesSinceSnapshot = 0;
    entry.lastSnapshotAt = Date.now();
  }
}

function scheduleIdleUnload(docId) {
  const entry = docs.get(docId);
  if (!entry) return;

  clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(async () => {
    const e = docs.get(docId);
    if (!e || e.connections.size > 0) return; // clients reconnected
    if (e.dirty) await saveToDB(docId, e);
    clearInterval(e.persistTimer);
    e.ydoc.destroy();
    docs.delete(docId);
    await redis.unsubscribeFromDoc(docId);
    console.log(`[YjsManager] Unloaded idle doc ${docId}`);
  }, IDLE_TIMEOUT);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get (or create) a DocEntry for the given document ID.
 * If not yet in memory, loads state from PostgreSQL and subscribes to Redis.
 *
 * @param {string} docId
 * @returns {Promise<DocEntry>}
 */
async function getOrCreate(docId) {
  if (docs.has(docId)) return docs.get(docId);

  const ydoc       = new Y.Doc();
  const awareness  = new awarenessProtocol.Awareness(ydoc);

  // Load persisted state
  const storedState = await loadFromDB(docId);
  if (storedState) {
    Y.applyUpdate(ydoc, storedState);
    console.log(`[YjsManager] Loaded doc ${docId} from DB (${storedState.length} bytes)`);
  }

  const entry = {
    ydoc,
    awareness,
    connections: new Set(),
    persistTimer: null,
    idleTimer:    null,
    dirty:        false,
    changesSinceSnapshot: 0,
    lastSnapshotAt: Date.now(),
  };

  // Periodic flush to PostgreSQL
  entry.persistTimer = setInterval(async () => {
    if (entry.dirty) {
      await saveToDB(docId, entry);
      entry.dirty = false;
    }
  }, PERSIST_INTERVAL);

  docs.set(docId, entry);

  // Subscribe to peer-server updates via Redis
  await redis.subscribeToDoc(docId, (update) => {
    // Apply without re-broadcasting to Redis (origin tag prevents loops)
    Y.applyUpdate(ydoc, update, 'redis');
  });

  // When the local doc changes, propagate to Redis peers + mark dirty
  ydoc.on('update', (update, origin) => {
    entry.dirty = true;
    entry.changesSinceSnapshot += 1;
    if (origin !== 'redis') {
      redis.publishUpdate(docId, update);
    }
  });

  return entry;
}

/**
 * Register a new WebSocket connection for a document.
 * @param {string}                  docId
 * @param {import('ws').WebSocket}  ws
 */
function addConnection(docId, ws) {
  const entry = docs.get(docId);
  if (!entry) return;
  clearTimeout(entry.idleTimer);
  entry.connections.add(ws);
}

/**
 * Remove a WebSocket connection. Triggers idle-unload if last client.
 * @param {string}                  docId
 * @param {import('ws').WebSocket}  ws
 */
function removeConnection(docId, ws) {
  const entry = docs.get(docId);
  if (!entry) return;
  entry.connections.delete(ws);
  if (entry.connections.size === 0) scheduleIdleUnload(docId);
}

/**
 * Broadcast a binary message to all connections of a doc EXCEPT the sender.
 * @param {string}                  docId
 * @param {Uint8Array|Buffer}       msg
 
 * @param {import('ws').WebSocket}  [except]
 */
function broadcast(docId, msg, except) {
  const entry = docs.get(docId);
  if (!entry) return;
  for (const conn of entry.connections) {
    if (conn !== except && conn.readyState === 1 /* OPEN */) {
      conn.send(msg, { binary: true });
    }
  }
}

function getActiveUserCount(docId) {
  const entry = docs.get(docId);
  if (!entry) return 0;

  const userIds = new Set();
  for (const state of entry.awareness.getStates().values()) {
    if (state?.user?.id) {
      userIds.add(state.user.id);
    }
  }

  return userIds.size;
}

async function replaceDocumentState(docId, state) {
  await pool.query(
    `UPDATE documents
        SET ydoc_state = $1, updated_at = NOW()
      WHERE id = $2`,
    [state, docId]
  );

  const entry = docs.get(docId);
  if (!entry) return;

  clearInterval(entry.persistTimer);
  clearTimeout(entry.idleTimer);
  docs.delete(docId);
  await redis.unsubscribeFromDoc(docId);

  for (const conn of entry.connections) {
    if (conn.readyState === 1 /* OPEN */) {
      conn.close(4002, 'Document version restored');
    }
  }
  entry.ydoc.destroy();
}

/**
 * Flush all dirty docs to PostgreSQL (call on SIGTERM).
 */
async function flushAll() {
  const promises = [];
  for (const [docId, entry] of docs.entries()) {
    if (entry.dirty) promises.push(saveToDB(docId, entry));
  }
  await Promise.allSettled(promises);
  console.log('[YjsManager] All docs flushed');
}

export {
  getOrCreate,
  addConnection,
  removeConnection,
  broadcast,
  getActiveUserCount,
  getCurrentState,
  replaceDocumentState,
  flushAll,
  docs,
};

export default {
  getOrCreate,
  addConnection,
  removeConnection,
  broadcast,
  getActiveUserCount,
  getCurrentState,
  replaceDocumentState,
  flushAll,
  docs,
};
