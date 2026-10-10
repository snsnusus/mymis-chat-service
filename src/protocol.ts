import { z } from "zod";

export const clientMessageSchema = z.discriminatedUnion("type", [
  // Shape A: { type: "AUTH", token: ... }
  z.object({
    type: z.literal("AUTH"),
    token: z.string().min(1),
  }),
  z.object({
    type: z.literal("GET_INITIAL_PRESENCE"),
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
