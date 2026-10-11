// Starts throwaway Redis and MongoDB containers for integration tests.
// Same images as docker-compose.yml, so tests run against the versions used in dev.

import { GenericContainer } from "testcontainers";

export interface RunningContainer {
  url: string; // connection URL for the client
  stop(): Promise<void>; // removes the container
}

export async function startRedisContainer(): Promise<RunningContainer> {
  // withExposedPorts(6379): Docker maps the container's 6379 to a RANDOM free port on
  // your machine, so it never clashes with the dev Redis on 6380 (or anything else).
  const container = await new GenericContainer("redis:8-alpine")
    .withExposedPorts(6379)
    .start();

  return {
    url: `redis://${container.getHost()}:${container.getMappedPort(6379)}`,
    async stop() {
      await container.stop();
    },
  };
}

export async function startMongoContainer(): Promise<RunningContainer> {
  const container = await new GenericContainer("mongo:8")
    .withExposedPorts(27017)
    .start();

  return {
    // A dedicated database name, so it's obvious in any log that this is test data.
    url: `mongodb://${container.getHost()}:${container.getMappedPort(27017)}/mymis_chat_test`,
    async stop() {
      await container.stop();
    },
  };
}
