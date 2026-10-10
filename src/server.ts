// Builds the HTTP server (Express routes) and the WebSocket server, sharing one port.
// It does NOT start listening; index.ts does that. Keeping "build" separate from "start"
// means tests can later create a server on a random port without touching index.ts.

import { createServer, type Server } from "node:http";
import express from "express";
// WebSocket is now a VALUE import (no `type`): we read the constant WebSocket.OPEN at runtime.
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { Config } from "./config.js";
import type { PresenceStore } from "./presence.js";
import {
  parseClientMessage,
  type ClientMessage,
  type ServerMessage,
} from "./protocol.js";

// Largest WebSocket message we accept, in bytes. ws closes the connection (code 1009)
// if a client sends more. Fixes design defect #8 (no size limits).
const MAX_MESSAGE_BYTES = 16 * 1024;

export interface ChatServer {
  httpServer: Server;
  wss: WebSocketServer;
}

// presence is passed in rather than created here: dependency injection by hand,
// so tests can later pass a fake store instead of a real Redis-backed one.
export function createChatServer(
  config: Config,
  presence: PresenceStore,
): ChatServer {
  // ── HTTP side ──
  const app = express();

  app.get("/health", (_req, res) => {
    if (presence.isAvailable()) {
      res.json({ status: "ok", redis: "up" });
    } else {
      res.status(503).json({ status: "unavailable", redis: "down" });
    }
  });

  const httpServer = createServer(app);

  // ── WebSocket side ──
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
  });

  // Sends one message to every open socket. Used ONLY for presence changes,
  // which are meant to be public. Chat messages (M3) will never use this.
  function broadcast(message: ServerMessage): void {
    const payload = JSON.stringify(message); // serialize once, not once per client
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  // ── Heartbeat ──
  // Tracks whether each socket answered the last ping.
  // A WeakMap holds its keys "weakly": once a socket is gone and nothing else references it,
  // its entry disappears with it during garbage collection, so closed sockets never leak memory.
  const isAlive = new WeakMap<WebSocket, boolean>();

  // Every interval: terminate sockets that missed the previous ping, ping all the others.
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      // === false (not !isAlive.get(...)): undefined means "never tracked", which isn't the
      // same as "missed a ping", so only an explicit false counts as dead.
      if (isAlive.get(client) === false) {
        console.warn("[ws] heartbeat missed, terminating connection");
        // terminate(): destroy the connection now, no close handshake (the peer isn't there
        // to answer one). It still fires the socket's 'close' event, so presence is
        // decremented by the existing close handler.
        client.terminate();
        continue;
      }
      // Assume dead until a pong proves otherwise.
      isAlive.set(client, false);
      client.ping();
    }
  }, config.heartbeatIntervalMs);

  // Stop the timer when the WebSocket server shuts down, so it doesn't keep the process alive
  // or run against a closed server. (Used by tests in M4 and by graceful shutdown in 6c.)
  wss.on("close", () => {
    clearInterval(heartbeat);
  });

  httpServer.on("upgrade", (request, socket, head) => {
    const origin = request.headers.origin;

    // Fail closed: unknown AND missing origins are rejected.
    if (origin === undefined || !config.allowedOrigins.includes(origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      console.warn(`[ws] rejected upgrade from origin: ${origin ?? "(none)"}`);
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (ws: WebSocket) => {
    console.log(`[ws] client connected (total: ${wss.clients.size})`);

    // A brand-new socket is alive by definition.
    isAlive.set(ws, true);

    // The client answered a ping: mark it alive for the next heartbeat round.
    ws.on("pong", () => {
      isAlive.set(ws, true);
    });

    // Per-connection state: which user this socket registered as.
    // Declared inside this callback, so each socket gets its own copy.
    let registeredUserId: string | null = null;

    // Handles one already-validated message. async because Redis calls are async.
    async function handleMessage(message: ClientMessage): Promise<void> {
      // switch on the discriminant: inside each case TypeScript knows the exact message shape
      // (e.g. message.userId only exists in the REGISTER_PRESENCE case).
      switch (message.type) {
        case "REGISTER_PRESENCE": {
          // One socket = one user. Re-registering as someone else would leave the first id
          // stuck "online" forever, so reject it instead of silently overwriting.
          if (registeredUserId !== null) {
            send(ws, {
              type: "ERROR",
              message: "This connection is already registered",
            });
            return;
          }
          registeredUserId = message.userId;
          const cameOnline = await presence.addConnection(message.userId);
          if (cameOnline) {
            broadcast({
              type: "USER_STATUS_CHANGE",
              userId: message.userId,
              status: "online",
            });
          }
          return;
        }

        case "GET_INITIAL_PRESENCE": {
          const userIds = await presence.listOnline();
          send(ws, { type: "INITIAL_PRESENCE_LIST", userIds });
          return;
        }
      }
    }

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        ws.close(1003, "Binary messages are not supported");
        return;
      }

      const message = parseClientMessage(rawDataToString(data));

      // Invalid JSON, unknown type or a bad field: reply to THIS client only.
      // (The portal's server broadcast anything unrecognized to everyone: defect #3.)
      if (message === null) {
        send(ws, { type: "ERROR", message: "Invalid or unsupported message" });
        return;
      }

      // ws doesn't await its listeners, so errors from an async listener would go nowhere.
      // Keep the listener synchronous and attach .catch() to the promise instead:
      // the exact rule (no-floating-promises) you tested in Step 2.
      handleMessage(message).catch((error: unknown) => {
        console.error("[ws] failed to handle message:", error);
        send(ws, { type: "ERROR", message: "Internal error" });
      });
    });

    ws.on("close", (code, reason) => {
      console.log(
        `[ws] client disconnected (code ${code}, reason "${reason.toString()}")`,
      );

      // Copy into a const: TypeScript can't be sure a `let` won't change before
      // the promise callback below runs, but a const can't change.
      const userId = registeredUserId;
      if (userId === null) {
        return; // never registered, nothing to mark offline
      }

      // Same pattern: a promise chain with .catch(), because this listener isn't async.
      presence
        .removeConnection(userId)
        .then((wentOffline) => {
          if (wentOffline) {
            broadcast({
              type: "USER_STATUS_CHANGE",
              userId,
              status: "offline",
            });
          }
        })
        .catch((error: unknown) => {
          console.error("[ws] failed to mark user offline:", error);
        });
    });

    // Without an 'error' listener, a socket error would crash the whole Node process.
    ws.on("error", (error) => {
      console.error("[ws] socket error:", error);
    });
  });

  return { httpServer, wss };
}

// Sends a typed message to one socket. The ServerMessage parameter means the compiler
// rejects any shape the protocol doesn't define. Sending on a closing/closed socket fails,
// so we skip it. WebSocket.OPEN is the named constant for 1 (the portal's code used the bare 1).
function send(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

// ws types message data as RawData: a Buffer, an ArrayBuffer, or an array of Buffers
// (fragmented messages). Turns any of them into a UTF-8 string.
function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return data.toString("utf8");
}
