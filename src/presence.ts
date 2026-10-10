// Presence storage: who is online. The rest of the service talks to this,
// never to Redis directly, so the storage details live in one place.

import type { RedisClient } from "./redis.js";

// A Redis HASH: field = userId, value = number of currently open connections for that user.
// Counting connections (instead of a plain set of users) is what makes multiple tabs work:
// a user is online while their count is above 0.
// New key name (was chat:presence:online) because the data shape changed from a set to a hash.
const CONNECTIONS_KEY = "chat:presence:connections";

export function createPresenceStore(redis: RedisClient) {
  return {
    // Records one more open connection for the user.
    // Returns true if this was their FIRST connection, i.e. they just came online.
    async addConnection(userId: string): Promise<boolean> {
      // HINCRBY adds 1 and returns the new value atomically. A missing field counts as 0.
      const count = await redis.hIncrBy(CONNECTIONS_KEY, userId, 1);
      return count === 1;
    },

    // Records one fewer open connection for the user.
    // Returns true if that was their LAST connection, i.e. they just went offline.
    async removeConnection(userId: string): Promise<boolean> {
      const count = await redis.hIncrBy(CONNECTIONS_KEY, userId, -1);
      // Zero entries are kept, not deleted (see the race explained in the step notes).
      // <= 0 rather than === 0 so an unexpected negative count still reads as offline.
      return count <= 0;
    },

    // Every user with at least one open connection.
    async listOnline(): Promise<string[]> {
      // HGETALL returns the whole hash as an object: { "1": "2", "2": "0" }.
      // Redis stores numbers as strings, so convert before comparing.
      const counts = await redis.hGetAll(CONNECTIONS_KEY);
      return Object.entries(counts)
        .filter(([, count]) => Number(count) > 0)
        .map(([userId]) => userId);
    },
  };
}

// The store's type, derived from the factory so server.ts can depend on "a presence store".
export type PresenceStore = ReturnType<typeof createPresenceStore>;
