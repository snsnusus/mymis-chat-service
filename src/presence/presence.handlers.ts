// Presence behavior over WebSockets: counting connections, announcing online/offline,
// and answering GET_INITIAL_PRESENCE.

import type { ConnectionContext } from "../ws/connection.context.js";
import type { SocketRegistry } from "../ws/socket.registry.js";
import type { PresenceStore } from "./presence.store.js";

export interface PresenceHandlersDeps {
  presence: PresenceStore;
  registry: SocketRegistry;
}

export function createPresenceHandlers({
  presence,
  registry,
}: PresenceHandlersDeps) {
  return {
    // Counts one more connection for the user.
    // Resolves to true if this was their FIRST connection (they just came online).
    // Not `async`: it just returns the store's Promise, so there's nothing to await here.
    connect(userId: string): Promise<boolean> {
      return presence.addConnection(userId);
    },

    // Tells every authenticated socket that a user came online. Kept separate from connect()
    // so the connection can send AUTH_OK in between (the order clients rely on).
    announceOnline(userId: string): void {
      registry.broadcast({
        type: "USER_STATUS_CHANGE",
        userId,
        status: "online",
      });
    },

    // Counts one fewer connection; announces offline if it was the user's last one.
    async disconnect(userId: string): Promise<void> {
      const wentOffline = await presence.removeConnection(userId);
      if (wentOffline) {
        registry.broadcast({
          type: "USER_STATUS_CHANGE",
          userId,
          status: "offline",
        });
      }
    },

    // GET_INITIAL_PRESENCE: who is online right now.
    async sendInitialList(ctx: ConnectionContext): Promise<void> {
      const userIds = await presence.listOnline();
      ctx.reply({ type: "INITIAL_PRESENCE_LIST", userIds });
    },
  };
}

export type PresenceHandlers = ReturnType<typeof createPresenceHandlers>;
