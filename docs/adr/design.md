# MyMIS Chat Service: Design Document

> **Location:** `docs/design.md` in the chat-service repo (`mymis-chat-service`, a new repo; the old `mymis-api-node` is not reused)
> **Status:** Draft v1. Agreed direction, some details still **Proposed** (see `adr/` and Open Questions).
> **Last updated:** 2026-10-10

## 1. Why this exists
The MyMIS portal currently embeds a small Node server (`mymis-portal/server/`) that does websocket chat and online presence, plus OTP endpoints. It works as a demo, but it has structural problems (section 3). The old `mymis-api-node` repo is a broken scaffold with nothing worth keeping.

Decision: build a **dedicated Node.js chat microservice** from scratch in that repo. It sits **beside** the .NET API, not instead of it.

> **Concept: microservice.** A small, independently deployable service that owns ONE capability and its own data. Here: chat (messages + presence). The .NET API owns employees, auth, and everything else. In .NET terms, imagine a second solution with its own `Program.cs`, its own database, deployed on its own.

## 2. Goals and non-goals
**Goals**
1. Standalone Node service owning chat messages (MongoDB) and presence (Redis).
2. Authenticated: only real MyMIS users connect, and identity comes from the token, never from what the client claims.
3. Messages go only to the people in the conversation.
4. Tested and run through CI, like `mymis-api`.
5. Wire protocol stays backward-compatible in the first milestone, so switching the portal later is mostly a URL change.

**Non-goals (v1):** OTP/SMS (rebuilt in .NET later), group chats, typing indicators, read receipts, attachments, any change to the portal.

## 3. Defects in the current portal `server/` (do NOT reproduce)
| # | Defect | Why it matters |
|---|---|---|
| 1 | No authentication | Anyone can connect |
| 2 | `REGISTER_PRESENCE` trusts a client-sent `userId` | Anyone can pretend to be anyone (impersonation) |
| 3 | `broadcastToAll(parsedData)` for every other message | Private chats are sent to every connected client |
| 4 | Presence removes the user on ANY socket close | Two tabs: closing one marks you offline |
| 5 | Portal opens two sockets (context + user-directory, one hardcoded) | Wasteful and inconsistent |
| 6 | Hardcoded port 4000 and Redis URL | Cannot deploy or configure |
| 7 | Deprecated `crypto` npm package | Placeholder package; Node has `crypto` built in |
| 8 | No payload validation or size limits | Malformed or huge messages can crash or abuse it |
| 9 | No tests | Same as every other thing here: unproven |

> **JS/Node vs .NET parallel:** #2 is the same lesson as your `DepartmentScope` handler: never trust the client for identity or scope; derive it server-side and fail closed.

## 4. Architecture
```
 Portal (React)                         MyMIS API (.NET)
      |  1. login -> JWT                      |  issues JWT (HS256)
      |<--------------------------------------|
      |
      |  2. WebSocket + JWT
      v
 +--------------------------+      +-----------+
 |  MyMIS Chat Service      |----->|  Redis    |  presence (who is online)
 |  Node + TS + Express + ws|      +-----------+
 |                          |      +-----------+
 |  REST: history, health   |----->|  MongoDB  |  messages
 +--------------------------+      +-----------+
```
- **WebSocket:** realtime send/receive and presence events.
- **REST:** `GET /conversations/:roomId/messages?before=<cursor>&limit=30` for history, `GET /health`.
- **Redis:** set of online users with per-user connection counts.
- **MongoDB:** `messages` collection.

> **Concept: why two stores?** Presence is tiny, ephemeral, fast-changing: perfect for Redis (in-memory). Messages are durable documents you query by room and time: a fit for MongoDB. Postgres (which `mymis-api` uses) would also work for messages, but Mongo keeps this service independent and gives you the second-database experience.

## 5. Wire protocol (v1, backward compatible)
Existing messages kept: `REGISTER_PRESENCE`, `GET_INITIAL_PRESENCE`, `INITIAL_PRESENCE_LIST`, `USER_STATUS_CHANGE`.

New in M2+: `AUTH` (first message), `AUTH_OK`, `AUTH_ERROR`, `SEND_MESSAGE`, `MESSAGE` (delivered), `ERROR`.

Chat message shape (matches what json-server stores today so the portal changes little):
```json
{ "id": "...", "roomId": "1-3", "senderId": 1, "recipientId": 3,
  "text": "hello", "timestamp": "2026-10-10T08:00:00.000Z" }
```
`senderId` is **set by the server from the JWT**, never read from the client.

## 6. Authentication (Accepted, see ADR-0004 / ADR-0005)
- The service validates the JWT the .NET API already issues.
- Browsers cannot set an `Authorization` header on a WebSocket, so the client sends `{type:"AUTH", token}` as the **first message**; the server closes the socket if it doesn't arrive within ~5s or the token is invalid.
- Verified in `mymis-api` (`Program.cs`, `TokenService.cs`, `JwtOptions.cs`): HS256; validate signature, issuer, audience, and lifetime with zero clock skew. Claims: `sub` (employee id), `name`, `role`, `departmentId`, `permission` (repeated). Access token lives 15 minutes, so the service must handle expiry on long-lived sockets (close with an auth-expired code; the portal refreshes and reconnects).
- Phase 1: shared HMAC secret via env var. Later: asymmetric keys so the chat service only needs the public key.

> **.NET parallel:** this is `AddJwtBearer` with `TokenValidationParameters`. In Node you'll do the same with the `jose` or `jsonwebtoken` library, by hand, inside the socket's first-message handler.

## 7. Rooms and routing
- 1:1 room id is deterministic: sort the two user ids, join with `-` (so `3,1` and `1,3` both give `1-3`).
- Server checks the authenticated user is one of the two ids in `roomId` before sending or reading history.
- A message is delivered only to sockets of the room's two participants.

## 8. Presence
- Redis hash/sorted structure `presence:connections` with a **connection count per user** (increment on connect, decrement on close; remove at 0).
- Broadcast `USER_STATUS_CHANGE` only on 0→1 and 1→0 transitions.
- Heartbeat: server pings every 30s, terminates sockets that miss a pong, so crashes don't leave ghost "online" users.

## 9. Data model (MongoDB)
`messages`: `{ _id, roomId, senderId, recipientId, text, createdAt }`
- Index: `{ roomId: 1, createdAt: -1 }`
- History paging uses a cursor (`createdAt`/`_id` of last item), not `skip` (skip gets slower as it grows).
- Store ids only, not name/avatar snapshots (see ADR-0007).

## 10. Validation and security
- zod schema per incoming message type; reject unknown types.
- Max message length (e.g. 2,000 chars) and `maxPayload` on the `ws` server.
- Origin allow-list for the WebSocket upgrade.
- Config only from environment variables; `.env` is git-ignored (the repos are public).
- Rate limit sends per connection (simple counter in v1).

## 11. Testing and CI
- Jest + Supertest for REST; `ws` client in tests for socket flows.
- Real Redis/Mongo via Testcontainers (same idea as your Postgres Testcontainers in `mymis-api`).
- GitHub Actions on `pull_request`: install, lint, typecheck, test.

## 12. Operations
Structured JSON logs, `/health`, graceful shutdown (close sockets, then Redis/Mongo), Docker image, `docker-compose.yml` for local (service + Redis + Mongo).

## 13. Open questions
1. Handling of access-token expiry on an open socket: close-and-reconnect vs re-`AUTH` message (decide in M2).
2. What to do with the old `mymis-api-node` repo (revert, archive, or leave).
5. Where does display data (name/avatar) come from: the portal already has it; likely fetch client-side.
