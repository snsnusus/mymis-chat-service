// Builds the HTTP server (Express routes) and the WebSocket server, sharing one port.
// It does NOT start listening; index.ts does that.

import { createServer, type Server } from "node:http";
import { WebSocket, WebSocketServer, type RawData } from "ws";

import { type Config } from "./config.js";
import type {
  AuthenticatedUser,
  TokenVerifier,
} from "./auth/token.verifier.js";
import { toChatMessage, type MessageStore } from "./chat/message.store.js";
import { roomIdFor } from "./chat/room.js";
import type { MongoConnection } from "./infrastructure/mongo.js";
import { type PresenceStore } from "./presence/presence.store.js";
import {
  CloseCode,
  parseClientMessage,
  type ClientMessage,
  type ServerMessage,
} from "./ws/protocol.js";

import { createChatRouter } from "./chat/chat.routes.js";
import { createHttpApp } from "./http/app.js";

// Largest WebSocket message we accept, in bytes (ws closes with 1009 if exceeded).
const MAX_MESSAGE_BYTES = 16 * 1024;

// How long a new connection may stay unauthenticated before it's closed (ADR-0005).
const AUTH_TIMEOUT_MS = 5_000;

export interface ChatServer {
  httpServer: Server;
  wss: WebSocketServer;
}

// Everything the server needs from the outside, passed as one object.
// Adding a dependency means adding a property here, not reordering parameters.
export interface ChatServerDeps {
  config: Config;
  presence: PresenceStore;
  verifyToken: TokenVerifier;
  mongo: Pick<MongoConnection, "isAvailable">;
  messageStore: MessageStore;
}

