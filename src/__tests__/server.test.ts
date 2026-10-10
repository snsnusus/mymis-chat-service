import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectClient } from "./helpers/test-client.js";
import { startTestServer, type TestServer } from "./helpers/test-server.js";

describe("chat server", () => {
  let server: TestServer;

  // A fresh server (and fresh fakes) for every test, so tests can't affect each other.
  beforeEach(async () => {
    server = await startTestServer();
  });

  afterEach(async () => {
    await server.close();
  });

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
});
