# ADR-0001 to ADR-0012

> **Location:** `docs/adr/decisions.md` (split into one file per ADR later if you prefer)
> **Last updated:** 2026-10-10 (end of M2)

---

## ADR-0001: Chat is a standalone Node microservice

**Status:** Accepted
**Context:** Earlier idea: a second full backend in Node, or fold chat into .NET with SignalR.
**Decision:** Independent Node service that owns chat only. The .NET API remains the system of record.
**Alternatives:** (a) SignalR inside `mymis-api`: idiomatic .NET, but no Node experience and couples chat to API deploys. (b) Second full Node backend: duplicates work, low value.
**Consequences:** Two deployables, a cross-service auth contract (JWT), and independent scaling. Postgres knowledge still transfers; this is a different skill (realtime, Mongo, Redis).

## ADR-0002: Rebuild from scratch

**Status:** Accepted
**Context:** Scaffold has ~10 defects (wrong imports, undefined helpers, no password hashing, one route).
**Decision:** New project; old history is not carried forward in any meaningful way.
**Consequences:** Clean start, a proper README and tests from commit one.

## ADR-0003: MongoDB for messages, Redis for presence

**Status:** Accepted
**Context:** Portal already uses Redis (presence) and the user wants conversations in Mongo.
**Decision:** As stated.
**Alternatives:** Postgres for messages (simpler ops, relational joins); Redis for everything (not durable).
**Consequences:** Two datastores to run locally (Docker Compose) and to test.

## ADR-0004: Validate the .NET JWT with a shared HMAC secret first

**Status:** Accepted (2026-10-10), implemented in M2.
**Context:** The .NET API issues HS256 JWTs. The chat service must trust them without calling the API each time.
**Decision:** Share the signing secret via env var (`JWT_KEY`, `JWT_ISSUER`, `JWT_AUDIENCE`); verify signature, `exp`, issuer, audience.
**Verified contract (from `mymis-api` `TokenService.cs` / `Program.cs`):** HS256; key encoded as UTF-8 bytes (`Encoding.UTF8.GetBytes`); claims `sub` (employee id), `name`, `role`, `departmentId` (optional), `permission` (repeated); 15-minute access token; `ClockSkew = 0`. No change to `mymis-api` was needed.
**Implementation (M2):** `src/auth.ts` with the `jose` library. `jwtVerify` with `algorithms: ['HS256']` (blocks algorithm-confusion attacks), issuer, audience, `clockTolerance: 0`, `requiredClaims: ['sub', 'exp']`; claim shape (`sub`, `name`, `role`, `exp`) checked with zod. Returns a result (`ok` / `expired` / `invalid`) instead of throwing; the client is never told which check failed. Covered by 10 unit tests (`src/auth.test.ts`).
**Alternatives:** Asymmetric (RS256/ES256): service holds only a public key: safer, but requires changing the API. Call an API introspection endpoint: simple but couples runtime availability.
**Consequences:** Secret exists in two places (rotate together). Revisit when moving to AWS (ADR for secrets management).

## ADR-0005: First-message AUTH for WebSockets

**Status:** Accepted (2026-10-10), implemented in M2.
**Context:** Browsers can't send `Authorization` on a WebSocket handshake.
**Decision:** Client sends `{ type: "AUTH", token }` as the first message; 5 s timeout; unauthenticated sockets can do nothing else.
**Decisions made during M2:**

- **`AUTH` replaces `REGISTER_PRESENCE`.** A successful `AUTH` registers presence; the user id comes only from the token's `sub`, never from the client. `REGISTER_PRESENCE` was removed from the protocol (breaking change, `feat!`).
- **Expiry closes the socket.** The server records `exp` at `AUTH` time and closes with 4002 when it's reached; the portal refreshes via its existing axios flow and reconnects. Accepting a re-`AUTH` on the open socket was considered and rejected (more state on both sides).
- **Client contract:** send `AUTH`, wait for `AUTH_OK { userId }`, then send anything else. Any other message (or a second `AUTH`) before `AUTH_OK` closes the connection.
- **Failures are close codes, not messages** (no `AUTH_ERROR`):
  - 4001 unauthorized: invalid token, or a non-`AUTH` first message
  - 4002 token expired: at `AUTH` time or while connected (client should refresh and reconnect)
  - 4008 auth timeout: no `AUTH` within 5 s
