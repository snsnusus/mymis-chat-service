// Builds the HTTP server (Express routes) and the WebSocket server, sharing one port.
// It does NOT start listening; index.ts does that. Keeping "build" separate from "start"
// means tests can later create a server on a random port without touching index.ts.

import { createServer, type Server } from "node:http";
import express from "express";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import type { Config } from "./config.js";

// Largest WebSocket message we accept, in bytes. ws closes the connection (code 1009)
// if a client sends more. Fixes design defect #8 (no size limits). 16 KB is plenty for chat text.
const MAX_MESSAGE_BYTES = 16 * 1024;

export interface ChatServer {
  httpServer: Server;
  wss: WebSocketServer;
}

export function createChatServer(config: Config): ChatServer {
  // ── HTTP side: plain Express, same as you've used before ──
  const app = express();

  // Health check: lets Docker, load balancers or you (in a browser) confirm the service is up.
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Wrap Express in Node's own HTTP server so we can listen for 'upgrade' events on it.
  // (app.listen() would hide the server object from us.)
  const httpServer = createServer(app);

  // ── WebSocket side ──
  // noServer: true = "don't attach to any server automatically; I'll hand you upgrades myself".
  // That gives us a place to check each request BEFORE accepting it.
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
  });

  // 'upgrade' fires when a request arrives with "Upgrade: websocket" instead of a normal HTTP request.
  // socket = the raw TCP connection; head = any bytes the client already sent after the headers.
  httpServer.on("upgrade", (request, socket, head) => {
    // Browsers ALWAYS send an Origin header on WebSocket requests and scripts on a page can't fake it.
    // Rejecting unknown origins stops another website from opening a socket to us using a
    // logged-in user's browser (cross-site WebSocket hijacking). CORS does not cover WebSockets.
    const origin = request.headers.origin;

    // Fail closed: a missing Origin is rejected too, not treated as "probably fine".
    if (origin === undefined || !config.allowedOrigins.includes(origin)) {
      // We're still speaking raw HTTP at this point, so we write a minimal 403 response by hand,
      // then destroy the TCP connection.
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      console.warn(`[ws] rejected upgrade from origin: ${origin ?? "(none)"}`);
      return;
    }

    // Origin is allowed: let ws complete the handshake (it sends the 101 response),
    // then raise the normal 'connection' event with the new socket.
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  // 'connection' fires once per accepted client. Everything about that client lives in this closure.
  wss.on("connection", (ws: WebSocket) => {
    console.log(`[ws] client connected (total: ${wss.clients.size})`);

    // 'message' fires for every frame the client sends.
    // isBinary tells us whether it was sent as text or binary data.
    ws.on("message", (data, isBinary) => {
      // Our protocol is JSON text only. 1003 = "unsupported data" (a standard close code).
      if (isBinary) {
        ws.close(1003, "Binary messages are not supported");
        return;
      }

      const text = rawDataToString(data);
      console.log(`[ws] received: ${text}`);

      // TEMPORARY: echo back so we can see the round trip. Replaced by real handlers in 5b.
      ws.send(JSON.stringify({ type: "ECHO", received: text }));
    });

    // 'close' fires when either side ends the connection. code/reason come from the close frame.
    ws.on("close", (code, reason) => {
      console.log(
        `[ws] client disconnected (code ${code}, reason "${reason.toString()}")`,
      );
    });

    // Without an 'error' listener, a socket error would crash the whole Node process.
    ws.on("error", (error) => {
      console.error("[ws] socket error:", error);
    });
  });

  return { httpServer, wss };
}

// ws types message data as RawData, which can be a Buffer, an ArrayBuffer, or an array of Buffers
// (for fragmented messages). This helper turns any of them into a UTF-8 string.
function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return data.toString("utf8");
}
