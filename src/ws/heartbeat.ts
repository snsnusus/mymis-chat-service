// Detects dead connections (sleeping laptops, dropped Wi-Fi, crashed browsers):
// pings every socket on an interval and terminates any that missed the previous ping.

import type { WebSocket, WebSocketServer } from "ws";

export interface Heartbeat {
  // Starts watching a newly connected socket.
  track(ws: WebSocket): void;
}

export function startHeartbeat(
  wss: WebSocketServer,
  intervalMs: number,
): Heartbeat {
  // Whether each socket answered the last ping. WeakMap: entries disappear with their socket.
  const isAlive = new WeakMap<WebSocket, boolean>();

  const timer = setInterval(() => {
    for (const client of wss.clients) {
      if (isAlive.get(client) === false) {
        console.warn("[ws] heartbeat missed, terminating connection");
        client.terminate(); // still fires 'close', so presence is updated as usual
        continue;
      }
      isAlive.set(client, false);
      client.ping();
    }
  }, intervalMs);

  // Stop pinging once the WebSocket server shuts down.
  wss.on("close", () => {
    clearInterval(timer);
  });

  return {
    track(ws: WebSocket): void {
      isAlive.set(ws, true); // a brand-new socket is alive by definition
      ws.on("pong", () => {
        isAlive.set(ws, true);
      });
    },
  };
}