- **Presence is only shared with authenticated sockets** (broadcasts go to an authenticated-sockets set, not all clients).
  **Alternatives:** Token in query string (ends up in logs: rejected). Short-lived single-use ticket from a .NET endpoint (most secure, more work). Subprotocol header trick (hacky).
  **Consequences:** A tiny window where an unauthenticated socket exists; mitigated by the timeout and by closing on any other message.

## ADR-0006: TypeScript + Express 5 + ws

**Status:** Accepted (2026-10-10). NestJS deferred to a separate future project.
**Decision:** TypeScript for the same safety you get from C#; Express 5 for REST (already used in the portal server); `ws` for sockets (already used).
**Alternatives:** NestJS (closest to ASP.NET: DI, controllers, decorators; heavier, bigger learning step), Socket.IO (rooms and reconnect built in, but non-standard protocol, hides what you want to learn).
**Consequences:** You write more plumbing by hand: that's the learning goal.

## ADR-0007: Store sender id only

**Status:** Accepted (2026-10-10, M3 Step 2)
**Context:** Messages need to show who sent them. Employee names and avatars live in `mymis-api` and can change (renames, new avatars).
**Decision:** Messages store `senderId` and `recipientId` only; the portal resolves names/avatars from data it already loads from the API. `recipientId` is technically derivable from `roomId` + `senderId`, but is kept so future per-user queries (e.g. unread counts) are a direct index lookup.
**Alternatives:** Snapshot name/avatar into each message (history renders without lookups, but shows stale names after profile changes and duplicates data the API owns).
**Consequences:** Renames and new avatars apply to old messages automatically. The portal must have the employee list (or fetch it) to render a conversation.

## ADR-0008: OTP stays out of the chat service

**Status:** Accepted
**Context:** OTP is unrelated to chat and its verify path is broken today (reads a cache never written).
**Decision:** Remains in portal `server/` for now; later rebuilt in `mymis-api` beside the EmployeePhone module.
**Update (2026-10-11, M5):** `server/` is now OTP only. It moved from port 4000 to **4100** (4000 belongs to the chat service), and the portal calls it through `otpClient`. `sendOtp` still stores codes in the portal's `my-redis` (6379), so `npm run server` and `npm run redis:start` stay until OTP is rebuilt in `mymis-api`.

## ADR-0009: Portal untouched for now

**Status:** Superseded by ADR-0014 (2026-10-11, M5 done)
**Decision:** No portal edits until the service passes its tests. Cleanup (switch to `VITE_CHAT_WS_URL`, send `AUTH` after connect, merge the two sockets, delete `server/` and `redis:start`) is Milestone 5.
**Outcome:** Done in M5, except that `server/` and `redis:start` were kept for OTP (see ADR-0008 update).

## ADR-0010: Pin TypeScript to 6.0

**Status:** Accepted (2026-10-10)
**Context:** A plain `npm install -D typescript` installed TypeScript 7 (the native Go compiler). typescript-eslint supports TypeScript below 6.1 only, so ESLint couldn't be installed alongside it.
**Decision:** Pin `typescript@~6.0` (patch updates only). Use standard ESLint flat config with `typescript-eslint` type-checked rules.
**Alternatives:** Keep TS 7 with a different linter (Biome, oxlint): works today, but less common and weaker type-aware rules.
**Consequences:** Revisit once typescript-eslint supports TS 7; upgrading is a one-line change. Since TS 6, `@types/*` aren't loaded automatically, so `tsconfig.json` lists `"types": ["node"]`.

## ADR-0011: Presence as per-user connection counts

**Status:** Accepted (2026-10-10)
**Context:** The portal's server stored a set of online users, so closing one of two tabs marked the user offline (defect #4), and dead connections stayed online forever.
**Decision:**