// Three injected dependencies now: config, presence storage, and token verification.
// Tests can pass a fake verifier that "accepts" any token without real JWTs.
export function createChatServer(deps: ChatServerDeps): ChatServer {
  // Destructuring keeps the rest of the function unchanged: it still uses
  // config, presence and verifyToken as plain variables.
  const { config, presence, verifyToken, mongo, messageStore } = deps;

  const app = createHttpApp({
    config,
    presence,
    mongo,
    routers: [createChatRouter({ verifyToken, messageStore })],
  });
  const httpServer = createServer(app);

  // ── WebSocket side ──
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
  });

  // Sockets that completed AUTH. Presence is only shared with these: wss.clients also
  // contains sockets that haven't authenticated yet, and they must not learn who's online.
  const authenticatedSockets = new Set<WebSocket>();

  // Sends one message to every AUTHENTICATED open socket (presence changes only).
  function broadcast(message: ServerMessage): void {
    const payload = JSON.stringify(message);
    for (const client of authenticatedSockets) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  // Every open, authenticated socket of each user (one per tab or device).
  // Used to deliver a chat message to exactly the people in the conversation.
  const socketsByUser = new Map<string, Set<WebSocket>>();

  function trackUserSocket(userId: string, ws: WebSocket): void {
    let sockets = socketsByUser.get(userId);
    if (sockets === undefined) {
      sockets = new Set();
      socketsByUser.set(userId, sockets);
    }
    sockets.add(ws);
  }

  function untrackUserSocket(userId: string, ws: WebSocket): void {
    const sockets = socketsByUser.get(userId);
    if (sockets === undefined) {
      return;
    }
    sockets.delete(ws);
    // Remove the user's entry once their last socket is gone, so the map
    // only ever holds connected users (no slow memory leak of empty sets).
    if (sockets.size === 0) {
      socketsByUser.delete(userId);
    }
  }

  // Sends one message to every open socket of the given users.
  // Serialized once, then sent to each socket.
  function sendToUsers(userIds: string[], message: ServerMessage): void {
    const payload = JSON.stringify(message);
    for (const userId of userIds) {
      // ?? [] : a user with no sockets (offline) simply gets nothing.
      for (const socket of socketsByUser.get(userId) ?? []) {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(payload);
        }
      }
    }
  }

  // ── Heartbeat: covers ALL sockets, authenticated or not ──
  const isAlive = new WeakMap<WebSocket, boolean>();

  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (isAlive.get(client) === false) {
        console.warn("[ws] heartbeat missed, terminating connection");
        client.terminate();
        continue;
      }
      isAlive.set(client, false);
      client.ping();
    }
  }, config.heartbeatIntervalMs);

  wss.on("close", () => {
    clearInterval(heartbeat);
  });

  // ── Upgrade: origin check before accepting ──
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

    isAlive.set(ws, true);
    ws.on("pong", () => {
      isAlive.set(ws, true);
    });

    // ── Per-connection state ──
    // null until AUTH succeeds. This is the socket's whole state machine:
    // null = unauthenticated, an object = authenticated as that user.
    let user: AuthenticatedUser | null = null;

    // true while an AUTH is being verified (verification is async). Blocks a second AUTH
    // from racing the first, which could register the socket twice.
    let authenticating = false;

    // Fires at the token's exp to close the socket (set once authenticated).
    let expiryTimer: NodeJS.Timeout | undefined;

    // Closes the socket if no successful AUTH arrives in time.
    const authTimer = setTimeout(() => {
      if (user === null) {
        ws.close(CloseCode.AUTH_TIMEOUT, "Authentication timed out");
      }
    }, AUTH_TIMEOUT_MS);

    async function authenticate(token: string): Promise<void> {
      authenticating = true;
      const result = await verifyToken(token);

      // While we awaited, the socket may have closed (timeout fired, client left).
      // Nothing to do then: registering a closed socket would leave a count behind.
      if (ws.readyState !== WebSocket.OPEN) {
        return;
      }

      if (!result.ok) {
        // 4002 tells the client "refresh and reconnect"; 4001 means "don't retry with this token".
        if (result.reason === "expired") {
          ws.close(CloseCode.TOKEN_EXPIRED, "Token expired");
        } else {
          ws.close(CloseCode.UNAUTHORIZED, "Invalid token");
        }
        return;
      }

      // A const copy: TypeScript can't narrow the `let user` inside callbacks below,
      // but it knows this const is an AuthenticatedUser.
      const authedUser = result.user;

      clearTimeout(authTimer);
      user = authedUser;
      authenticatedSockets.add(ws);
      trackUserSocket(authedUser.userId, ws);

      // Close the socket when the token expires. Math.max guards against a token that
      // expires in the few milliseconds between verification and here.
      expiryTimer = setTimeout(
        () => {
          ws.close(CloseCode.TOKEN_EXPIRED, "Token expired");
        },
        Math.max(0, authedUser.expiresAt - Date.now()),
      );

      // `user` is set BEFORE this await on purpose: if the socket closes mid-await, the close
      // handler sees the user and queues the decrement. Redis runs commands from one client in
      // order, so the +1 here always lands before that -1.
      const cameOnline = await presence.addConnection(authedUser.userId);

      console.log(`[ws] authenticated user ${authedUser.userId}`);
      send(ws, { type: "AUTH_OK", userId: authedUser.userId });

      if (cameOnline) {
        broadcast({
          type: "USER_STATUS_CHANGE",
          userId: authedUser.userId,
          status: "online",
        });
      }
    }

    async function handleMessage(message: ClientMessage): Promise<void> {
      // Unauthenticated: AUTH is the ONLY allowed message, and only one at a time.
      // Anything else ends the connection (ADR-0005: unauthenticated sockets can do nothing).
      // Contract for clients: send AUTH, wait for AUTH_OK, then send anything else.
      if (user === null) {
        if (message.type !== "AUTH" || authenticating) {
          ws.close(CloseCode.UNAUTHORIZED, "Authenticate first");
          return;
        }
        await authenticate(message.token);
        return;
      }

      // Authenticated from here on. A const copy keeps the narrowed type stable
      // across the awaits below.
      const sender = user;

      // Authenticated.
      switch (message.type) {
        case "AUTH": {
          send(ws, {
            type: "ERROR",
            message: "This connection is already authenticated",
          });
          return;
        }

        case "GET_INITIAL_PRESENCE": {
          const userIds = await presence.listOnline();
          send(ws, { type: "INITIAL_PRESENCE_LIST", userIds });
          return;
        }

        case "SEND_MESSAGE": {
          const { recipientId, text } = message;

          // Messaging yourself isn't a conversation (and roomIdFor would throw).
          if (recipientId === sender.userId) {
            send(ws, {
              type: "ERROR",
              message: "You cannot send a message to yourself",
            });
            return;
          }

          // A "-" would make the room id ambiguous (and roomIdFor would throw).
          if (recipientId.includes("-")) {
            send(ws, { type: "ERROR", message: "Invalid recipient" });
            return;
          }

          // senderId comes from the TOKEN (sender.userId), never from the message:
          // a client can't send a message in someone else's name.
          const saved = await messageStore.insert({
            roomId: roomIdFor(sender.userId, recipientId),
            senderId: sender.userId,
            recipientId,
            text,
          });

          // Deliver to both participants' sockets ONLY. The sender's copy confirms the
          // message was saved (with its server-assigned id and time) and keeps their other
          // tabs in sync. If the recipient is offline, the message waits in MongoDB
          // and comes back through the history endpoint (Step 5).
          sendToUsers([sender.userId, recipientId], {
            type: "MESSAGE",
            message: toChatMessage(saved),
          });
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

      // Timers belong to this socket; a closed socket must not leave them running.
      // (clearTimeout(undefined) is a harmless no-op, so no check is needed.)
      clearTimeout(authTimer);
      clearTimeout(expiryTimer);
      authenticatedSockets.delete(ws);

      const closedUser = user;
      if (closedUser === null) {
        return; // never authenticated, so it was never counted
      }

      untrackUserSocket(closedUser.userId, ws);

      presence
        .removeConnection(closedUser.userId)
        .then((wentOffline) => {
          if (wentOffline) {
            broadcast({
              type: "USER_STATUS_CHANGE",
              userId: closedUser.userId,
              status: "offline",
            });
          }
        })
        .catch((error: unknown) => {
          console.error("[ws] failed to mark user offline:", error);
        });
    });

    ws.on("error", (error) => {
      console.error("[ws] socket error:", error);
    });
  });

  return { httpServer, wss };
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
