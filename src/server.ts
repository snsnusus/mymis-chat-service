// Composes the service: the HTTP app, the WebSocket server, and the feature handlers
// they share. Builds everything but doesn't listen; index.ts does that.

import { createServer, type Server } from "node:http";
import type { WebSocketServer } from "ws";
import type { TokenVerifier } from "./auth/token.verifier.js";
import { createChatHandlers } from "./chat/chat.handlers.js";
import { createChatRouter } from "./chat/chat.routes.js";
import type { MessageStore } from "./chat/message.store.js";
import type { Config } from "./config.js";
import { createHttpApp } from "./http/app.js";
import type { MongoConnection } from "./infrastructure/mongo.js";
import { createPresenceHandlers } from "./presence/presence.handlers.js";
import type { PresenceStore } from "./presence/presence.store.js";
import { attachSocketServer } from "./ws/socket.server.js";
import { createSocketRegistry } from "./ws/socket.registry.js";

export interface ChatServer {
  httpServer: Server;
  wss: WebSocketServer;
}

// Everything the server needs from the outside, injected so tests can pass fakes.
export interface ChatServerDeps {
  config: Config;
  presence: PresenceStore;
  verifyToken: TokenVerifier;
  mongo: Pick<MongoConnection, "isAvailable">;
  messageStore: MessageStore;
  authTimeoutMs?: number; // optional override for tests
}

export function createChatServer(deps: ChatServerDeps): ChatServer {
  const { config, presence, verifyToken, mongo, messageStore, authTimeoutMs } =
    deps;

  // HTTP: cross-cutting concerns plus each feature's router.
  const app = createHttpApp({
    config,
    presence,
    mongo,
    routers: [createChatRouter({ verifyToken, messageStore })],
  });
  const httpServer = createServer(app);

  // One registry, shared by the socket server (who's connected) and the handlers (who to send to).
  const registry = createSocketRegistry();

  const wss = attachSocketServer(httpServer, {
    config,
    verifyToken,
    registry,
    presenceHandlers: createPresenceHandlers({ presence, registry }),
    chatHandlers: createChatHandlers({ messageStore, registry }),
    authTimeoutMs,
  });

  return { httpServer, wss };
}
