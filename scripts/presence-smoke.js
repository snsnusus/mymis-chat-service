// Presence test client: authenticates with a token, then requests the online list.
// Stays connected until Ctrl+C (or until the server closes it).
// Usage: node scripts/presence-smoke.js <token | none> [url]
//   Pass "none" to connect WITHOUT authenticating (tests the 5-second auth timeout).
//   Tip: mint a token inline with  "$(node --env-file=.env scripts/mint-token.js 1)"

import WebSocket from "ws";

const token = process.argv[2];
const url = process.argv[3] ?? "ws://localhost:4000";

if (token === undefined) {
  console.error("usage: node scripts/presence-smoke.js <token | none> [url]");
  process.exit(1);
}

const ws = new WebSocket(url, { origin: "http://localhost:5173" });

ws.on("open", () => {
  if (token === "none") {
    console.log("connected; NOT authenticating (expect a 4008 close in ~5 s)");
    return;
  }
  console.log("connected; sending AUTH (Ctrl+C to disconnect)");
  ws.send(JSON.stringify({ type: "AUTH", token }));
});

ws.on("message", (data) => {
  const text = data.toString();
  console.log("received:", text);

  // Follow the protocol contract: only send other messages after AUTH_OK.
  if (JSON.parse(text).type === "AUTH_OK") {
    ws.send(JSON.stringify({ type: "GET_INITIAL_PRESENCE" }));
  }
});

// The close reason shows WHY the server ended the connection.
ws.on("close", (code, reason) =>
  console.log(`closed (code ${code}, reason "${reason.toString()}")`),
);
ws.on("error", (error) =>
  console.error(`error: ${error.code ?? ""} ${error.message}`.trim()),
);
