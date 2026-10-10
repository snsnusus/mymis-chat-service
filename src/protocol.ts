import { z } from "zod";

export const clientMessageSchema = z.discriminatedUnion("type", [
  // Shape A: { type: "REGISTER_PRESENCE", userId: ... }
  z.object({
    type: z.literal("REGISTER_PRESENCE"),
    userId: z
      .union([z.string(), z.number()])
      .transform((value) => String(value))
      .pipe(z.string().min(1)),
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
  | { type: "INITIAL_PRESENCE_LIST"; userIds: string[] }
  | { type: "USER_STATUS_CHANGE"; userId: string; status: "online" | "offline" }
  | { type: "ERROR"; message: string };
