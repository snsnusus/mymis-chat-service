// Interactive chat client: authenticates, then sends every line you type to one recipient,
// and prints everything it receives.
// Usage: node scripts/chat-smoke.js <token> <recipientId> [url]

import readline from "node:readline";
import WebSocket from "ws";

const token = process.argv[2];
const recipientId = process.argv[3];
const url = process.argv[4] ?? "ws://localhost:4000";

if (token === undefined || recipientId === undefined) {
  console.error(
    "usage: node scripts/chat-smoke.js <token> <recipientId> [url]",
  );
  process.exit(1);
}

// readline reads standard input one line at a time (each Enter press = one 'line' event).
const input = readline.createInterface({ input: process.stdin });

const ws = new WebSocket(url, { origin: "http://localhost:5173" });

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "AUTH", token }));
});

ws.on("message", (data) => {
  const text = data.toString();
  console.log("received:", text);

  // Only start accepting typed lines once authenticated (the protocol contract).
  if (JSON.parse(text).type === "AUTH_OK") {
    console.log(
      `authenticated; type a message for user ${recipientId} and press Enter`,
    );
    input.on("line", (line) => {
      ws.send(
        JSON.stringify({ type: "SEND_MESSAGE", recipientId, text: line }),
      );
    });
  }
});

ws.on("close", (code, reason) => {
  console.log(`closed (code ${code}, reason "${reason.toString()}")`);
  input.close(); // stop reading stdin so the script can exit
});
ws.on("error", (error) =>
  console.error(`error: ${error.code ?? ""} ${error.message}`.trim()),
);
