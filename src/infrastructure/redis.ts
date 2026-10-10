// Creates and connects the single Redis client the whole service shares.

import { createClient } from "redis";
import type { Config } from "../config.js";

// A tiny NON-generic wrapper around createClient. createClient itself is generic, so
// ReturnType<typeof createClient> would give the widest possible client type, which doesn't
// match the concrete client our call actually returns. ReturnType of this wrapper is exactly
// the concrete type (no modules, RESP 3), so the alias below always matches what we create.
function buildClient(url: string) {
  return createClient({ url });
}

// Other files import this alias instead of spelling out the long generic type.
export type RedisClient = ReturnType<typeof buildClient>;

export async function connectRedis(config: Config): Promise<RedisClient> {
  const client = buildClient(config.redisUrl);

  // 1. KEEP THIS: without an 'error' listener, any Redis disconnect crashes the process.
  client.on("error", (error: Error) => {
    const code =
      "code" in error && typeof error.code === "string"
        ? error.code
        : error.name;
    console.error(
      `[redis] ${code}: ${error.message || "connection failed"}, retrying`,
    );
  });

  // 2. NEW: logs the first connection and every reconnect.
  let hasConnectedBefore = false;
  client.on("ready", () => {
    console.log(
      hasConnectedBefore ? "[redis] connection resumed" : "[redis] connected",
    );
    hasConnectedBefore = true;
  });

  await client.connect();

  return client;
}
