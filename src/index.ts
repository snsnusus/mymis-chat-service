// Entry point of the chat service. For now it only proves the toolchain works:
// tsx can run it in dev, and tsc can compile it to dist/index.js for production.

// process.version is a Node built-in (typed by @types/node), e.g. "v24.1.0".
const nodeVersion: string = process.version;

// new Date().toISOString() gives a UTC timestamp like "2026-10-10T06:50:00.000Z".
const bootedAt: string = new Date().toISOString();

console.log(
  `[mymis-chat-service] booted at ${bootedAt} on Node ${nodeVersion}`,
);
