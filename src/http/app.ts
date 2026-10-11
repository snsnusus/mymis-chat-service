// Builds the Express app: cross-cutting HTTP concerns (CORS, health, error handling)
// plus the routers that features provide.

import cors from "cors";
import express, {
  type ErrorRequestHandler,
  type Express,
  type Router,
} from "express";
import type { Config } from "../config.js";
import type { MongoConnection } from "../infrastructure/mongo.js";
import type { PresenceStore } from "../presence/presence.store.js";

export interface HttpAppDeps {
  config: Config;
  presence: PresenceStore;
  mongo: Pick<MongoConnection, "isAvailable">;
  routers: Router[]; // one per feature, mounted in order
}

export function createHttpApp({
  config,
  presence,
  mongo,
  routers,
}: HttpAppDeps): Express {
  const app = express();

  // Lets allowed browser origins (the portal) call these routes; answers preflight requests.
  app.use(cors({ origin: config.allowedOrigins }));

  // Reports each datastore's state; 503 if either is down.
  app.get("/health", async (_req, res) => {
    const redisUp = presence.isAvailable();
    const mongoUp = await mongo.isAvailable();
    const body = {
      status: redisUp && mongoUp ? "ok" : "unavailable",
      redis: redisUp ? "up" : "down",
      mongo: mongoUp ? "up" : "down",
    };
    res.status(redisUp && mongoUp ? 200 : 503).json(body);
  });

  // Feature routes.
  for (const router of routers) {
    app.use(router);
  }

  // Any request no route matched: JSON 404 instead of Express's HTML "Cannot GET /".
  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  // Registered last: catches errors thrown (or rejected) in any route above
  // and answers with JSON instead of Express's default HTML error page.
  // It MUST declare 4 parameters: Express recognizes error handlers only by their
  // parameter count. With 3, it runs as normal middleware (that was a bug).
  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    console.error("[http] unhandled error:", error);
    res.status(500).json({ error: "internal_error" });
  };
  app.use(errorHandler);

  return app;
}
