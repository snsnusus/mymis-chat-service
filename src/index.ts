import { loadConfig } from "./config.js";
import { createPresenceStore } from "./presence.js";
import { connectRedis } from "./redis.js";
import { createChatServer } from "./server.js";

// Entry point: loads and validates config, then (in later steps) starts the server.
// tsx can run it in dev, and tsc can compile it to dist/index.js for production.

// process.version is a Node built-in (typed by @types/node), e.g. "v24.1.0".
const nodeVersion: string = process.version;
// new Date().toISOString() gives a UTC timestamp like "2026-10-10T06:50:00.000Z".
const bootedAt: string = new Date().toISOString();

const config = loadConfig(process.env);
const redis = await connectRedis(config);
const presence = createPresenceStore(redis);

const { httpServer } = createChatServer(config, presence);

// listen() starts accepting connections; the callback runs once the port is bound.
httpServer.listen(config.port, () => {
  console.log(
    `[mymis-chat-service] ${config.nodeEnv} mode, listening on http://localhost:${config.port}, booted at ${bootedAt} on Node ${nodeVersion}`,
  );
});
