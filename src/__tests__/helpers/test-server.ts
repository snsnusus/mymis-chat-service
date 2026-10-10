// Starts a real chat server on a random free port, with fakes as dependencies.
// The Node equivalent of WebApplicationFactory<Program>: real HTTP + WebSocket code,
// controlled dependencies.

import type { AddressInfo } from "node:net";
import type { Config } from "../../config.js";
import { createChatServer, type ChatServerDeps } from "../../server.js";
import {
  createFakeMessageStore,
  createFakePresenceStore,
  fakeVerifyToken,
} from "./fakes.js";

export const TEST_ORIGIN = "http://test.local";

// A fixed, valid Config. The URLs and key are never used: the fakes replace Redis,
// MongoDB and token verification.
const testConfig: Config = {
  nodeEnv: "test",
  port: 0,
  heartbeatIntervalMs: 60_000, // long, so heartbeats never interfere with a test
  redisUrl: "redis://unused",
  mongoUrl: "mongodb://unused",
  allowedOrigins: [TEST_ORIGIN],
  jwt: {
    key: "unused-in-tests-the-verifier-is-faked",
    issuer: "test",
    audience: "test",
  },
};

// overrides: replace any dependency for one test, e.g. a message store you keep a
// reference to, or a config with a short heartbeat interval.
export async function startTestServer(overrides: Partial<ChatServerDeps> = {}) {
  const deps: ChatServerDeps = {
    config: testConfig,
    presence: createFakePresenceStore(),
    verifyToken: fakeVerifyToken,
    mongo: { isAvailable: () => Promise.resolve(true) },
    messageStore: createFakeMessageStore(),
    ...overrides,
  };

  const { httpServer, wss } = createChatServer(deps);

  // Port 0 = "any free port": the OS picks one, so tests never clash with a running
  // dev server or with each other.
  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });

  // address() returns the actual port chosen. Its declared type also allows a string
  // (for Unix sockets), so we assert the TCP shape we know we asked for.
  const { port } = httpServer.address() as AddressInfo;

  return {
    deps,
    wsUrl: `ws://127.0.0.1:${port}`,
    httpUrl: `http://127.0.0.1:${port}`,

    // Shuts everything down so the next test starts clean and Vitest can exit.
    async close(): Promise<void> {
      for (const client of wss.clients) {
        client.terminate();
      }
      wss.close(); // also stops the heartbeat timer
      await new Promise<void>((resolve) => {
        httpServer.close(() => {
          resolve();
        });
      });
    },
  };
}

// The type of a started server, for `let server: TestServer` in tests.
export type TestServer = Awaited<ReturnType<typeof startTestServer>>;
