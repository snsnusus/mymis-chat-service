// A WebSocket client for tests: records every message the server sends and lets a test
// wait for specific ones.

import WebSocket from "ws";
import type { ServerMessage } from "../../ws/protocol.js";
import { TEST_ORIGIN } from "./test-server.js";

export interface TestClient {
  send(message: unknown): void;
  // Waits for the next message of ANY type.
  next(timeoutMs?: number): Promise<ServerMessage>;
  // Waits for the next message of ONE type; other messages stay in the inbox.
  nextOfType<T extends ServerMessage["type"]>(
    type: T,
    timeoutMs?: number,
  ): Promise<Extract<ServerMessage, { type: T }>>;
  // Removes and returns everything received so far.
  drain(): ServerMessage[];
  // Fails if any message arrives within `ms` (call drain() first to ignore older ones).
  expectSilence(ms?: number): Promise<void>;
  // Resolves with the close code and reason when the connection closes.
  closed: Promise<{ code: number; reason: string }>;
  close(): void;
}

export async function connectClient(
  url: string,
  origin: string = TEST_ORIGIN,
): Promise<TestClient> {
  const ws = new WebSocket(url, { origin });

  const inbox: ServerMessage[] = [];
  // Called after every new message, so a pending wait can re-check the inbox.
  let onNewMessage: (() => void) | null = null;

  ws.on("message", (data) => {
    // The ws client delivers text frames as a Buffer by default.
    inbox.push(JSON.parse((data as Buffer).toString("utf8")) as ServerMessage);
    onNewMessage?.();
  });

  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.on("close", (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
  });

  // Wait until connected, or fail if the server rejects the upgrade (e.g. a 403 origin).
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => {
      resolve();
    });
    ws.once("unexpected-response", (_request, response) => {
      reject(
        new Error(`upgrade rejected with HTTP ${response.statusCode ?? "?"}`),
      );
    });
    ws.once("error", reject);
  });

  // After connecting, socket errors also show up as a close; this listener just
  // prevents an unhandled 'error' event from crashing the test run.
  ws.on("error", () => {
    // intentionally ignored; tests assert on `closed`
  });

  // Polls the inbox with `take` until it returns a value, or rejects after timeoutMs.
  function waitFor<T>(
    take: () => T | undefined,
    timeoutMs: number,
    what: string,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        onNewMessage = null;
        reject(
          new Error(`timed out after ${timeoutMs} ms waiting for ${what}`),
        );
      }, timeoutMs);

      const check = (): void => {
        const value = take();
        if (value !== undefined) {
          clearTimeout(timer);
          onNewMessage = null;
          resolve(value);
        }
      };

      onNewMessage = check;
      check(); // the message may already be in the inbox
    });
  }

  return {
    send(message: unknown): void {
      ws.send(JSON.stringify(message));
    },

    next(timeoutMs = 1_000): Promise<ServerMessage> {
      return waitFor(() => inbox.shift(), timeoutMs, "any message");
    },

    nextOfType<T extends ServerMessage["type"]>(type: T, timeoutMs = 1_000) {
      return waitFor(
        () => {
          const index = inbox.findIndex((message) => message.type === type);
          if (index === -1) {
            return undefined;
          }
          // splice removes the match and leaves every other message in the inbox.
          return inbox.splice(index, 1)[0] as Extract<
            ServerMessage,
            { type: T }
          >;
        },
        timeoutMs,
        `a ${type} message`,
      );
    },

    drain(): ServerMessage[] {
      return inbox.splice(0, inbox.length);
    },

    async expectSilence(ms = 200): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, ms));
      if (inbox.length > 0) {
        throw new Error(
          `expected no messages, received: ${JSON.stringify(inbox)}`,
        );
      }
    },

    closed,

    close(): void {
      ws.close();
    },
  };
}

// Connects and authenticates as a user (fake token "user:<id>"), waiting for AUTH_OK.
// Most tests start with this.
export async function connectAs(
  url: string,
  userId: string,
): Promise<TestClient> {
  const client = await connectClient(url);
  client.send({ type: "AUTH", token: `user:${userId}` });
  await client.nextOfType("AUTH_OK");
  return client;
}
