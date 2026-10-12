// HTTP endpoints of the chat feature. Exported as a Router that http/app.ts mounts.

import { Router } from "express";
import { z } from "zod";
import type { TokenVerifier } from "../auth/token.verifier.js";
import { authenticateRequest } from "../http/authenticate-request.js";
import {
  decodeCursor,
  encodeCursor,
  toChatMessage,
  toConversationSummary,
  type HistoryCursor,
  type MessageStore,
} from "./message.store.js";
import { isRoomMember, parseRoomId } from "./room.js";

// Query string of the history route. Query values are always strings, hence coerce.
const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  before: z.string().min(1).optional(),
});

const conversationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export interface ChatRouterDeps {
  verifyToken: TokenVerifier;
  messageStore: MessageStore;
}

export function createChatRouter({
  verifyToken,
  messageStore,
}: ChatRouterDeps): Router {
  const router = Router();

  // One page of a conversation's history, newest first.
  router.get("/conversations/:roomId/messages", async (req, res) => {
    // 1. Authenticate (401).
    const auth = await authenticateRequest(req, verifyToken);
    if (!auth.ok) {
      res.status(401).json({
        error: auth.reason === "expired" ? "token_expired" : "unauthorized",
      });
      return;
    }

    // 2. Room id from the URL (400).
    const { roomId } = req.params;
    if (parseRoomId(roomId) === null) {
      res.status(400).json({ error: "invalid_room_id" });
      return;
    }

    // 3. Membership (403).
    if (!isRoomMember(roomId, auth.user.userId)) {
      res.status(403).json({ error: "forbidden" });
      return;
    }

    // 4. Query string (400).
    const query = historyQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }

    let before: HistoryCursor | null = null;
    if (query.data.before !== undefined) {
      before = decodeCursor(query.data.before);
      if (before === null) {
        res.status(400).json({ error: "invalid_cursor" });
        return;
      }
    }

    // 5. Query, then build the next cursor from the oldest message on this page.
    const { documents, hasMore } = await messageStore.findHistory(
      roomId,
      before,
      query.data.limit,
    );
    const oldest = documents.at(-1);

    res.json({
      messages: documents.map(toChatMessage),
      nextCursor: hasMore && oldest !== undefined ? encodeCursor(oldest) : null,
    });
  });

  router.get("/conversations", async (req, res) => {
    const auth = await authenticateRequest(req, verifyToken);
    if (!auth.ok) {
      res.status(401).json({
        error: auth.reason === "expired" ? "token_expired" : "unauthorized",
      });
      return;
    }

    const query = conversationsQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }

    const conversations = await messageStore.findConversations(
      auth.user.userId,
      query.data.limit,
    );

    res.json({
      conversations: conversations.map((convo) =>
        toConversationSummary(convo, auth.user.userId),
      ),
    });
  });

  return router;
}
