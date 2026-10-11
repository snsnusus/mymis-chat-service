import { ObjectId, type Collection, type Db, type Filter } from "mongodb";
import { z } from "zod";
import type { ChatMessage } from "./chat.model.js";

export interface MessageDocument {
  _id: ObjectId;
  roomId: string;
  senderId: string;
  recipientId: string;
  text: string;
  createdAt: Date;
}

// What a caller provides to save a message. _id and createdAt are NOT accepted from callers:
// the database generates _id, and the server stamps createdAt, so neither can be faked.
export interface NewMessage {
  roomId: string;
  senderId: string;
  recipientId: string;
  text: string;
}

// The message store: the only place in the service that talks to the messages collection,
// the same repository pattern as presence.ts. Steps 4 and 5 add insert and history queries here.
export function createMessageStore(db: Db) {
  // Collection<MessageDocument> types every query and insert against your interface.
  // MongoDB creates the collection automatically on first use (no "CREATE TABLE").
  const messages: Collection<MessageDocument> =
    db.collection<MessageDocument>("messages");

  return {
    // Creates the indexes the queries rely on. Called once at startup.
    // createIndex is IDEMPOTENT: if an identical index already exists, it does nothing,
    // so running it on every boot is safe. (Changing the definition while keeping the same
    // name makes it fail instead: a changed index needs an explicit drop first.)
    async ensureIndexes(): Promise<void> {
      await messages.createIndex(
        // Equality (roomId) first, then the sort fields: newest first, _id breaking ties.
        { roomId: 1, createdAt: -1, _id: -1 },
        { name: "roomId_createdAt_id" }, // an explicit, readable name instead of the generated one
      );
    },

    // Saves a message and returns the stored document.
    async insert(input: NewMessage): Promise<MessageDocument> {
      // We generate the _id ourselves. MessageDocument declares _id as required, so the
      // driver's types expect us to provide it. ObjectIds are designed to be created by the
      // client: timestamp + random value + counter, unique without asking the database.
      const document: MessageDocument = {
        _id: new ObjectId(),
        ...input,
        createdAt: new Date(),
      };

      await messages.insertOne(document);
      return document;
    },

    // One page of a room's history, newest first. `before` is the cursor from the previous
    // page (null for the first page). Fetches limit + 1 rows to learn whether more exist.
    async findHistory(
      roomId: string,
      before: HistoryCursor | null,
      limit: number,
    ): Promise<{ documents: MessageDocument[]; hasMore: boolean }> {
      // Filter<MessageDocument> is the driver's typed query shape: field names and
      // operators ($lt, $or...) are checked against your document type.
      const filter: Filter<MessageDocument> = { roomId };

      if (before !== null) {
        // "Older than the cursor", in the exact order of the index (createdAt, then _id).
        filter.$or = [
          { createdAt: { $lt: before.createdAt } },
          { createdAt: before.createdAt, _id: { $lt: before.id } },
        ];
      }

      const documents = await messages
        .find(filter)
        .sort({ createdAt: -1, _id: -1 }) // matches the index, so no in-memory sort
        .limit(limit + 1)
        .toArray();

      const hasMore = documents.length > limit;
      return {
        documents: hasMore ? documents.slice(0, limit) : documents,
        hasMore,
      };
    },
  };
}

// The store's type, so server.ts can depend on "a message store" (and tests can fake it).
export type MessageStore = ReturnType<typeof createMessageStore>;

// Converts a stored document into its wire shape (entity → DTO).
// ObjectId → 24-character hex string; Date → ISO 8601 string in UTC.
export function toChatMessage(document: MessageDocument): ChatMessage {
  return {
    id: document._id.toHexString(),
    roomId: document.roomId,
    senderId: document.senderId,
    recipientId: document.recipientId,
    text: document.text,
    createdAt: document.createdAt.toISOString(),
  };
}

// The position after which the next history page starts: the oldest message of the
// previous page. Both fields are needed because two messages can share a createdAt.
export interface HistoryCursor {
  createdAt: Date;
  id: ObjectId;
}

// What's inside an encoded cursor. Short keys keep the cursor string short.
const cursorSchema = z.object({
  t: z.number().int().nonnegative(), // createdAt as milliseconds since epoch
  id: z.string().regex(/^[0-9a-f]{24}$/), // an ObjectId: exactly 24 hex characters
});

// Packs a message's position into an opaque string: JSON, then base64url.
// base64url (unlike plain base64) uses only URL-safe characters, so the cursor
// can go straight into a query string without escaping.
export function encodeCursor(document: MessageDocument): string {
  const json = JSON.stringify({
    t: document.createdAt.getTime(),
    id: document._id.toHexString(),
  });
  return Buffer.from(json, "utf8").toString("base64url");
}

// Unpacks a cursor from a URL. Untrusted input, so: never throws, returns null for
// anything that isn't a cursor this server produced in the expected shape.
export function decodeCursor(cursor: string): HistoryCursor | null {
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    const raw: unknown = JSON.parse(json);
    const parsed = cursorSchema.safeParse(raw);
    if (!parsed.success) {
      return null;
    }
    return {
      createdAt: new Date(parsed.data.t),
      id: new ObjectId(parsed.data.id),
    };
  } catch {
    return null; // not base64url, or not JSON
  }
}
