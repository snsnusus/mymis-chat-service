import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  connectMongo,
  type MongoConnection,
} from "../../infrastructure/mongo.js";
import {
  createMessageStore,
  decodeCursor,
  encodeCursor,
  type MessageDocument,
  type MessageStore,
} from "../message.store.js";
import {
  startMongoContainer,
  type RunningContainer,
} from "../../__tests__/helpers/containers.js";
import { makeTestConfig } from "../../__tests__/helpers/test-server.js";

// Builds the "next page" cursor from a page's oldest message, the same way a client would:
// encode it into the opaque string, then decode it back the way the server does.
const cursorAfter = (page: { documents: MessageDocument[] }) =>
  decodeCursor(encodeCursor(page.documents.at(-1)!));

describe("message store (real MongoDB)", () => {
  let container: RunningContainer;
  let mongo: MongoConnection;
  let store: MessageStore;

  // Direct access to the collection, for checking what was REALLY stored
  // (rather than trusting the store's own return values).
  const messages = () => mongo.db.collection<MessageDocument>("messages");

  beforeAll(async () => {
    container = await startMongoContainer();
    mongo = await connectMongo(makeTestConfig({ mongoUrl: container.url }));
    store = createMessageStore(mongo.db);
    await store.ensureIndexes(); // the same index the service creates at startup
  }, 120_000);

  afterAll(async () => {
    await mongo.client.close();
    await container.stop();
  });

  // deleteMany({}) removes every document but KEEPS the collection and its indexes.
  // (drop() would remove the indexes too, and the queries would silently run without them.)
  beforeEach(async () => {
    await messages().deleteMany({});
  });

  it("saves a message and returns it with a generated id and timestamp", async () => {
    // Arrange
    const input = {
      roomId: "1-2",
      senderId: "1",
      recipientId: "2",
      text: "hello",
    };

    // Act
    const saved = await store.insert(input);

    // Assert
    expect(saved).toMatchObject(input);
    expect(saved._id).toBeInstanceOf(ObjectId);
    expect(saved.createdAt).toBeInstanceOf(Date);
    expect(await messages().findOne({ _id: saved._id })).toEqual(saved);
  });

  it("returns only the room's messages, newest first", async () => {
    // Arrange
    await store.insert({
      roomId: "1-2",
      senderId: "1",
      recipientId: "2",
      text: "first",
    });
    await store.insert({
      roomId: "1-2",
      senderId: "1",
      recipientId: "2",
      text: "second",
    });
    await store.insert({
      roomId: "1-3",
      senderId: "1",
      recipientId: "3",
      text: "other room",
    });

    // Act
    const page = await store.findHistory("1-2", null, 10);

    // Assert
    expect(page.documents.map((message) => message.text)).toEqual([
      "second",
      "first",
    ]);
    expect(page.hasMore).toBe(false);
  });

  it("pages through older messages using the cursor", async () => {
    // Arrange
    await store.insert({
      roomId: "1-2",
      senderId: "1",
      recipientId: "2",
      text: "first",
    });
    await store.insert({
      roomId: "1-2",
      senderId: "1",
      recipientId: "2",
      text: "second",
    });
    await store.insert({
      roomId: "1-2",
      senderId: "1",
      recipientId: "2",
      text: "third",
    });

    // Act
    const page1 = await store.findHistory("1-2", null, 2);
    const cursor = decodeCursor(encodeCursor(page1.documents.at(-1)!));
    const page2 = await store.findHistory("1-2", cursor, 2);

    // Assert
    expect(page1.documents.map((message) => message.text)).toEqual([
      "third",
      "second",
    ]);
    expect(page1.hasMore).toBe(true);

    expect(page2.documents.map((message) => message.text)).toEqual(["first"]);
    expect(page2.hasMore).toBe(false);
  });

  it("breaks createdAt ties by id so no message is skipped or repeated", async () => {
    // Arrange: three messages with the SAME timestamp, written straight to the collection
    // (store.insert would set createdAt itself, so we can't control it through the store)
    const sameTime = new Date("2026-01-01T00:00:00Z");
    const documents: MessageDocument[] = ["a", "b", "c"].map((text) => ({
      _id: new ObjectId(), // generated in order a → b → c, so "c" has the largest id
      roomId: "1-2",
      senderId: "1",
      recipientId: "2",
      text,
      createdAt: sameTime,
    }));
    await messages().insertMany(documents);

    // Act: page size 1, so every page boundary falls on a tie
    const page1 = await store.findHistory("1-2", null, 1);
    const page2 = await store.findHistory("1-2", cursorAfter(page1), 1);
    const page3 = await store.findHistory("1-2", cursorAfter(page2), 1);

    // Assert: all pages together are every message once, newest (largest id) first
    const allTexts = [
      ...page1.documents,
      ...page2.documents,
      ...page3.documents,
    ].map((message) => message.text);
    expect(allTexts).toEqual(["c", "b", "a"]);
    expect(page1.hasMore).toBe(true);
    expect(page2.hasMore).toBe(true);
    expect(page3.hasMore).toBe(false);
  });

  it("reports no more pages when the room has exactly `limit` messages", async () => {
    // Arrange
    await store.insert({
      roomId: "1-2",
      senderId: "1",
      recipientId: "2",
      text: "first",
    });
    await store.insert({
      roomId: "1-2",
      senderId: "2",
      recipientId: "1",
      text: "second",
    });

    // Act
    const page = await store.findHistory("1-2", null, 2);

    // Assert
    expect(page.documents).toHaveLength(2);
    expect(page.hasMore).toBe(false);
  });

  it("creates the history index with fields in the right order", async () => {
    // Arrange: ensureIndexes already ran in beforeAll; run it again to prove it's safe to repeat
    await store.ensureIndexes();

    // Act
    const indexes = await messages().indexes();
    const historyIndex = indexes.find(
      (index) => index.name === "roomId_createdAt_id",
    );

    // Assert
    expect(historyIndex).toBeDefined();
    expect(Object.entries(historyIndex?.key ?? {})).toEqual([
      ["roomId", 1],
      ["createdAt", -1],
      ["_id", -1],
    ]);
  });

  describe("findConversations", () => {
    it("returns one entry per conversation with its latest message", async () => {
      // Arrange
      await store.insert({
        roomId: "1-2",
        senderId: "1",
        recipientId: "2",
        text: "Hello!",
      });
      await store.insert({
        roomId: "1-3",
        senderId: "1",
        recipientId: "3",
        text: "Hi!",
      });
      await store.insert({
        roomId: "1-2",
        senderId: "1",
        recipientId: "2",
        text: "Hey, what's up?",
      });

      // Act
      const result = await store.findConversations("1", 20);

      // Assert
      expect(result).toHaveLength(2); // 3 messages, 2 conversations

      const room12 = result.find((message) => message.roomId === "1-2");
      expect(room12?.text).toBe("Hey, what's up?");
    });

    it("orders conversations by their latest message, newest first", async () => {
      // Arrange
      await store.insert({
        roomId: "1-2",
        senderId: "1",
        recipientId: "2",
        text: "Hello!",
      });
      await store.insert({
        roomId: "1-3",
        senderId: "1",
        recipientId: "3",
        text: "Hi!",
      });
      await store.insert({
        roomId: "1-2",
        senderId: "1",
        recipientId: "2",
        text: "Hey, what's up?",
      });

      // Act
      const result = await store.findConversations("1", 20);

      // Assert
      expect(result.map((message) => message.roomId)).toEqual(["1-2", "1-3"]);
    });

    it("includes conversations where the user only received messages", async () => {
      // Arrange: user 2 messages user 1, who never replies
      await store.insert({
        roomId: "1-2",
        senderId: "2",
        recipientId: "1",
        text: "Hello!",
      });

      // Act
      const result = await store.findConversations("1", 20);

      // Assert: the conversation shows up even though user 1 never sent anything
      expect(result.map((message) => message.roomId)).toEqual(["1-2"]);
    });

    it("excludes conversations the user is not part of", async () => {
      // Arrange: one conversation with user 1, one between two other users
      await store.insert({
        roomId: "1-2",
        senderId: "1",
        recipientId: "2",
        text: "Hello!",
      });
      await store.insert({
        roomId: "2-3",
        senderId: "2",
        recipientId: "3",
        text: "Not for user 1",
      });

      // Act
      const result = await store.findConversations("1", 20);

      // Assert: only the room user 1 is in
      expect(result.map((message) => message.roomId)).toEqual(["1-2"]);
    });

    it("returns at most limit conversations", async () => {
      // Arrange: three conversations, written oldest to newest
      await store.insert({
        roomId: "1-2",
        senderId: "1",
        recipientId: "2",
        text: "first",
      });
      await store.insert({
        roomId: "1-3",
        senderId: "1",
        recipientId: "3",
        text: "second",
      });
      await store.insert({
        roomId: "1-4",
        senderId: "1",
        recipientId: "4",
        text: "third",
      });

      // Act
      const result = await store.findConversations("1", 2);

      // Assert: the two NEWEST conversations, so the limit is applied after sorting
      expect(result.map((message) => message.roomId)).toEqual(["1-4", "1-3"]);
    });

    it("returns an empty list for a user with no messages", async () => {
      // Arrange: messages exist, but none involve user 9
      await store.insert({
        roomId: "1-2",
        senderId: "1",
        recipientId: "2",
        text: "Hello!",
      });

      // Act
      const result = await store.findConversations("9", 20);

      // Assert
      expect(result).toEqual([]);
    });

    it("creates the sender and recipient indexes", async () => {
      // Arrange: ensureIndexes already ran in beforeAll; run it again to prove it's safe to repeat
      await store.ensureIndexes();

      // Act
      const indexes = await messages().indexes();
      const senderIndex = indexes.find(
        (index) => index.name === "senderId_createdAt",
      );
      const recipientIndex = indexes.find(
        (index) => index.name === "recipientId_createdAt",
      );

      // Assert: both exist, with their fields in the right order
      expect(Object.entries(senderIndex?.key ?? {})).toEqual([
        ["senderId", 1],
        ["createdAt", -1],
      ]);
      expect(Object.entries(recipientIndex?.key ?? {})).toEqual([
        ["recipientId", 1],
        ["createdAt", -1],
      ]);
    });
  });
});
