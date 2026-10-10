// Creates and connects the single Redis client the whole service shares.

import { createClient } from "redis";
import type { Config } from "./config.js";

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

  // Called on every failed connection attempt (the client retries on its own) and on any later
  // connection error. Log ONE line per failure instead of a full stack trace, so repeated
  // retries stay readable. A refused localhost connection arrives as an AggregateError
  // (IPv6 + IPv4 both failed) with an empty message, so prefer its code (e.g. ECONNREFUSED).
  client.on("error", (error: Error) => {
    const code =
      "code" in error && typeof error.code === "string"
        ? error.code
        : error.name;
    console.error(
      `[redis] ${code}: ${error.message || "connection failed"}, retrying`,
    );
  });

  // connect() opens the TCP connection. It's async, so callers must await it
  // before sending commands.
  await client.connect();
  console.log("[redis] connected");

  return client;
}
