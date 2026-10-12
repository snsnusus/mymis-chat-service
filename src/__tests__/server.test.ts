import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ChatMessage } from "../chat/chat.model.js";
import { createFakeMessageStore } from "./helpers/fakes.js";
import {
  connectAs,
  connectClient,
  type TestClient,
} from "./helpers/test-client.js";
import { startTestServer, type TestServer } from "./helpers/test-server.js";
import type { ConversationSummary } from "../chat/chat.model.js";

// Gives in-flight messages a moment to arrive, so drain() clears everything from setup.
// Needed because a broadcast can land just after the await that triggered it.
function settle(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Sends a chat message and waits for the sender's own MESSAGE copy (the save confirmation).
async function sendMessage(
  sender: TestClient,
  recipientId: string,
  text: string,
): Promise<void> {
  sender.send({ type: "SEND_MESSAGE", recipientId, text });
  await sender.nextOfType("MESSAGE");
}

// The JSON body of the history endpoint.
interface HistoryResponse {
  messages: ChatMessage[];
  nextCursor: string | null;
}

interface ConversationsResponse {
  conversations: ConversationSummary[];
}

describe("chat server", () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startTestServer();
  });

  afterEach(async () => {
    await server.close();
  });

  describe("authentication", () => {
    it("replies AUTH_OK with the user id from the token", async () => {
      // Arrange
      const client = await connectClient(server.wsUrl);

      // Act
      client.send({ type: "AUTH", token: "user:1" });

      // Assert
      expect(await client.nextOfType("AUTH_OK")).toEqual({
        type: "AUTH_OK",
        userId: "1",
      });
    });

    it("rejects a WebSocket connection from an unknown origin", async () => {
      // Arrange + Act
      const connecting = connectClient(server.wsUrl, "http://evil.example");

      // Assert
      await expect(connecting).rejects.toThrow("403");
    });

    it("closes the connection with 4001 when the token is invalid", async () => {
      // Arrange
      const client = await connectClient(server.wsUrl);

      // Act
      client.send({ type: "AUTH", token: "not-a-valid-token" });

      // Assert
      const closedEvent = await client.closed;
      expect(closedEvent.code).toBe(4001);
      expect(closedEvent.reason).toBe("Invalid token");
    });

    it("closes the connection with 4002 when the token has expired", async () => {
      // Arrange
      const client = await connectClient(server.wsUrl);

      // Act
      client.send({ type: "AUTH", token: "expired" });

      // Assert
      const closedEvent = await client.closed;
      expect(closedEvent.code).toBe(4002);
      expect(closedEvent.reason).toBe("Token expired");
    });

    it("closes the connection with 4001 when a message is sent before AUTH", async () => {
      // Arrange
      const client = await connectClient(server.wsUrl);

      // Act
      client.send({ type: "GET_INITIAL_PRESENCE" });

      // Assert
      const closedEvent = await client.closed;
      expect(closedEvent.code).toBe(4001);
      expect(closedEvent.reason).toBe("Authenticate first");
    });

    it("closes the connection with 4001 when an unknown message is sent before AUTH", async () => {
      // Arrange
      const client = await connectClient(server.wsUrl);

      // Act
      client.send({ type: "HELLO" });

      // Assert
      const closedEvent = await client.closed;
      expect(closedEvent.code).toBe(4001);
      expect(closedEvent.reason).toBe("Authenticate first");
    });

    it("replies with an ERROR to a second AUTH and keeps the connection open", async () => {
      // Arrange
      const client = await connectAs(server.wsUrl, "1");

      // Act
      client.send({ type: "AUTH", token: "user:1" });

      // Assert
      expect(await client.nextOfType("ERROR")).toEqual({
        type: "ERROR",
        message: "This connection is already authenticated",
      });
      client.send({ type: "GET_INITIAL_PRESENCE" });
      await client.nextOfType("INITIAL_PRESENCE_LIST");
    });

    it("closes the connection with 4002 when the token expires while connected", async () => {
      // Arrange: a valid token that expires 200 ms from now
      const client = await connectClient(server.wsUrl);
      client.send({ type: "AUTH", token: "user:1:200" });
      await client.nextOfType("AUTH_OK"); // proves AUTH succeeded, so the close below is expiry

      // Act: nothing to do but wait for the expiry timer

      // Assert
      const closedEvent = await client.closed;
      expect(closedEvent.code).toBe(4002);
      expect(closedEvent.reason).toBe("Token expired");
    });
  });

  describe("presence", () => {
    it("tells other users when someone comes online", async () => {
      // Arrange
      const alice = await connectAs(server.wsUrl, "1");
      await alice.nextOfType("USER_STATUS_CHANGE"); // her own "online"

      // Act
      await connectAs(server.wsUrl, "2");

      // Assert
      expect(await alice.nextOfType("USER_STATUS_CHANGE")).toEqual({
        type: "USER_STATUS_CHANGE",
        userId: "2",
        status: "online",
      });
    });

    it("lists everyone online in INITIAL_PRESENCE_LIST", async () => {
      // Arrange
      const alice = await connectAs(server.wsUrl, "1");
      await connectAs(server.wsUrl, "2");

      // Act
      alice.send({ type: "GET_INITIAL_PRESENCE" });

      // Assert: the order isn't guaranteed, so sort a copy before comparing
      const list = await alice.nextOfType("INITIAL_PRESENCE_LIST");
      expect([...list.userIds].sort()).toEqual(["1", "2"]);
    });

    it("does not broadcast online for a user's second tab", async () => {
      // Arrange
      const observer = await connectAs(server.wsUrl, "2");
      await connectAs(server.wsUrl, "1");
      await settle();
      observer.drain();

      // Act
      await connectAs(server.wsUrl, "1");

      // Assert
      await observer.expectSilence();
    });

    it("keeps a user online when one of two tabs closes", async () => {
      // Arrange
      const observer = await connectAs(server.wsUrl, "2");
      const firstTab = await connectAs(server.wsUrl, "1");
      await connectAs(server.wsUrl, "1");
      await settle();
      observer.drain();

      // Act
      firstTab.close();

      // Assert
      await observer.expectSilence();
    });

    it("broadcasts offline when a user's last tab closes", async () => {
      // Arrange
      const observer = await connectAs(server.wsUrl, "2");
      const firstTab = await connectAs(server.wsUrl, "1");
      const secondTab = await connectAs(server.wsUrl, "1");
      await settle();
      observer.drain();

      // Act
      firstTab.close();
      secondTab.close();

      // Assert
      expect(await observer.nextOfType("USER_STATUS_CHANGE")).toEqual({
        type: "USER_STATUS_CHANGE",
        userId: "1",
        status: "offline",
      });
    });

    it("sends no presence to an unauthenticated socket", async () => {
      // Arrange
      const stranger = await connectClient(server.wsUrl);

      // Act
      await connectAs(server.wsUrl, "2");

      // Assert
      await stranger.expectSilence();
    });
  });

  describe("messaging", () => {
    it("delivers a message to both participants", async () => {
      // Arrange
      const alice = await connectAs(server.wsUrl, "1");
      const bob = await connectAs(server.wsUrl, "2");

      // Act
      alice.send({ type: "SEND_MESSAGE", recipientId: "2", text: "hello" });

      // Assert
      const toAlice = await alice.nextOfType("MESSAGE");
      const toBob = await bob.nextOfType("MESSAGE");
      expect(toBob).toEqual(toAlice); // same id, same createdAt: one saved message
      expect(toAlice.message).toMatchObject({
        roomId: "1-2",
        senderId: "1",
        recipientId: "2",
        text: "hello",
      });
    });

    it("does not deliver a message to anyone outside the conversation", async () => {
      // Arrange
      const alice = await connectAs(server.wsUrl, "1");
      const bob = await connectAs(server.wsUrl, "2");
      const carol = await connectAs(server.wsUrl, "3");
      await settle();
      carol.drain();

      // Act
      alice.send({ type: "SEND_MESSAGE", recipientId: "2", text: "private" });
      await bob.nextOfType("MESSAGE");

      // Assert
      await carol.expectSilence();
    });

    it("saves the message to the store", async () => {
      // Arrange: restart with a store this test keeps a reference to
      await server.close();
      const store = createFakeMessageStore();
      server = await startTestServer({ messageStore: store });
      const alice = await connectAs(server.wsUrl, "1");

      // Act
      await sendMessage(alice, "2", "saved?");

      // Assert
      const saved = store.all();
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({
        roomId: "1-2",
        senderId: "1",
        recipientId: "2",
        text: "saved?",
      });
    });

    it("replies with an ERROR when sending a message to yourself", async () => {
      // Arrange
      const alice = await connectAs(server.wsUrl, "1");

      // Act
      alice.send({
        type: "SEND_MESSAGE",
        recipientId: "1",
        text: "note to self",
      });

      // Assert
      expect(await alice.nextOfType("ERROR")).toEqual({
        type: "ERROR",
        message: "You cannot send a message to yourself",
      });
    });

    it("replies with an ERROR when the text is blank", async () => {
      // Arrange
      const alice = await connectAs(server.wsUrl, "1");

      // Act
      alice.send({ type: "SEND_MESSAGE", recipientId: "2", text: "   " });

      // Assert
      expect(await alice.nextOfType("ERROR")).toEqual({
        type: "ERROR",
        message: "Invalid or unsupported message",
      });
    });
  });

  describe("HTTP", () => {
    // The fake verifier accepts "user:<id>" over HTTP too.
    const authHeader = (userId: string) => ({
      Authorization: `Bearer user:${userId}`,
    });

    it("reports healthy dependencies on /health", async () => {
      // Act
      const res = await fetch(`${server.httpUrl}/health`);

      // Assert
      const body: unknown = await res.json();
      expect(res.status).toBe(200);
      expect(body).toEqual({ status: "ok", redis: "up", mongo: "up" });
    });

    it("returns 401 for history without a token", async () => {
      // Act
      const res = await fetch(`${server.httpUrl}/conversations/1-2/messages`);

      // Assert
      const body: unknown = await res.json();
      expect(res.status).toBe(401);
      expect(body).toEqual({ error: "unauthorized" });
    });

    it("returns 403 for history of a conversation you are not part of", async () => {
      // Act
      const res = await fetch(`${server.httpUrl}/conversations/1-2/messages`, {
        headers: authHeader("3"),
      });

      // Assert
      expect(res.status).toBe(403);
    });

    it("returns 400 for a non-canonical room id", async () => {
      // Act
      const res = await fetch(`${server.httpUrl}/conversations/2-1/messages`, {
        headers: authHeader("1"),
      });

      // Assert
      const body: unknown = await res.json();
      expect(res.status).toBe(400);
      expect(body).toEqual({ error: "invalid_room_id" });
    });

    it("returns history newest first", async () => {
      // Arrange
      const alice = await connectAs(server.wsUrl, "1");
      await sendMessage(alice, "2", "first");
      await sendMessage(alice, "2", "second");

      // Act
      const res = await fetch(`${server.httpUrl}/conversations/1-2/messages`, {
        headers: authHeader("1"),
      });

      // Assert
      const body = (await res.json()) as HistoryResponse;
      expect(res.status).toBe(200);
      expect(body.messages.map((message) => message.text)).toEqual([
        "second",
        "first",
      ]);
      expect(body.nextCursor).toBeNull();
    });

    it("pages through history with the cursor", async () => {
      // Arrange
      const alice = await connectAs(server.wsUrl, "1");
      await sendMessage(alice, "2", "first");
      await sendMessage(alice, "2", "second");
      const url = `${server.httpUrl}/conversations/1-2/messages?limit=1`;

      // Act
      const firstPage = (await (
        await fetch(url, { headers: authHeader("1") })
      ).json()) as HistoryResponse;
      const secondPage = (await (
        await fetch(`${url}&before=${firstPage.nextCursor ?? ""}`, {
          headers: authHeader("1"),
        })
      ).json()) as HistoryResponse;

      // Assert
      expect(firstPage.messages.map((message) => message.text)).toEqual([
        "second",
      ]);
      expect(firstPage.nextCursor).not.toBeNull();
      expect(secondPage.messages.map((message) => message.text)).toEqual([
        "first",
      ]);
      expect(secondPage.nextCursor).toBeNull();
    });

    it("returns 401 for conversations without a token", async () => {
      // Act
      const res = await fetch(`${server.httpUrl}/conversations`);

      // Assert
      const body: unknown = await res.json();
      expect(res.status).toBe(401);
      expect(body).toEqual({ error: "unauthorized" });
    });

    it("returns 400 for an invalid conversations limit", async () => {
      // Act
      const res = await fetch(`${server.httpUrl}/conversations?limit=0`, {
        headers: authHeader("1"),
      });

      // Assert
      const body: unknown = await res.json();
      expect(res.status).toBe(400);
      expect(body).toEqual({ error: "invalid_query" });
    });

    it("returns the caller's conversations newest first", async () => {
      // Arrange: fresh user ids, so messages from other tests can't show up here
      const alice = await connectAs(server.wsUrl, "21");
      await sendMessage(alice, "22", "first");
      await sendMessage(alice, "23", "second");

      // Act
      const res = await fetch(`${server.httpUrl}/conversations`, {
        headers: authHeader("21"),
      });

      // Assert
      const body = (await res.json()) as ConversationsResponse;
      expect(res.status).toBe(200);
      expect(
        body.conversations.map((conversation) => conversation.roomId),
      ).toEqual(["21-23", "21-22"]);
    });

    it("reports the other participant from each side", async () => {
      // Arrange
      const alice = await connectAs(server.wsUrl, "31");
      await sendMessage(alice, "32", "Hello!");

      // Act: the same conversation, fetched by each participant
      // Act: the same conversation, fetched by each participant
      const aliceRes = await fetch(`${server.httpUrl}/conversations`, {
        headers: authHeader("31"),
      });
      const aliceBody = (await aliceRes.json()) as ConversationsResponse;
      const bobRes = await fetch(`${server.httpUrl}/conversations`, {
        headers: authHeader("32"),
      });
      const bobBody = (await bobRes.json()) as ConversationsResponse;

      // Assert
      expect(aliceRes.status).toBe(200);
      expect(bobRes.status).toBe(200);
      expect(aliceBody.conversations[0]?.otherUserId).toBe("32");
      expect(bobBody.conversations[0]?.otherUserId).toBe("31");
    });
  });
});
