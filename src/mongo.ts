// Creates and connects the single MongoDB client the whole service shares.

import { MongoClient, type Db } from "mongodb";
import type { Config } from "./config.js";

export interface MongoConnection {
  client: MongoClient; // needed for close() at shutdown
  db: Db; // the database our collections live in
  isAvailable(): Promise<boolean>;
}

export async function connectMongo(config: Config): Promise<MongoConnection> {
  const client = new MongoClient(config.mongoUrl, {
    // How long an operation waits to find a reachable server before failing.
    // The default is 30 s; 5 s keeps a down database from stalling requests (and /health).
    serverSelectionTimeoutMS: 5_000,
  });

  // The driver's monitor checks the server in the background (every 10 s while healthy, more
  // often while it's down) and emits an event for each check. Log only the TRANSITIONS, so an
  // outage produces one "lost" line and one "resumed" line, not a line every few seconds.
  let reachable = true;

  client.on("serverHeartbeatFailed", () => {
    if (reachable) {
      reachable = false;
      console.error("[mongo] ECONNREFUSED: connection failed, retrying");
    }
  });

  client.on("serverHeartbeatSucceeded", () => {
    if (!reachable) {
      reachable = true;
      console.log("[mongo] connected");
    }
  });

  // Unlike the Redis client, connect() does NOT retry forever: if Mongo is unreachable it
  // rejects after serverSelectionTimeoutMS, and startup fails with a clear error.
  // AFTER a successful connect, the driver monitors the server and reconnects on its own.
  await client.connect();

  // client.db() with no name uses the database from the connection string's path:
  // mongodb://localhost:27018/mymis_chat → "mymis_chat". (No path → a database called "test".)
  const db = client.db();

  console.log(`[mongo] connected to database "${db.databaseName}"`);

  return {
    client,
    db,

    // ping is the lightest possible command: "are you there?". Used by /health.
    // Never throws: any failure means "not available". While Mongo is down, this takes up to
    // serverSelectionTimeoutMS (5 s) to give up, so /health is slow during an outage.
    async isAvailable(): Promise<boolean> {
      try {
        await db.command({ ping: 1 });
        return true;
      } catch {
        return false;
      }
    },
  };
}
