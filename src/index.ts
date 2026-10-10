// Entry point: loads and validates config, connects Redis, builds the server, starts listening,
// and shuts everything down cleanly on Ctrl+C or a deploy. The .NET equivalent of Program.cs.

import { loadConfig } from "./config.js";
import { createPresenceStore } from "./presence.js";
import { connectRedis } from "./redis.js";
import { createChatServer } from "./server.js";
import { createTokenVerifier } from "./auth.js";

// How long a graceful shutdown may take before we force the process to exit.
const SHUTDOWN_TIMEOUT_MS = 10_000;

const nodeVersion: string = process.version;
const bootedAt: string = new Date().toISOString();

// Throws (and stops the process) if any env variable is missing or invalid.
const config = loadConfig(process.env);

// Logged first, so a Redis outage at startup reads as "waiting" rather than silence.
console.log("[mymis-chat-service] connecting to Redis...");
const redis = await connectRedis(config);
const presence = createPresenceStore(redis);
// Built once from config: the signing key is encoded a single time, not per connection.
const verifyToken = createTokenVerifier(config.jwt);

// Stale presence: while this service runs as a SINGLE instance, it owns every live connection.
// Any counts already in Redis belong to connections that died with a previous run (a crash,
// a watch-mode restart), so start from zero.
// KNOWN LIMITATION: once several instances share one Redis (M6 scale-out), each startup would
// wipe the others' counts. That needs per-instance tracking and is part of the M6 design.
await presence.reset();

const { httpServer, wss } = createChatServer(config, presence, verifyToken);

httpServer.listen(config.port, () => {
  console.log(
    `[mymis-chat-service] ${config.nodeEnv} mode, listening on http://localhost:${config.port}, booted at ${bootedAt} on Node ${nodeVersion}`,
  );
});

// ── Graceful shutdown ──

// Guards against a second signal (e.g. pressing Ctrl+C twice) starting a second shutdown.
let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`[mymis-chat-service] ${signal} received, shutting down`);

  // Safety net: if any step below hangs, exit anyway after the timeout.
  // unref() means this timer alone won't keep the process alive: if everything closes in time,
  // the process exits normally without waiting for it.
  setTimeout(() => {
    console.error("[mymis-chat-service] shutdown timed out, forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  // 1. Tell every client we're going away. 1001 ("going away") is the standard close code
  //    for a server shutting down, which tells the portal it can reconnect shortly.
  for (const client of wss.clients) {
    client.close(1001, "Server shutting down");
  }

  // 2. Stop accepting new WebSocket connections. This also emits the server's 'close' event,
  //    which stops the heartbeat timer (the wss.on('close') you added in 6b).
  wss.close();

  // 3. Stop the HTTP server. close() takes a callback, not a Promise, so we wrap it in one
  //    to be able to await it.
  await new Promise<void>((resolve) => {
    httpServer.close(() => {
      resolve();
    });
  });

  // 4. Disconnect Redis last, after everything that might still use it.
  await redis.close();

  console.log("[mymis-chat-service] shutdown complete");
  // No process.exit() here on purpose: with the server, timers and Redis closed, Node has
  // nothing left to do and exits by itself, with code 0 (success).
}

// SIGINT = Ctrl+C in a terminal. SIGTERM = what Docker, App Service and other hosts send
// to stop a process (and what dev watch mode sends before restarting).
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    // Same boundary pattern as the socket handlers: a sync listener with .catch().
    shutdown(signal).catch((error: unknown) => {
      console.error("[mymis-chat-service] shutdown failed:", error);
      process.exit(1);
    });
  });
}
