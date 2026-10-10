import { describe, it, expect } from "vitest";
import { isRoomMember, parseRoomId, roomIdFor } from "../rooms.js";

describe("roomIdFor", () => {
  it("puts the smaller id first", () => {
    // Act + Assert
    expect(roomIdFor("1", "3")).toBe("1-3");
  });

  it("gives the same id regardless of argument order", () => {
    // Act + Assert
    expect(roomIdFor("3", "1")).toBe("1-3");
  });

  it("orders multi-digit ids consistently", () => {
    // Act + Assert
    expect(roomIdFor("9", "10")).toBe(roomIdFor("10", "9"));
  });

  it("throws when both ids are the same", () => {
    // Act + Assert
    expect(() => roomIdFor("1", "1")).toThrow();
  });

  it("throws when an id is empty", () => {
    // Act + Assert
    expect(() => roomIdFor("", "3")).toThrow();
  });

  it("throws when an id contains a dash", () => {
    // Act + Assert
    expect(() => roomIdFor("1-2", "3")).toThrow();
  });
});

describe("parseRoomId", () => {
  it("returns both participants for a valid room id", () => {
    // Act + Assert
    expect(parseRoomId("1-3")).toEqual(["1", "3"]);
  });

  it.each([
    { description: "rejects a room id in the wrong order", input: "3-1" },
    { description: "rejects a room id with the same user twice", input: "1-1" },
    { description: "rejects a room id without a dash", input: "1" },
    {
      description: "rejects a room id with more than two parts",
      input: "1-2-3",
    },
    { description: "rejects an empty string", input: "" },
    { description: "rejects a room id with an empty side", input: "-3" },
  ])("$description", ({ input }) => {
    // Act + Assert
    expect(parseRoomId(input)).toBeNull();
  });
});

describe("isRoomMember", () => {
  it.each([
    {
      description: "is true for the first participant",
      roomId: "1-3",
      userId: "1",
    },
    {
      description: "is true for the second participant",
      roomId: "1-3",
      userId: "3",
    },
  ])("$description", ({ roomId, userId }) => {
    // Act + Assert
    expect(isRoomMember(roomId, userId)).toBe(true);
  });
  it.each([
    {
      description: "is false for someone outside the room",
      roomId: "1-3",
      userId: "2",
    },
    {
      description: "is false for a malformed room id",
      roomId: "1-1",
      userId: "1",
    },
  ])("$description", ({ roomId, userId }) => {
    // Act + Assert
    expect(isRoomMember(roomId, userId)).toBe(false);
  });
});
