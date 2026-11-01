# Working State

## Project
Secure Local LLM Inference Service

## Current Milestone
M5 — Nginx and Rate Limiting (COMPLETED) -> Transitioning to M6 (Cloudflare and External Access)

## Milestone Status
M5_COMPLETED

## Overall Progress
- [x] M0: Environment and foundation
- [x] M1: Local model inference
- [x] M2: API skeleton, DI, and authentication
- [x] M3: Request validation and inference gateway
- [x] M4: Resource management and streaming
- [x] M5: Nginx and rate limiting
- [ ] M6: Cloudflare and external access
- [ ] M7: Reliability and end-to-end testing
- [ ] M8: Performance and security review

## Current Tasks (M5 Completed, M6 Active)
- [x] M5: Configure Nginx reverse proxy at `infra/nginx/nginx.conf` binding strictly to `127.0.0.1:8080`.
- [x] M5: Enforce route allowlist (`POST /v1/chat/completions` and `GET /health` allowed, others 404).
- [x] M5: Enforce method allowlists (reject other methods with HTTP 405 `method_not_allowed`).
- [x] M5: Enforce request body size limit (`client_max_body_size 12m`).
- [x] M5: Enforce request rate limit (`limit_req_zone $binary_remote_addr zone=api_limit:10m rate=6r/m;` with `burst=3 nodelay`).
- [x] M5: Configure unbuffered SSE proxying (`proxy_buffering off`, `proxy_cache off`).
- [x] M5: Return standardized OpenAI-compatible JSON error formats for 404, 405, 413, 429, 502.
- [x] M5: Create Nginx lifecycle management script `scripts/setup/manage-nginx.sh`.
- [x] M5: Author ADR 0005 (`docs/decisions/0005-nginx-reverse-proxy-and-rate-limiting.md`).
- [x] M5: Wrote integration tests in `tests/integration/nginx-proxy.test.ts` (8 tests passing, 81 total tests passing).
- [ ] M6: Define Cloudflare Tunnel ingress configuration in `infra/cloudflare/config.yml`.
- [ ] M6: Implement origin-side Cloudflare Access JWT validation helper / middleware.
- [ ] M6: Create Cloudflare service token authentication contract.
- [ ] M6: Document credential rotation and public vs origin security boundaries.
- [ ] M6: Write automated integration tests for Cloudflare Access validation and origin security.
- [ ] M6: Verify M6 gate criteria.

## Completed Work
- **M0**: Environment audit, tooling, repository foundation (`42cc6b4`).
- **M1**: `qwen3.8:27b` downloaded; Metal GPU acceleration verified; text, reasoning, image, streaming tests passing (`d01e1d9`).
- **M2**: Application skeleton, dependency inversion, timing-safe Bearer authentication hook, fake dependencies (`4d481b6`).
- **M3**: Sharp image validation (magic bytes, 20 MP decompression guard, metadata stripping), Ollama protocol adapter, multimodal validation (`9711314`).
- **M4**: SQLite atomic quota repository with rollback, async semaphore (1 active, 2 queued), bounded resource management (`904f7ea`).
- **M5**:
  - Authored Nginx reverse proxy configuration at `infra/nginx/nginx.conf` (127.0.0.1:8080).
  - Implemented route allowlisting, method filtering (405), rate limiting (6 req/min burst 3 nodelay -> 429), unbuffered SSE streaming (`proxy_buffering off`), and custom JSON error handling.
  - Implemented `scripts/setup/manage-nginx.sh` for lifecycle management.
  - Authored ADR 0005 (`docs/decisions/0005-nginx-reverse-proxy-and-rate-limiting.md`).
  - Added 8 new integration tests in `tests/integration/nginx-proxy.test.ts`.
  - All 81 tests passing cleanly across 12 test files.

## Architecture Decisions
- ADR-0001: Technology Stack and Development Environment Isolation.
- ADR-0002: Service Coexistence and Ollama Instance Management.
- ADR-0003: Ollama MLX Runner & Metal Acceleration.
- ADR-0004: Composition Root, Dependency Inversion, and Early Authentication Hook.
- ADR-0005: Request Validation, Image Sanitization, and Inference Gateway.
- ADR-0006: Quota Accounting, Concurrency Controls, and Cancellation.
- ADR-0007: Nginx Reverse Proxy and Network-Level Protection — Loopback isolation on 8080, leaky-bucket rate limiting (6r/m burst 3 nodelay), 12m body limits, unbuffered SSE streaming, and OpenAI-compatible JSON error pages.

## Files Changed
- `docs/decisions/0005-nginx-reverse-proxy-and-rate-limiting.md`
- `infra/nginx/nginx.conf`
- `scripts/setup/manage-nginx.sh`
- `tests/integration/nginx-proxy.test.ts`
- `tests/integration/ollama-inference.test.ts`
- `working.md`

## Tests Written
- `tests/integration/nginx-proxy.test.ts` (8 tests)
- Total tests in repository: 81 tests across 12 test suites

## Tests Executed
- Command: `pnpm typecheck` (PASS - 0 errors)
- Command: `pnpm lint` (PASS - 0 errors)
- Command: `pnpm test` (PASS - 81/81 tests across 12 test files in 25.73s)

## Current Blockers
- None.

## Known Bugs
- None.

## Important Context
- Nginx is verified on 127.0.0.1:8080.
- Next step M6 configures Cloudflare Tunnel and Access token verification.

## Next Exact Action
- Implement M6: Create `infra/cloudflare/config.yml`, implement Access JWT verification middleware/authenticator, and write integration tests for Cloudflare header checks and external access.

## Last Verification
- Ran full test suite — 81/81 tests passed with 100% success.
