// Presence test client: registers as a user and prints every message it receives.
// Stays connected until Ctrl+C, so you can run several at once in different terminals.
// Usage: node scripts/presence-smoke.js <userId> [url]

import WebSocket from "ws";

const userId = process.argv[2] ?? "1";
const url = process.argv[3] ?? "ws://localhost:4000";

// A browser sets Origin automatically; a Node client must set it to pass our origin check.
const ws = new WebSocket(url, { origin: "http://localhost:5173" });

ws.on("open", () => {
  console.log(`connected as user ${userId} (Ctrl+C to disconnect)`);
  // The same two messages the portal's user directory sends on connect.
  ws.send(JSON.stringify({ type: "REGISTER_PRESENCE", userId }));
  ws.send(JSON.stringify({ type: "GET_INITIAL_PRESENCE" }));
});

ws.on("message", (data) => console.log("received:", data.toString()));
ws.on("close", (code) => console.log(`closed (code ${code})`));
ws.on("error", (error) =>
  console.error(`error: ${error.code ?? ""} ${error.message}`.trim()),
);
