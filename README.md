# mymis-chat-service

![CI](https://github.com/snsnusus/mymis-chat-service/actions/workflows/ci.yml/badge.svg)

A real-time 1:1 chat microservice for MyMIS, built with Node.js, TypeScript and WebSockets.
Messages are stored in MongoDB and online status (presence) in Redis.
It has no login of its own: it accepts the JWTs issued by [`mymis-api`](https://github.com/snsnusus/mymis-api).

## How it fits in

```
┌──────────────┐  WebSocket (live chat, presence)   ┌────────────────────┐
│ mymis-portal │ ─────────────────────────────────▶ │ mymis-chat-service │
│   (React)    │  REST (message history)            │  (this repo)       │
└──────┬───────┘                                    └───┬────────────┬───┘
       │ login                                          │            │
       ▼                                                ▼            ▼
┌──────────────┐  issues JWTs (HS256, shared key)   MongoDB        Redis
│  mymis-api   │  that both services trust          messages       presence
│   (.NET)     │
└──────────────┘
```

- `mymis-api` stays the system of record (employees, auth). This service owns chat only.
- Both services share the JWT signing key, issuer and audience, so the chat service verifies tokens locally without calling the API.

## Tech stack

- **Runtime:** Node.js 24, TypeScript 6 (ES modules)
- **HTTP:** Express 5
- **WebSocket:** [`ws`](https://github.com/websockets/ws)
- **Data:** MongoDB (native driver), Redis (`redis`)
- **Auth & validation:** `jose` (JWT), `zod` (config, messages, query strings)
- **Testing:** Vitest, Testcontainers
- **CI:** GitHub Actions

## Prerequisites

- Node.js 24 (22+ works)
- Docker Desktop: runs MongoDB and Redis locally, and is required for the integration tests
- For real tokens: a running `mymis-api`. For local testing, `scripts/mint-token.js` signs tokens with the same key.

## Getting started

```bash
git clone https://github.com/snsnusus/mymis-chat-service.git
cd mymis-chat-service
npm ci

# Configure: copy the example and fill in the JWT values from mymis-api
cp .env.example .env

# Start MongoDB and Redis (waits until both are healthy)
docker compose up -d --wait

# Run the service with auto-restart on file or .env changes
npm run dev
```

Check that it's up:

```bash
curl "http://localhost:4000/health"
# {"status":"ok","redis":"up","mongo":"up"}
```

Stop the databases with `docker compose down`. Messages survive in the `mongo-data` volume; presence is rebuilt on reconnect by design.

## Configuration

All variables are validated at startup by `src/config.ts`; the service refuses to start with a clear list of what's wrong.

| Variable                | Required | Default       | Description                                                     |
| ----------------------- | -------- | ------------- | --------------------------------------------------------------- |
| `NODE_ENV`              | no       | `development` | `development`, `test` or `production`                           |
| `PORT`                  | no       | `4000`        | Port for HTTP and WebSocket                                     |
| `HEARTBEAT_INTERVAL_MS` | no       | `30000`       | Ping interval; unresponsive sockets are closed (min 1000)       |
| `REDIS_URL`             | yes      |               | e.g. `redis://localhost:6380`                                   |
| `MONGO_URL`             | yes      |               | e.g. `mongodb://localhost:27018/mymis_chat`                     |
| `ALLOWED_ORIGINS`       | yes      |               | Comma-separated browser origins, e.g. `http://localhost:5173`   |
| `JWT_KEY`               | yes      |               | Signing key, at least 32 characters. **Must match `mymis-api`** |
| `JWT_ISSUER`            | yes      |               | **Must match `mymis-api`**                                      |
| `JWT_AUDIENCE`          | yes      |               | **Must match `mymis-api`**                                      |

Local ports `6380` (Redis) and `27018` (Mongo) are used so they don't clash with other Redis/Mongo instances on the machine.

## Scripts

| Script                      | What it does                                                |
| --------------------------- | ----------------------------------------------------------- |
| `npm run dev`               | Runs `src/index.ts` with `tsx`, restarting on changes       |
| `npm run build`             | Cleans `dist/` and compiles (tests excluded)                |
| `npm start`                 | Runs the compiled build (`dist/index.js`)                   |
| `npm run lint` / `lint:fix` | ESLint with type-aware rules                                |
| `npm run typecheck`         | TypeScript check without emitting files                     |
| `npm test`                  | Unit and server tests (no Docker needed)                    |
| `npm run test:integration`  | Integration tests against real MongoDB and Redis containers |
| `npm run test:watch`        | Vitest in watch mode                                        |

## API

### WebSocket

Connect to `ws://localhost:4000`. The browser's `Origin` must be in `ALLOWED_ORIGINS`, otherwise the upgrade is rejected with `403`.

Browsers can't send an `Authorization` header on a WebSocket, so the **first message must be `AUTH`**:

```json
{ "type": "AUTH", "token": "<access token from mymis-api>" }
```

Wait for `AUTH_OK` before sending anything else. The user id always comes from the token, never from the client.

**Client → server**

| Type                   | Payload                 | Purpose                                                   |
| ---------------------- | ----------------------- | --------------------------------------------------------- |
| `AUTH`                 | `{ token }`             | Authenticate; must be the first message, within 5 seconds |
| `GET_INITIAL_PRESENCE` |                         | Ask for the list of users online right now                |
| `SEND_MESSAGE`         | `{ recipientId, text }` | Send a message (text 1–2000 characters, trimmed)          |

**Server → client**

| Type                    | Payload                                     | When                                                                |
| ----------------------- | ------------------------------------------- | ------------------------------------------------------------------- |
| `AUTH_OK`               | `{ userId }`                                | Authentication succeeded                                            |
| `INITIAL_PRESENCE_LIST` | `{ userIds }`                               | Reply to `GET_INITIAL_PRESENCE`                                     |
| `USER_STATUS_CHANGE`    | `{ userId, status: "online" \| "offline" }` | A user's first tab opened, or last tab closed                       |
| `MESSAGE`               | `{ message }`                               | A saved message, sent to both sender and recipient (all their tabs) |
| `ERROR`                 | `{ message }`                               | Invalid message or request; the connection stays open               |

A `message` looks like this:

```json
{
  "id": "6708f1c2a1b2c3d4e5f60718",
  "roomId": "1-2",
  "senderId": "1",
  "recipientId": "2",
  "text": "hello",
  "createdAt": "2026-10-11T09:30:00.000Z"
}
```

**Close codes**

| Code   | Meaning                                                                | Client should                   |
| ------ | ---------------------------------------------------------------------- | ------------------------------- |
| `4001` | Unauthorized: invalid token, or something other than `AUTH` sent first | Not retry with the same token   |
| `4002` | Token expired (at `AUTH`, or while connected)                          | Refresh the token and reconnect |
| `4008` | No `AUTH` within 5 seconds                                             | Reconnect and authenticate      |

### REST

**`GET /health`**: `200` when MongoDB and Redis are both reachable, `503` otherwise.

**`GET /conversations/:roomId/messages?limit=30&before=<cursor>`**: one page of a conversation, newest first.

- Header: `Authorization: Bearer <access token>`
- `limit`: 1–100, default 30
- `before`: the `nextCursor` from the previous page. It's opaque: pass it back unchanged.

```json
{
  "messages": [
    /* ChatMessage, newest first */
  ],
  "nextCursor": "eyJ0Ijo..."
}
```

`nextCursor` is `null` on the last page.

| Status | `error`                            | Cause                                  |
| ------ | ---------------------------------- | -------------------------------------- |
| `401`  | `unauthorized` / `token_expired`   | Missing, invalid or expired token      |
| `400`  | `invalid_room_id`                  | Malformed room id                      |
| `403`  | `forbidden`                        | You aren't one of the room's two users |
| `400`  | `invalid_query` / `invalid_cursor` | Bad `limit` or tampered cursor         |

### Room ids

A 1:1 room id is the two user ids, smaller first, joined with `-`: users `3` and `1` → `1-3`. There is exactly one valid id per pair, so a conversation can't be split in two.

## Testing

```bash
npm test                  # unit + server tests, fast, no Docker
npm run test:integration  # real MongoDB + Redis via Testcontainers (Docker must be running)
```

- **Unit and server tests** start the real HTTP/WebSocket server on a random port with fake stores, and drive it with real WebSocket clients.
- **Integration tests** start throwaway `mongo:8` and `redis:8-alpine` containers on random ports and test the stores against them.
- **CI** runs lint, typecheck, both test suites and the build on every push and pull request to `master`.

### Manual testing

```bash
TOKEN=$(node --env-file=.env scripts/mint-token.js 1)
node scripts/chat-smoke.js "$TOKEN" 2
```

`mint-token.js` signs a dev-only token for a user id (modes: `valid`, `short`, `expired`, `wrong-key`, `wrong-audience`). `chat-smoke.js` authenticates, sends each line you type to the recipient, and prints everything it receives.

## Project structure

Code is grouped by feature (ADR-0013), with tests in a `__tests__/` folder inside each feature.

```
src/
  index.ts            # entry point: config, connections, startup, shutdown
  config.ts           # env validation (zod)
  server.ts           # composition root: wires features together
  auth/               # JWT verification
  chat/               # messages: model, store, room ids, WebSocket handlers, REST routes
  presence/           # online status: Redis store, WebSocket handlers
  ws/                 # WebSocket server, protocol, socket registry, heartbeat
  http/               # Express app, health check, Bearer authentication
  infrastructure/     # MongoDB and Redis connections
  __tests__/          # server tests and shared test helpers
scripts/              # manual test clients and token minting
docs/adr/             # design, plan and architecture decisions
```

## Design docs

- [Design](docs/adr/design.md)
- [Plan and milestones](docs/adr/plan.md)
- [Architecture decisions (ADRs)](docs/adr/decisions.md)

## Known limitations

- **Single instance only.** Presence counts are reset on startup, which is only correct when one instance owns every connection (ADR-0011). Running several instances is planned (M6).
- **Recipients aren't verified.** The service can't check that a `recipientId` is a real employee; that data lives in `mymis-api`.
- **No self-messaging yet** (rooms like `1-1`). In the backlog.
- **Shared signing key.** The JWT key exists in two services and must be rotated together (ADR-0004).
