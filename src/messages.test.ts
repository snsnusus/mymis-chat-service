import { describe, it, expect } from "vitest";
import { ObjectId } from "mongodb";
import {
  encodeCursor,
  decodeCursor,
  type MessageDocument,
} from "./messages.js";

function docBuilder(
  roomId: string,
  senderId: string,
  recipientId: string,
  text: string,
): MessageDocument {
  return {
    _id: new ObjectId(),
    roomId,
    senderId,
    recipientId,
    text,
    createdAt: new Date("2026-10-11T01:00:00.000Z"),
  };
}

// Encodes ANY value the way encodeCursor does (JSON → base64url), to build cursors
// that encodeCursor never would: the kind a tampering client could send.
function toCursorString(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

describe("encodeCursor / decodeCursor", () => {
  it("round-trips a cursor", () => {
    // Arrange
    const doc = docBuilder("1-3", "1", "3", "Hello!");
    // Act + Assert
    expect(decodeCursor(encodeCursor(doc))).toEqual({
      createdAt: doc.createdAt,
      id: doc._id,
    });
  });
  it("produces a URL-safe string", () => {
    // Arrange
    const doc = docBuilder("1-2", "2", "1", "Heyooo!");
    // Act + Assert
    expect(encodeCursor(doc)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it("rejects a string that is not base64url JSON", () => {
    // Act + Assert
    expect(decodeCursor("not-a-cursor")).toBeNull();
  });
  it("rejects valid JSON with the wrong shape", () => {
    // Act + Assert
    expect(decodeCursor(toCursorString({ x: 1 }))).toBeNull();
  });
  it("rejects an invalid ObjectId", () => {
    // Act + Assert
    expect(decodeCursor(toCursorString({ t: 0, id: "zzz" }))).toBeNull();
  });
  it("rejects a negative timestamp", () => {
    // Act + Assert
    expect(
      decodeCursor(toCursorString({ t: -1, id: "4f7c2a9d1e8b6c0f3a5e8d2b" })),
    ).toBeNull();
  });
});
