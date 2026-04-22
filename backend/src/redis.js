/**
 * Redis pub/sub for multi-server Yjs update propagation.
 *
 * Architecture:
 *   Server A receives a Yjs update → publishes to Redis channel "ydoc:<docId>"
 *   Server B (subscribed to same channel) receives the update →
 *     applies it to its local Y.Doc → fans out to its own WS clients
 *
 * Two separate ioredis clients are required because a client in subscriber
 * mode cannot issue regular commands.
 */
import Redis from "ioredis";

const redisConfig = {
  host: process.env.REDIS_HOST || "localhost",
  port: parseInt(process.env.REDIS_PORT || "6379"),
  password: process.env.REDIS_PASSWORD || undefined,
  tls: {},
  lazyConnect: true,
  retryStrategy: (times) => Math.min(times * 100, 3000),
};

// Publisher client — used for regular commands + PUBLISH
const publisher = new Redis(redisConfig);
// Subscriber client — dedicated to SUBSCRIBE / PSUBSCRIBE
const subscriber = new Redis(redisConfig);

publisher.on("error", (e) => console.error("[Redis pub]", e.message));
subscriber.on("error", (e) => console.error("[Redis sub]", e.message));

/**
 * Connect both clients. Called once at server start.
 * Gracefully swallows errors if Redis is unavailable so the server
 * can still operate in single-instance mode.
 */
async function connect() {
  try {
    await publisher.connect();
    await subscriber.connect();
    console.log("[Redis] Connected (pub/sub ready)");
  } catch (err) {
    console.warn(
      "[Redis] Could not connect — running in single-instance mode:",
      err.message,
    );
  }
}

/**
 * Publish a Yjs binary update to all other server instances.
 * @param {string} docId
 * @param {Uint8Array} update  raw Yjs update bytes
 */
async function publishUpdate(docId, update) {
  try {
    // Redis PUBLISH expects a string or Buffer
    await publisher.publishBuffer(`ydoc:${docId}`, Buffer.from(update));
  } catch (_) {
    // non-fatal — update will still reach local WS clients
  }
}

/**
 * Subscribe to Yjs updates for a document coming from peer servers.
 * @param {string}   docId
 * @param {Function} handler  (update: Uint8Array) => void
 */
async function subscribeToDoc(docId, handler) {
  const channel = `ydoc:${docId}`;
  await subscriber.subscribe(channel);
  subscriber.on("messageBuffer", (chan, msg) => {
    if (chan.toString() === channel) {
      handler(new Uint8Array(msg));
    }
  });
}

/**
 * Unsubscribe from a document channel (called when last client disconnects).
 */
async function unsubscribeFromDoc(docId) {
  try {
    await subscriber.unsubscribe(`ydoc:${docId}`);
  } catch (_) {}
}

export {
  connect,
  publishUpdate,
  subscribeToDoc,
  unsubscribeFromDoc,
  publisher,
};

export default {
  connect,
  publishUpdate,
  subscribeToDoc,
  unsubscribeFromDoc,
  publisher,
};
