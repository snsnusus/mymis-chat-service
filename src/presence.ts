// Presence storage: who is online. The rest of the service talks to this,
// never to Redis directly, so the storage details live in one place.

import type { RedisClient } from "./redis.js";

// A Redis SET holding the ids of online users.
// The "chat:presence:" prefix namespaces our keys in case the Redis instance is ever shared,
// and differs from the portal's "online_users" key so old and new servers never share data.
const ONLINE_USERS_KEY = "chat:presence:online";

// A factory function returning an object of methods: the functional equivalent of a class
// whose constructor takes a RedisClient. The redis variable is captured by the closure.
export function createPresenceStore(redis: RedisClient) {
  return {
    // SADD adds a member to a set; adding an existing member does nothing.
    async markOnline(userId: string): Promise<void> {
      await redis.sAdd(ONLINE_USERS_KEY, userId);
    },

    // SREM removes a member from a set.
    async markOffline(userId: string): Promise<void> {
      await redis.sRem(ONLINE_USERS_KEY, userId);
    },

    // SMEMBERS returns every member of the set.
    async listOnline(): Promise<string[]> {
      return redis.sMembers(ONLINE_USERS_KEY);
    },
  };
}

// The store's type, derived from the factory so server.ts can depend on "a presence store".
export type PresenceStore = ReturnType<typeof createPresenceStore>;
