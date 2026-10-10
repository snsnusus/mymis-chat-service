// Manual WebSocket test client.
// Usage: node scripts/ws-smoke.js [origin] [url]
//   node scripts/ws-smoke.js                              → allowed origin, should get an ECHO
//   node scripts/ws-smoke.js http://evil.example          → should be rejected with 403

import WebSocket from "ws";

const origin = process.argv[2] ?? "http://localhost:5173";
const url = process.argv[3] ?? "ws://localhost:4000";

// A browser sets Origin automatically; a Node client must set it explicitly to simulate one.
const ws = new WebSocket(url, { origin });

ws.on("open", () => {
  console.log(`connected to ${url} as origin ${origin}`);
  ws.send(JSON.stringify({ type: "HELLO", at: new Date().toISOString() }));
});

ws.on("message", (data) => {
  console.log("received:", data.toString());
  ws.close(1000, "smoke test done"); // 1000 = normal closure
});

// Fires when the server answers the upgrade with a normal HTTP response (e.g. our 403).
ws.on("unexpected-response", (_request, response) => {
  console.log(`rejected by server: HTTP ${response.statusCode}`);
});

ws.on("close", (code) => console.log(`closed (code ${code})`));
ws.on("error", (error) => console.error("error:", error.message));
