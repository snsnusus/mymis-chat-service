import { z } from "zod";
import { MAX_MESSAGE_LENGTH, type ChatMessage } from "../chat/chat.model.js";

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("AUTH"),
    token: z.string().min(1),
  }),
  z.object({
    type: z.literal("GET_INITIAL_PRESENCE"),
  }),
  z.object({
    type: z.literal("SEND_MESSAGE"),
    recipientId: z
      .union([z.string(), z.number()])
      .transform((value) => String(value))
      .pipe(z.string().min(1)),
    text: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
  }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

export function parseClientMessage(text: string): ClientMessage | null {
  try {
    const raw: unknown = JSON.parse(text);

    const result = clientMessageSchema.safeParse(raw);

    if (!result.success) {
      return null;
    }

    return result.data;
  } catch {
    return null;
  }
}

export type ServerMessage =
  | { type: "MESSAGE"; message: ChatMessage }
  | { type: "AUTH_OK"; userId: string }
  | { type: "INITIAL_PRESENCE_LIST"; userIds: string[] }
  | { type: "USER_STATUS_CHANGE"; userId: string; status: "online" | "offline" }
  | { type: "ERROR"; message: string };

// Application-defined WebSocket close codes (the 4000-4999 range is reserved for apps).
// `as const` makes every value a literal type (4001, not just number), and makes the object
// read-only, so CloseCode.UNAUTHORIZED can't be reassigned by mistake.
export const CloseCode = {
  UNAUTHORIZED: 4001, // invalid token, or a non-AUTH first message
  TOKEN_EXPIRED: 4002, // token expired at AUTH time or while connected
  AUTH_TIMEOUT: 4008, // no AUTH within the time limit
} as const;
