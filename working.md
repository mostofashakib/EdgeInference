# Working State

## Project
Secure Local LLM Inference Service

## Current Milestone
M4 — Resource Management, Quota, Concurrency, and Streaming (COMPLETED) -> Transitioning to M5 (Nginx and Network-Level Limits)

## Milestone Status
M4_COMPLETED

## Overall Progress
- [x] M0: Environment and foundation
- [x] M1: Local model inference
- [x] M2: API skeleton, DI, and authentication
- [x] M3: Request validation and inference gateway
- [x] M4: Resource management and streaming
- [ ] M5: Nginx and rate limiting
- [ ] M6: Cloudflare and external access
- [ ] M7: Reliability and end-to-end testing
- [ ] M8: Performance and security review

## Current Tasks (M4 Completed, M5 Active)
- [x] M4: Implement `SqliteQuotaRepository` using better-sqlite3 with WAL mode, atomic immediate transactions, and persistence across process restarts.
- [x] M4: Implement `SemaphoreAdmissionController` with 1 active slot, 2 bounded queue slots, and immediate HTTP 429 (`ConcurrencyLimitError`) on overflow.
- [x] M4: Implement quota rollback protocol: requests rejected due to queue capacity or cancelled while queued never burn daily quota.
- [x] M4: Implement resource lease release in `finally` blocks with double-release protection.
- [x] M4: Authored ADR 0004 (`docs/decisions/0004-quota-and-concurrency-management.md`).
- [x] M4: Wrote unit and integration tests across 3 new test suites (13 new tests, 73 total tests passing).
- [ ] M5: Create Nginx reverse proxy configuration at `infra/nginx/nginx.conf` binding to `127.0.0.1:8080`.
- [ ] M5: Configure route allowlist (strictly `POST /v1/chat/completions` and `GET /health`, reject all other paths/methods with 404/405).
- [ ] M5: Configure client max body size (12m).
- [ ] M5: Configure rate limiting (limit_req_zone 6 req/min with burst 3 and nodelay).
- [ ] M5: Disable proxy buffering (`proxy_buffering off`, `proxy_cache off`) for progressive SSE streaming.
- [ ] M5: Configure upstream keepalive and connection controls.
- [ ] M5: Write automated Nginx verification and integration tests.
- [ ] M5: Verify M5 gate criteria.

## Completed Work
- **M0**: Environment audit, tooling, repository foundation (`42cc6b4`).
- **M1**: `qwen3.8:27b` downloaded; Metal GPU acceleration verified; text, reasoning, image, streaming tests passing (`d01e1d9`).
- **M2**: Application skeleton, dependency inversion, timing-safe Bearer authentication hook, fake dependencies (`4d481b6`).
- **M3**: Sharp image validation (magic bytes, 20 MP decompression guard, metadata stripping), Ollama protocol adapter, multimodal validation (`9711314`).
- **M4**:
  - Implemented `SqliteQuotaRepository` (`gateway/src/infrastructure/persistence/SqliteQuotaRepository.ts`).
  - Implemented `SemaphoreAdmissionController` (`gateway/src/infrastructure/concurrency/SemaphoreAdmissionController.ts`).
  - Enhanced `InferenceService` and `QuotaService` with atomic quota rollback on admission rejection.
  - Wired production dependencies into composition root `createDependencies.ts`.
  - Added 13 new unit and integration tests (`sqlite-quota.test.ts`, `admission-controller.test.ts`, `resource-limits.test.ts`).
  - Verified atomic persistence across restart and bounded concurrency with 73 total passing tests.

## Architecture Decisions
- ADR-0001: Technology Stack and Development Environment Isolation.
- ADR-0002: Service Coexistence and Ollama Instance Management.
- ADR-0003: Ollama MLX Runner & Metal Acceleration.
- ADR-0004: Composition Root, Dependency Inversion, and Early Authentication Hook.
- ADR-0005: Request Validation, Image Sanitization, and Inference Gateway.
- ADR-0006: Quota Accounting, Concurrency Controls, and Cancellation — Strict 1-active semaphore with bounded queue of 2, SQLite in WAL mode for persistent daily quotas, and atomic quota rollback on admission rejection.

## Files Changed
- `docs/decisions/0004-quota-and-concurrency-management.md`
- `gateway/src/application/InferenceService.ts`
- `gateway/src/application/QuotaService.ts`
- `gateway/src/composition/createDependencies.ts`
- `gateway/src/domain/interfaces/index.ts`
- `gateway/src/infrastructure/concurrency/SemaphoreAdmissionController.ts`
- `gateway/src/infrastructure/persistence/SqliteQuotaRepository.ts`
- `tests/fakes/index.ts`
- `tests/integration/resource-limits.test.ts`
- `tests/unit/admission-controller.test.ts`
- `tests/unit/sqlite-quota.test.ts`
- `working.md`

## Tests Written
- `tests/unit/sqlite-quota.test.ts` (4 tests)
- `tests/unit/admission-controller.test.ts` (5 tests)
- `tests/integration/resource-limits.test.ts` (4 tests)
- Total tests in repository: 73 tests

## Tests Executed
- Command: `pnpm typecheck` (PASS - 0 errors)
- Command: `pnpm lint` (PASS - 0 errors)
- Command: `pnpm test` (PASS - 73/73 tests across 11 test files in 25.00s)

## Current Blockers
- None.

## Known Bugs
- None.

## Important Context
- Gateway enforces daily quota (100) and active inference limit (1 active + 2 queue slots).
- In M5, Nginx will wrap the gateway at `127.0.0.1:8080` with network rate limiting (6 req/min, burst 3) and route restriction.

## Next Exact Action
- Implement M5: Configure Nginx at `infra/nginx/nginx.conf`, start Nginx on loopback 8080, and write integration tests verifying routing, rate limiting, and unbuffered SSE streaming.

## Last Verification
- Ran full test suite — 73/73 tests passed with 100% success.
