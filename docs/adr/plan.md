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

- [ ] `npm init`, TypeScript, ESLint, `tsx` for dev, `tsc` for build
- [ ] `docker-compose.yml`: service + Redis + Mongo
- [ ] Config module reading env vars (+ `.env.example`, `.env` git-ignored)
- [ ] `ws` server + the four existing presence messages
- [ ] Connection counting (fix multi-tab bug) + heartbeat
      **Done when:** the portal protocol works against the new service in a manual test (portal still untouched; test with a small script).

## M2: JWT authentication

- [ ] `AUTH` first-message flow, timeout, close codes
- [ ] Identity comes from token; remove `userId` trust
- [ ] Unit tests for token validation (valid, expired, wrong signature, wrong audience)

## M3: Rooms + MongoDB persistence

- [ ] Room id helper + membership check
- [ ] `SEND_MESSAGE` -> validate (zod) -> save -> deliver to the two participants
- [ ] History REST endpoint with cursor paging; index on `(roomId, createdAt)`

## M4: Tests + CI

- [ ] Jest/Supertest + ws client tests, Testcontainers for Redis/Mongo
- [ ] GitHub Actions on `pull_request`
- [ ] README with architecture diagram and run instructions

## M5: Switch the portal (separate, deliberate step)

- [ ] Add `VITE_CHAT_WS_URL`; send `AUTH` after connect
- [ ] Merge the two sockets into the context
- [ ] Load history from REST
- [ ] Delete `server/` and `redis:start`; keep OTP until .NET version exists

## M6: Later

- [ ] Deploy (AWS ECS or Azure), secrets management
- [ ] Redis pub/sub for multi-instance scale-out
- [ ] Rebuild OTP in `mymis-api`
- [ ] Update resume Node entry and cover letter when M4 is done
