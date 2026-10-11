// Chat behavior over WebSockets: SEND_MESSAGE.

import type { ConnectionContext } from "../ws/connection.context.js";
import type { ClientMessage } from "../ws/protocol.js";
import type { SocketRegistry } from "../ws/socket.registry.js";
import { toChatMessage, type MessageStore } from "./message.store.js";
import { roomIdFor } from "./room.js";

// The SEND_MESSAGE member of the ClientMessage union, so the handler gets exactly that shape.
type SendMessage = Extract<ClientMessage, { type: "SEND_MESSAGE" }>;

export interface ChatHandlersDeps {
  messageStore: MessageStore;
  registry: SocketRegistry;
}

export function createChatHandlers({
  messageStore,
  registry,
}: ChatHandlersDeps) {
  return {
    async sendMessage(
      ctx: ConnectionContext,
      message: SendMessage,
    ): Promise<void> {
      const { recipientId, text } = message;
      const senderId = ctx.user.userId; // from the TOKEN, never from the message

      // Messaging yourself isn't a conversation (and roomIdFor would throw).
      if (recipientId === senderId) {
        ctx.reply({
          type: "ERROR",
          message: "You cannot send a message to yourself",
        });
        return;
      }

      // A "-" would make the room id ambiguous (and roomIdFor would throw).
      if (recipientId.includes("-")) {
        ctx.reply({ type: "ERROR", message: "Invalid recipient" });
        return;
      }

      // Save first, then deliver: nobody receives a message that isn't stored.
      const saved = await messageStore.insert({
        roomId: roomIdFor(senderId, recipientId),
        senderId,
        recipientId,
        text,
      });

      // Both participants' sockets only. The sender's copy confirms the save
      // and keeps their other tabs in sync.
      registry.sendToUsers([senderId, recipientId], {
        type: "MESSAGE",
        message: toChatMessage(saved),
      });
    },
  };
}

export type ChatHandlers = ReturnType<typeof createChatHandlers>;
