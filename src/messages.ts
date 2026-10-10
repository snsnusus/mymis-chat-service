import { ObjectId, type Collection, type Db } from "mongodb";
import type { ChatMessage } from "./protocol.js";

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
