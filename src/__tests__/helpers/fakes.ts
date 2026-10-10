// In-memory stand-ins for the server's dependencies. Same shapes as the real ones
// (PresenceStore, MessageStore, TokenVerifier), so createChatServer can't tell the difference.

import { ObjectId } from "mongodb";
import type { TokenVerifier } from "../../auth/token.verifier.js";
import type {
  MessageDocument,
  MessageStore,
  NewMessage,
} from "../../chat/message.store.js";
import type { PresenceStore } from "../../presence/presence.store.js";

// ── Presence: connection counts in a Map instead of a Redis hash ──
// Methods return Promise.resolve(...) instead of being `async`: the type-checked lint rule
// require-await flags async functions that never await anything.
export function createFakePresenceStore(): PresenceStore {
  const counts = new Map<string, number>();

  return {
    addConnection(userId: string): Promise<boolean> {
      const count = (counts.get(userId) ?? 0) + 1;
      counts.set(userId, count);
      return Promise.resolve(count === 1);
    },
    removeConnection(userId: string): Promise<boolean> {
      const count = (counts.get(userId) ?? 0) - 1;
      counts.set(userId, count);
      return Promise.resolve(count <= 0);
    },
    listOnline(): Promise<string[]> {
      const online = [...counts]
        .filter(([, count]) => count > 0)
        .map(([userId]) => userId);
      return Promise.resolve(online);
    },
    reset(): Promise<void> {
      counts.clear();
      return Promise.resolve();
    },
    isAvailable(): boolean {
      return true;
    },
  };
}

// ── Tokens: readable fake tokens instead of signed JWTs ──
//   "user:1"        → valid, user 1, expires in 15 minutes
//   "user:1:200"    → valid, user 1, expires in 200 ms (for expiry tests)
//   "expired"       → { ok: false, reason: 'expired' }
//   anything else   → { ok: false, reason: 'invalid' }
// The real verifier already has its own 10 tests; server tests only care about the result.
export const fakeVerifyToken: TokenVerifier = (token: string) => {
  if (token === "expired") {
    return Promise.resolve({ ok: false, reason: "expired" });
  }

  // ([^:]+) = the user id; (?::(\d+))? = an optional ":<milliseconds>" suffix.
  const match = /^user:([^:]+)(?::(\d+))?$/.exec(token);
  const userId = match?.[1];
  if (userId === undefined) {
    return Promise.resolve({ ok: false, reason: "invalid" });
  }

  const ttlMs = match?.[2] === undefined ? 15 * 60_000 : Number(match[2]);
  return Promise.resolve({
    ok: true,
    user: {
      userId,
      username: `user${userId}`,
      role: "User",
      expiresAt: Date.now() + ttlMs,
    },
  });
};

// ── Messages: an array instead of a collection ──
// Returns the MessageStore shape plus all(), so tests can inspect what was saved.
export function createFakeMessageStore(): MessageStore & {
  all(): MessageDocument[];
} {
  const documents: MessageDocument[] = [];

  return {
    ensureIndexes(): Promise<void> {
      return Promise.resolve();
    },
    insert(input: NewMessage): Promise<MessageDocument> {
      const document: MessageDocument = {
        _id: new ObjectId(),
        ...input,
        createdAt: new Date(),
      };
      documents.push(document);
      return Promise.resolve(document);
    },
    // Same contract as the real query: newest first, strictly older than the cursor,
    // limit + 1 to detect another page.
    findHistory(roomId, before, limit) {
      const newestFirst = documents
        .filter((document) => document.roomId === roomId)
        .sort(compareNewestFirst);

      const page =
        before === null
          ? newestFirst
          : newestFirst.filter(
              (document) =>
                compareNewestFirst(document, {
                  createdAt: before.createdAt,
                  _id: before.id,
                }) > 0,
            );

      const hasMore = page.length > limit;
      return Promise.resolve({ documents: page.slice(0, limit), hasMore });
    },
    all(): MessageDocument[] {
      return [...documents]; // a copy, so tests can't modify the store's array
    },
  };
}

// Sort comparator for "newest first": by createdAt descending, then _id descending.
// Negative = a comes first. ObjectId hex strings have equal length, so plain string
// comparison orders them correctly.
function compareNewestFirst(
  a: Pick<MessageDocument, "createdAt" | "_id">,
  b: Pick<MessageDocument, "createdAt" | "_id">,
): number {
  const byTime = b.createdAt.getTime() - a.createdAt.getTime();
  if (byTime !== 0) {
    return byTime;
  }
  const aId = a._id.toHexString();
  const bId = b._id.toHexString();
  return aId === bId ? 0 : aId > bId ? -1 : 1;
}
