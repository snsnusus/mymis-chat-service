import type { Collection, Db, ObjectId } from "mongodb";

export interface MessageDocument {
  _id: ObjectId;
  roomId: string;
  senderId: string;
  recipientId: string;
  text: string;
  createdAt: Date;
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
  };
}

// The store's type, so server.ts can depend on "a message store" (and tests can fake it).
export type MessageStore = ReturnType<typeof createMessageStore>;
