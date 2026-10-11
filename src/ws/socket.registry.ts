// Keeps track of authenticated sockets and delivers messages to them:
// to everyone (presence) or to specific users (chat).

import { WebSocket } from "ws";
import type { ServerMessage } from "./protocol.js";

export function createSocketRegistry() {
  // Every authenticated socket: the audience for presence broadcasts. Unauthenticated
  // sockets are never in here, so they can't learn who's online.
  const authenticatedSockets = new Set<WebSocket>();

  // Each user's open sockets (one per tab or device), for delivering chat messages.
  const socketsByUser = new Map<string, Set<WebSocket>>();

  // Sends an already-serialized payload, skipping sockets that are closing or closed.
  function sendRaw(socket: WebSocket, payload: string): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(payload);
    }
  }

  return {
    // Registers a socket once it has authenticated as userId.
    add(userId: string, ws: WebSocket): void {
      authenticatedSockets.add(ws);
      let sockets = socketsByUser.get(userId);
      if (sockets === undefined) {
        sockets = new Set();
        socketsByUser.set(userId, sockets);
      }
      sockets.add(ws);
    },

    // Unregisters a closed socket. The user's entry is removed with their last socket,
    // so the map only ever holds connected users.
    remove(userId: string, ws: WebSocket): void {
      authenticatedSockets.delete(ws);
      const sockets = socketsByUser.get(userId);
      if (sockets === undefined) {
        return;
      }
      sockets.delete(ws);
      if (sockets.size === 0) {
        socketsByUser.delete(userId);
      }
    },

    // Every authenticated socket (presence changes).
    broadcast(message: ServerMessage): void {
      const payload = JSON.stringify(message);
      for (const socket of authenticatedSockets) {
        sendRaw(socket, payload);
      }
    },

    // Every socket of the given users (chat messages). Offline users simply get nothing.
    sendToUsers(userIds: string[], message: ServerMessage): void {
      const payload = JSON.stringify(message);
      for (const userId of userIds) {
        for (const socket of socketsByUser.get(userId) ?? []) {
          sendRaw(socket, payload);
        }
      }
    },
  };
}

export type SocketRegistry = ReturnType<typeof createSocketRegistry>;
