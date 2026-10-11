# MyMIS Chat Service: Implementation Plan

> **Location:** `docs/plan.md`

Each milestone ends with something runnable and committed. Check items off as you go.

## M0: Decide and reset (next session start)

- [x] ADR-0004/5/6 accepted (ADR-0007 still Proposed)
- [x] Read JWT config in `mymis-api`
- [x] Decision: NOT renaming `mymis-api-node`; create a new repo `mymis-chat-service` for fresh commits (user does git steps)
- [x] Create `mymis-chat-service` on GitHub and push docs/
- [x] Decide old `mymis-api-node` fate (revert my wipe commit 5ba8720, archive, or leave)

## M1: Scaffold + presence parity

- [x] `npm init`, TypeScript, ESLint, `tsx` for dev, `tsc` for build
- [x] `docker-compose.yml`: service + Redis + Mongo
- [x] Config module reading env vars (+ `.env.example`, `.env` git-ignored)
- [x] `ws` server + the four existing presence messages
- [x] Connection counting (fix multi-tab bug) + heartbeat
      **Done when:** the portal protocol works against the new service in a manual test (portal still untouched; test with a small script).

## M2: JWT authentication

- [x] `AUTH` first-message flow, timeout, close codes
- [x] Identity comes from token; remove `userId` trust
- [x] Unit tests for token validation (valid, expired, wrong signature, wrong audience)

## M3: Rooms + MongoDB persistence

- [x] Room id helper + membership check
- [x] `SEND_MESSAGE` -> validate (zod) -> save -> deliver to the two participants
- [x] History REST endpoint with cursor paging; index on `(roomId, createdAt)`

## M4: Tests + CI

- [x] Vitest/Supertest + ws client tests, Testcontainers for Redis/Mongo
- [x] GitHub Actions on `pull_request`
- [x] README with architecture diagram and run instructions

## M5: Switch the portal (separate, deliberate step)

- [x] Add `VITE_CHAT_WS_URL` / `VITE_CHAT_API_URL` (chat off when unset); send `AUTH` after connect
- [x] Merge the two sockets into the context (presence, live messages, reconnect with backoff, refresh on 4002)
- [x] Directory lists real employees (`/api/Employees/lookup`) instead of json-server users
- [x] Load history from REST (cursor paging, "Load older messages", refetch after reconnect)
- [x] Remove the old chat socket from `server/`; `server/` + `redis:start` kept for OTP only, on port 4100 (ADR-0008)

## M6: Deploy

- [x] Data stores: MongoDB Atlas M0 + Upstash Redis (AWS Singapore)
- [x] Multi-stage Dockerfile (0 high/critical vulnerabilities), image in ECR with immutable commit tags
- [x] Secrets in SSM Parameter Store; service on ECS Express Mode (Fargate + ALB, max 1 task)
- [x] Portal on Vercel (`mymis-portal.vercel.app`): SPA rewrite, production chat URLs, CORS in mymis-api and chat service
- [x] CI/CD: GitHub Actions deploys on push to master via OIDC (no stored AWS keys)

## Backlog

- [ ] Two-user end-to-end chat test in production (needs a second employee in Supabase)
- [ ] Merge the portal sidebar logo fix (import the logo files so the production build includes them)
- [ ] M6 docs: ADR for the hosting choice, README deployment section
- [ ] Redis pub/sub for multi-instance scale-out
- [ ] Rebuild OTP in `mymis-api`, then delete portal `server/`, `redis:start` and `my-redis`
- [ ] Update resume Node entry and cover letter when M4 is done
- [ ] Unread counts / notifications for conversations that aren't open
- [ ] Directory beyond 50 employees (search, or a dedicated endpoint)
- [ ] Allow messaging yourself (self-notes): rooms like `1-1` in `roomIdFor`/`parseRoomId`, flip the three same-user tests, remove the self-message check in `chat/chat.handlers.ts`, de-duplicate recipients in `sendToUsers` (otherwise a self-message is delivered twice)
