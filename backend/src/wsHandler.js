/**
 * wsHandler.js
 * ------------
 * Implements the y-websocket wire protocol for a single WebSocket connection.
 *
 * Message format (binary, using lib0 variable-length encoding):
 *   [messageType: varint] [payload...]
 *
 * messageType:
 *   0 = messageSync       — Yjs document sync (step1 / step2 / update)
 *   1 = messageAwareness  — cursor / user presence updates
 *
 * Sync sub-types (first byte of payload):
 *   0 = syncStep1  — client → server:  "here is my state vector"
 *   1 = syncStep2  — server → client:  "here is everything you're missing"
 *   2 = syncUpdate — bidirectional:    incremental Yjs update
 */

const Y                  = require('yjs');
const syncProtocol       = require('y-protocols/sync');
const awarenessProtocol  = require('y-protocols/awareness');
const encoding           = require('lib0/encoding');
const decoding           = require('lib0/decoding');
const { v4: uuidv4 }     = require('uuid');
const yjsManager         = require('./yjsManager');

const messageSync       = 0;
const messageAwareness  = 1;

// ─────────────────────────────────────────────────────────────────────────────
// Message builders
// ─────────────────────────────────────────────────────────────────────────────

function buildSyncStep1(ydoc) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, messageSync);
  syncProtocol.writeSyncStep1(enc, ydoc);
  return encoding.toUint8Array(enc);
}

function buildSyncStep2(ydoc, stateVector) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, messageSync);
  syncProtocol.writeSyncStep2(enc, ydoc, stateVector);
  return encoding.toUint8Array(enc);
}

function buildUpdate(update) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, messageSync);
  syncProtocol.writeUpdate(enc, update);
  return encoding.toUint8Array(enc);
}

function buildAwareness(awareness, clientIds) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, messageAwareness);
  encoding.writeVarUint8Array(enc,
    awarenessProtocol.encodeAwarenessUpdate(awareness, clientIds)
  );
  return encoding.toUint8Array(enc);
}

// ─────────────────────────────────────────────────────────────────────────────
// Connection setup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Called once per incoming WebSocket upgrade.
 * @param {import('ws').WebSocket} ws
 * @param {string}                 docId   — extracted from URL path
 */
async function setupConnection(ws, docId) {
  // Assign a stable numeric clientId for this WS session
  ws.__clientId = Math.floor(Math.random() * 0xffffffff);

  const entry = await yjsManager.getOrCreate(docId);
  const { ydoc, awareness } = entry;

  yjsManager.addConnection(docId, ws);

  // ── Step 1: send server's state vector so client can diff ─────────────────
  ws.send(buildSyncStep1(ydoc), { binary: true });

  // ── Step 1b: send current awareness state to new client ──────────────────
  const awarenessClients = [...awareness.states.keys()];
  if (awarenessClients.length > 0) {
    ws.send(buildAwareness(awareness, awarenessClients), { binary: true });
  }

  // ── Listen for local ydoc updates → forward to this client ───────────────
  const docUpdateHandler = (update, origin) => {
    // Don't echo back to the originating connection
    if (origin === ws) return;
    if (ws.readyState !== ws.OPEN) return;
    ws.send(buildUpdate(update), { binary: true });
  };
  ydoc.on('update', docUpdateHandler);

  // ── Listen for awareness changes → broadcast ─────────────────────────────
  const awarenessUpdateHandler = ({ added, updated, removed }) => {
    const changedClients = [...added, ...updated, ...removed];
    const msg = buildAwareness(awareness, changedClients);
    yjsManager.broadcast(docId, msg); // broadcast to ALL including sender
  };
  awareness.on('update', awarenessUpdateHandler);

  // ── Incoming messages from this client ───────────────────────────────────
  ws.on('message', (data) => {
    try {
      const msg = data instanceof Buffer ? new Uint8Array(data) : data;
      const dec = decoding.createDecoder(msg);
      const msgType = decoding.readVarUint(dec);

      switch (msgType) {
        case messageSync: {
          const enc = encoding.createEncoder();
          encoding.writeVarUint(enc, messageSync);
          const syncMsgType = syncProtocol.readSyncMessage(dec, enc, ydoc, ws);

          // If server wrote a reply (syncStep2), send it back to this client
          if (encoding.length(enc) > 1) {
            ws.send(encoding.toUint8Array(enc), { binary: true });
          }

          // If it was an update (syncMsgType === 2), also broadcast to peers
          if (syncMsgType === 2) {
            // Re-read the update bytes to broadcast
            const updateDec = decoding.createDecoder(msg);
            decoding.readVarUint(updateDec); // skip messageType
            decoding.readVarUint(updateDec); // skip syncType
            // Broadcast the original message to all other local connections
            yjsManager.broadcast(docId, msg, ws);
          }
          break;
        }

        case messageAwareness: {
          const awarenessUpdate = decoding.readVarUint8Array(dec);
          awarenessProtocol.applyAwarenessUpdate(awareness, awarenessUpdate, ws);
          // Relay awareness to other connections
          yjsManager.broadcast(docId, msg, ws);
          break;
        }

        default:
          console.warn(`[WS] Unknown message type: ${msgType}`);
      }
    } catch (err) {
      console.error('[WS] Error processing message:', err.message);
    }
  });

  // ── Cleanup on disconnect ─────────────────────────────────────────────────
  ws.on('close', () => {
    ydoc.off('update', docUpdateHandler);
    awareness.off('update', awarenessUpdateHandler);
    awarenessProtocol.removeAwarenessStates(awareness, [ws.__clientId], ws);
    yjsManager.removeConnection(docId, ws);
    console.log(`[WS] Client disconnected from doc ${docId}`);
  });

  ws.on('error', (err) => {
    console.error(`[WS] Client error on doc ${docId}:`, err.message);
  });

  console.log(`[WS] Client connected to doc ${docId} (clientId=${ws.__clientId})`);
}

module.exports = { setupConnection };
