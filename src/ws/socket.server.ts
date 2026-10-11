// The WebSocket side of the service: accepts upgrades from allowed origins, runs each
// connection's AUTH state machine and timers, and dispatches messages to feature handlers.

import type { Server } from "node:http";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type {
  AuthenticatedUser,
  TokenVerifier,
} from "../auth/token.verifier.js";
import type { ChatHandlers } from "../chat/chat.handlers.js";
import type { Config } from "../config.js";
import type { PresenceHandlers } from "../presence/presence.handlers.js";
import type { ConnectionContext } from "./connection.context.js";
import { startHeartbeat } from "./heartbeat.js";
import {
  CloseCode,
  parseClientMessage,
  type ClientMessage,
  type ServerMessage,
} from "./protocol.js";
import type { SocketRegistry } from "./socket.registry.js";

// Largest WebSocket message we accept, in bytes (ws closes with 1009 if exceeded).
const MAX_MESSAGE_BYTES = 16 * 1024;

// How long a new connection may stay unauthenticated before it's closed (ADR-0005).
const DEFAULT_AUTH_TIMEOUT_MS = 5_000;

export interface SocketServerDeps {
  config: Config;
  verifyToken: TokenVerifier;
  registry: SocketRegistry;
  presenceHandlers: PresenceHandlers;
  chatHandlers: ChatHandlers;
  // Optional override, so tests can use a short timeout.
  authTimeoutMs?: number;
}

export function attachSocketServer(
  httpServer: Server,
  deps: SocketServerDeps,
): WebSocketServer {
  const {
    config,
    verifyToken,
    registry,
    presenceHandlers,
    chatHandlers,
    authTimeoutMs = DEFAULT_AUTH_TIMEOUT_MS, // default applies when the option is undefined
  } = deps;

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
  });
  const heartbeat = startHeartbeat(wss, config.heartbeatIntervalMs);

  // Origin check before accepting (fail closed: missing or unlisted origins are rejected).
  httpServer.on("upgrade", (request, socket, head) => {
    const origin = request.headers.origin;

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
    heartbeat.track(ws);

    // ── Per-connection state ──
    // null = unauthenticated; an object = authenticated as that user.
    let user: AuthenticatedUser | null = null;
    // true while an AUTH is being verified, so a second AUTH can't race the first.
    let authenticating = false;
    // Closes the socket when the token expires (set once authenticated).
    let expiryTimer: NodeJS.Timeout | undefined;

    // Closes the socket if no successful AUTH arrives in time.
    const authTimer = setTimeout(() => {
      if (user === null) {
        ws.close(CloseCode.AUTH_TIMEOUT, "Authentication timed out");
      }
    }, authTimeoutMs);

    async function authenticate(token: string): Promise<void> {
      authenticating = true;
      const result = await verifyToken(token);

      // The socket may have closed while we awaited (timeout, client left).
      if (ws.readyState !== WebSocket.OPEN) {
        return;
      }

      if (!result.ok) {
        if (result.reason === "expired") {
          ws.close(CloseCode.TOKEN_EXPIRED, "Token expired");
        } else {
          ws.close(CloseCode.UNAUTHORIZED, "Invalid token");
        }
        return;
      }

      const authedUser = result.user;

      clearTimeout(authTimer);
      user = authedUser;
      registry.add(authedUser.userId, ws);

      // Close the socket when the token expires.
      expiryTimer = setTimeout(
        () => {
          ws.close(CloseCode.TOKEN_EXPIRED, "Token expired");
        },
        Math.max(0, authedUser.expiresAt - Date.now()),
      );

      // `user` is set BEFORE this await, so a close during it still decrements the count.
      // The order connect → AUTH_OK → announce is part of the protocol (see presence.handlers.ts).
      const cameOnline = await presenceHandlers.connect(authedUser.userId);

      console.log(`[ws] authenticated user ${authedUser.userId}`);
      send(ws, { type: "AUTH_OK", userId: authedUser.userId });

      if (cameOnline) {
        presenceHandlers.announceOnline(authedUser.userId);
      }
    }

    async function handleMessage(message: ClientMessage): Promise<void> {
      // Unauthenticated: AUTH is the only allowed message, one at a time (ADR-0005).
      if (user === null) {
        if (message.type !== "AUTH" || authenticating) {
          ws.close(CloseCode.UNAUTHORIZED, "Authenticate first");
          return;
        }
        await authenticate(message.token);
        return;
      }

      // Authenticated: give handlers the caller and a way to reply, then dispatch by type.
      const ctx: ConnectionContext = {
        user,
        reply: (reply) => {
          send(ws, reply);
        },
      };

      switch (message.type) {
        case "AUTH": {
          ctx.reply({
            type: "ERROR",
            message: "This connection is already authenticated",
          });
          return;
        }
        case "GET_INITIAL_PRESENCE": {
          await presenceHandlers.sendInitialList(ctx);
          return;
        }
        case "SEND_MESSAGE": {
          await chatHandlers.sendMessage(ctx, message);
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

      if (message === null) {
        // Before AUTH, garbage ends the connection; after AUTH, it's just an error reply.
        if (user === null) {
          ws.close(CloseCode.UNAUTHORIZED, "Authenticate first");
        } else {
          send(ws, {
            type: "ERROR",
            message: "Invalid or unsupported message",
          });
        }
        return;
      }

      handleMessage(message).catch((error: unknown) => {
        console.error("[ws] failed to handle message:", error);
        send(ws, { type: "ERROR", message: "Internal error" });
      });
    });

    ws.on("close", (code, reason) => {
      console.log(
        `[ws] client disconnected (code ${code}, reason "${reason.toString()}")`,
      );

      clearTimeout(authTimer);
      clearTimeout(expiryTimer);

      const closedUser = user;
      if (closedUser === null) {
        return; // never authenticated, so never counted or registered
      }

      registry.remove(closedUser.userId, ws);
      presenceHandlers.disconnect(closedUser.userId).catch((error: unknown) => {
        console.error("[ws] failed to mark user offline:", error);
      });
    });

    ws.on("error", (error) => {
      console.error("[ws] socket error:", error);
    });
  });

  return wss;
}

// Sends a typed message to one socket, skipping sockets that aren't open.
function send(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

// Turns ws's RawData (Buffer | ArrayBuffer | Buffer[]) into a UTF-8 string.
function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return data.toString("utf8");
}
