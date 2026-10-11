import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectRedis, type RedisClient } from "../../infrastructure/redis.js";
import { createPresenceStore, type PresenceStore } from "../presence.store.js";
import {
  startRedisContainer,
  type RunningContainer,
} from "../../__tests__/helpers/containers.js";
import { makeTestConfig } from "../../__tests__/helpers/test-server.js";

describe("presence store (real Redis)", () => {
  let container: RunningContainer;
  let redis: RedisClient;
  let store: PresenceStore;

  // Once per FILE: starting a container takes seconds, so all tests here share one.
  // The second argument raises this hook's timeout from Vitest's default 10 s to 2 minutes,
  // since the first run may need to download the image.
  beforeAll(async () => {
    container = await startRedisContainer();
    redis = await connectRedis(makeTestConfig({ redisUrl: container.url }));
    store = createPresenceStore(redis);
  }, 120_000);

  afterAll(async () => {
    await redis.close();
    await container.stop();
  });

  // Before EACH test: wipe the counts, so tests can't affect each other.
  beforeEach(async () => {
    await store.reset();
  });

  it("reports the first connection as coming online, and the second as not", async () => {
    // Arrange + Act
    const firstCameOnline = await store.addConnection("1");
    const secondCameOnline = await store.addConnection("1");

    // Assert
    expect(firstCameOnline).toBe(true);
    expect(secondCameOnline).toBe(false);
  });

  it("reports going offline only when the last connection is removed", async () => {
    // Arrange
    await store.addConnection("1");
    await store.addConnection("1");

    // Act
    const firstWentOffline = await store.removeConnection("1");
    const secondWentOffline = await store.removeConnection("1");

    // Assert
    expect(firstWentOffline).toBe(false);
    expect(secondWentOffline).toBe(true);
  });

  it("lists only users with at least one open connection", async () => {
    // Arrange
    await store.addConnection("1");
    await store.addConnection("2");
    await store.removeConnection("2");

    // Act
    const onlineList = await store.listOnline();

    // Assert
    expect(onlineList).toEqual(["1"]);
  });

  it("clears all counts on reset", async () => {
    // Arrange
    await store.addConnection("1");
    await store.addConnection("2");

    // Act
    await store.reset();

    // Assert
    expect(await store.listOnline()).toEqual([]);
    expect(await store.addConnection("1")).toBe(true);
  });

  it("counts concurrent connections atomically", async () => {
    // Arrange + Act
    const cameOnline = await Promise.all(
      Array.from({ length: 10 }, () => store.addConnection("1")),
    );
    const wentOffline = await Promise.all(
      Array.from({ length: 10 }, () => store.removeConnection("1")),
    );

    // Assert
    expect(cameOnline.filter((online) => online).length).toBe(1);
    expect(wentOffline.filter((offline) => offline).length).toBe(1);
  });
});
