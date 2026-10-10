// Simulates a dead client: connects and registers, then never answers pings
// (like a sleeping laptop or a frozen browser). The server's heartbeat should
// terminate it within 1-2 intervals.
// Usage: node scripts/zombie-smoke.js [userId] [url]

import WebSocket from "ws";

const userId = process.argv[2] ?? "99";
const url = process.argv[3] ?? "ws://localhost:4000";

// autoPong: false = don't answer pings automatically. Normal clients (and every browser)
// answer them; turning that off is what makes this client look dead to the server.
const ws = new WebSocket(url, {
  origin: "http://localhost:5173",
  autoPong: false,
});

// Wall-clock time, so you can see the gap between pings and the termination.
const now = () => new Date().toISOString().slice(11, 19); // e.g. "09:41:05"

ws.on("open", () => {
  console.log(`${now()} connected as user ${userId}; will ignore pings`);
  ws.send(JSON.stringify({ type: "REGISTER_PRESENCE", userId }));
});

ws.on("ping", () => console.log(`${now()} ping received (not answering)`));
ws.on("message", (data) =>
  console.log(`${now()} received: ${data.toString()}`),
);

// The server terminates without a close handshake, so expect code 1006 (abnormal closure).
ws.on("close", (code) =>
  console.log(`${now()} closed by server (code ${code})`),
);
ws.on("error", (error) =>
  console.error(`error: ${error.code ?? ""} ${error.message}`.trim()),
);
