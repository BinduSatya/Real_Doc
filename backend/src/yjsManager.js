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

const Y                  = require('yjs');
const awarenessProtocol  = require('y-protocols/awareness');
const { pool }           = require('./db');
const redis              = require('./redis');

const PERSIST_INTERVAL   = parseInt(process.env.PERSIST_INTERVAL_MS  || '5000');
const IDLE_TIMEOUT       = parseInt(process.env.DOC_IDLE_TIMEOUT_MS   || '30000');

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

async function saveToDB(docId, ydoc) {
  const state = encodeState(ydoc);
  await pool.query(
    `UPDATE documents
        SET ydoc_state = $1, updated_at = NOW()
      WHERE id = $2`,
    [state, docId]
  );
}

function scheduleIdleUnload(docId) {
  const entry = docs.get(docId);
  if (!entry) return;

  clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(async () => {
    const e = docs.get(docId);
    if (!e || e.connections.size > 0) return; // clients reconnected
    if (e.dirty) await saveToDB(docId, e.ydoc);
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
  };

  // Periodic flush to PostgreSQL
  entry.persistTimer = setInterval(async () => {
    if (entry.dirty) {
      await saveToDB(docId, ydoc);
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
  awarenessProtocol.removeAwarenessStates(entry.awareness, [ws.__clientId], null);
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

/**
 * Flush all dirty docs to PostgreSQL (call on SIGTERM).
 */
async function flushAll() {
  const promises = [];
  for (const [docId, entry] of docs.entries()) {
    if (entry.dirty) promises.push(saveToDB(docId, entry.ydoc));
  }
  await Promise.allSettled(promises);
  console.log('[YjsManager] All docs flushed');
}

module.exports = { getOrCreate, addConnection, removeConnection, broadcast, flushAll, docs };
