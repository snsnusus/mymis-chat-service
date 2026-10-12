import { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import {
  toConversationSummary,
  type MessageDocument,
} from "../message.store.js";

describe("toConversationSummary", () => {
  // One message from user 1 to user 2, shared by both tests (neither modifies it).
  const document: MessageDocument = {
    _id: new ObjectId(),
    roomId: "1-2",
    senderId: "1",
    recipientId: "2",
    text: "Hello!",
    createdAt: new Date("2026-10-12T10:00:00Z"),
  };

  it("uses the recipient as the other user when the user sent the message", () => {
    // Act: seen by the sender
    const summary = toConversationSummary(document, "1");

    // Assert
    expect(summary.roomId).toBe("1-2");
    expect(summary.otherUserId).toBe("2");
    expect(summary.lastMessage.text).toBe("Hello!");
  });

  it("uses the sender as the other user when the user received the message", () => {
    // Act: the same message, seen by the recipient
    const summary = toConversationSummary(document, "2");

    // Assert
    expect(summary.otherUserId).toBe("1");
  });
});