- Redis hash `chat:presence:connections`: field = user id, value = open connection count, updated with atomic `HINCRBY`. Broadcast `online` only when a count goes 0 → 1, `offline` only when it reaches 0.
- Zero-count entries are kept, not deleted (deleting after reaching 0 races with a tab connecting at the same moment).
- A ping/pong heartbeat (`HEARTBEAT_INTERVAL_MS`, default 30 s) terminates unresponsive sockets, which runs the normal close path.
- On startup, the hash is reset: a single instance owns every live connection, so leftover counts came from connections that died with a previous run.
  **Consequences:** The startup reset is wrong once several instances share one Redis (each would wipe the others' counts); multi-instance presence needs per-instance tracking and is part of M6.

## ADR-0012: Vitest for tests

**Status:** Accepted (2026-10-10), replaces "Jest" in the M4 plan
**Context:** The service is ES modules + TypeScript.
**Decision:** Vitest: runs TS and ESM natively (Jest needs extra transform/ESM configuration), and it's the same runner as the portal. Tests live next to the code as `*.test.ts`; `tsconfig.build.json` excludes them from the production build, while `tsconfig.json` keeps them type-checked and linted.
**Consequences:** One test runner across the portal and the chat service.

## ADR-0013: Feature-based source layout

**Status:** Accepted (2026-10-11)
**Context:** All source files sat flat in `src/`, and `server.ts` had grown to handle the Express app, the upgrade, the heartbeat, the socket registry, the AUTH state machine and every message handler.
**Decision:** Group by feature (`auth/`, `presence/`, `chat/`) plus the two transports (`http/`, `ws/`) and `infrastructure/` (database connections). Files carry role suffixes (`message.store.ts`, `chat.routes.ts`, `token.verifier.ts`), the same convention as the portal. `index.ts` stays the composition root.
**Alternatives:** Layered MVC (`routes/`, `controllers/`, `services/`, `models/`), common in Express tutorials and closest to `mymis-api`; rejected because most of this service isn't REST controllers, and one feature would be spread across several folders.
**Consequences:** A feature's code lives in one folder. `server.ts` is split into `http/` and `ws/` modules in a second step, after the server tests exist, so the black-box tests guard that refactor.
Tests live in a `__tests__/` folder inside the feature they test (e.g. `chat/__tests__/room.test.ts`); whole-server tests and shared test helpers live in `src/__tests__/`. The build excludes `src/**/__tests__/**`.

## ADR-0014: Portal chat integration

**Status:** Accepted (2026-10-11, M5)
**Context:** The portal opened two unauthenticated sockets (one in a context, one in the user directory), trusted a client-sent `userId`, stored history in json-server, and listed json-server users whose ids (`"ABC123"`) never match the token's `sub` (employee ids).
**Decision:**

- **One socket per tab**, owned by `WebSocketProvider` (inside `AuthProvider`). It sends `AUTH` on open, waits for `AUTH_OK`, then requests presence. Presence (`onlineIds`), live messages and `sendMessage(recipientId, text)` are exposed through the context.
- **Reconnect** with exponential backoff (1 s doubling to 30 s, plus jitter); the backoff resets only on `AUTH_OK`. `4001` stops; `4002` and every other close reconnect, and each attempt first gets a valid token (refreshing an expired one).
- **One token refresh for HTTP and WebSocket:** `refreshAccessToken()` in `api/client.ts` is single-flight (concurrent callers share one Promise), used by the axios 401 interceptor on `apiClient` and `chatClient` and by the socket. Required because mymis-api rotates refresh tokens.
- **History** through `GET /conversations/:roomId/messages` with React Query `useInfiniteQuery` (pages = cursor pages, "Load older messages"). Live and history messages are merged by `id` and sorted by `createdAt`, then `id`. Chat queries are invalidated on every `AUTH_OK`, so messages missed while disconnected appear after reconnecting.
- **No optimistic display:** a sent message appears when the server echoes it as `MESSAGE`, so the UI only shows saved messages.
- **Directory** lists employees from `GET /api/Employees/lookup?limit=50`.
- **Feature switch:** chat is enabled only when `VITE_CHAT_WS_URL` and `VITE_CHAT_API_URL` are set; production leaves them unset until the service is deployed (M6).
  **Alternatives:** Keep a separate directory socket (two connections per tab, duplicated presence state). Optimistic messages (instant, but needs pending/failed states and reconciliation). A new paged employees endpoint for the directory (not needed while the organization is under 50 employees).
  **Consequences:** The portal duplicates the wire types (`src/models/chat.model.ts`); protocol changes must update both repos. The directory shows at most 50 employees, so a larger organization needs search or a dedicated endpoint. No unread counts or notifications for conversations that aren't open.
