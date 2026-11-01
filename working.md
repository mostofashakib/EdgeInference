# Working State

## Project
Secure Local LLM Inference Service

## Current Task
Rate Limiting Non-Owners, End-to-End Flows, Docs Gitignoring, and Comprehensive E2E Testing

## Status
COMPLETED

## Overall Progress
- [x] M0: Environment and foundation
- [x] M1: Local model inference
- [x] M2: API skeleton, DI, and authentication
- [x] M3: Request validation and inference gateway
- [x] M4: Resource management and streaming
- [x] M5: Nginx and rate limiting
- [x] M6: Cloudflare and external access
- [x] M7: Reliability and end-to-end testing
- [x] M8: Performance and security review
- [x] Model output schema definition & README documentation
- [x] Zero-PII sanitization & centralized local .env
- [x] Unified run.sh & kill.sh service management scripts
- [x] Untrack docs from git and add docs/ to .gitignore
- [x] Implement non-owner rate limiting in QuotaService & Gateway (exempt owner, strict limit for guests)
- [x] Configure Nginx rate limit bypass for local owner & strict IP rate limiting for external/guests
- [x] Create executable end-to-end flows script (`scripts/flows/run-all-flows.ts`) and `pnpm flows`
- [x] Create automated end-to-end flows test (`tests/integration/e2e-flows.test.ts`)
- [x] Create unit tests for role-based rate limiting (`tests/unit/quota-service.test.ts`)
- [x] Verify full test suite (129 tests across 19 suites passing), typecheck, and lint

## Completed Work
- **Docs Gitignoring**: Added `docs/` to `.gitignore` and untracked `docs/` from git index while safely retaining local documentation files on disk.
- **Non-Owner Rate Limiting & Anti-DDoS**:
  - Enforced cryptographic separation between owner (`role: "owner"`) and non-owners (`role: "guest"`).
  - Owner is exempt from all rate limiting and daily quota restrictions.
  - Non-owners are throttled by an in-memory sliding window (default 3 req/min) returning HTTP 429 `rate_limit_exceeded`, and by persistent SQLite daily quotas (default 10 req/day) returning HTTP 429 `quota_exceeded`.
  - Nginx reverse proxy configured with `$rate_limit_key` mapping: local owner requests evaluate to empty string `""` (bypassing Nginx rate limiting), while external / guest requests evaluate to `$binary_remote_addr` (throttled to 6 req/min with burst 3).
- **Executable End-to-End Flows**:
  - Implemented `scripts/flows/run-all-flows.ts` with colorized terminal output covering:
    1. Multi-turn interactive chat flow.
    2. Multimodal image understanding (Base64 data URL).
    3. Multi-step complex reasoning flow.
    4. Real-time unbuffered SSE streaming flow.
    5. Non-owner burst DDoS defense flow.
    6. Owner immediate immunity verification.
- **Automated Test Coverage**:
  - `tests/integration/e2e-flows.test.ts` (8 comprehensive tests covering all flows and defense mechanisms).
  - `tests/unit/quota-service.test.ts` (5 unit tests verifying sliding window expiry, quota rollbacks, and owner bypass).
  - `tests/integration/nginx-proxy.test.ts` updated to verify both owner bypass and guest HTTP 429 rate limiting.

## Architecture Decisions
- **Owner vs Everyone Else**: Zero-trust separation using Bearer API secret authentication. The owner has guaranteed unthrottled access, ensuring external DDoS attempts or guest floods never interrupt the owner's workflow.
- **Two-Tier DDoS Defense**:
  1. *Layer 1 (Nginx)*: Drops connection floods before reaching Node.js (6 req/min, burst 3).
  2. *Layer 2 (Fastify QuotaService)*: Enforces sliding window rate limit (3 req/min) and persistent SQLite daily quota (10 req/day).

## Files Changed
- `.gitignore` (untracked docs/)
- `README.md` (documented flows runner, defense architecture, test suite commands)
- `package.json` (added `"flows": "tsx scripts/flows/run-all-flows.ts"`)
- `gateway/src/app.ts` (wired role and guest configuration)
- `gateway/src/application/QuotaService.ts` (sliding window rate limiter + owner bypass)
- `gateway/src/application/InferenceService.ts` (role-aware lease and quota acquisition)
- `gateway/src/composition/createDependencies.ts` (role assignments for primary vs guest keys)
- `gateway/src/config/AppConfig.ts` (guest daily quota and rate limit config)
- `gateway/src/domain/errors/index.ts` (RateLimitExceededError definition)
- `gateway/src/domain/models/types.ts` (ClientRole export)
- `gateway/src/http/controllers/ChatCompletionController.ts` (passes role to inference service)
- `gateway/src/infrastructure/auth/BearerTokenAuthenticator.ts` (role mapping)
- `infra/nginx/nginx.conf` (owner bypass and guest rate limiting zone)
- `scripts/flows/run-all-flows.ts` (interactive user flows runner)
- `tests/fakes/index.ts` (FakeClock.advance method)
- `tests/integration/e2e-flows.test.ts` (automated end-to-end flows suite)
- `tests/integration/e2e-reliability.test.ts` (reliability test adjustments)
- `tests/integration/nginx-proxy.test.ts` (owner bypass vs guest rate limit test)
- `tests/unit/quota-service.test.ts` (role rate-limiting unit tests)

## Tests Executed
- `pnpm typecheck`: Exit code 0 (0 errors)
- `pnpm lint`: Exit code 0 (0 warnings, 0 errors)
- `pnpm test`: 19 passed / 19 passed (129 tests passed in 25.81s)

## Current Blockers
- None.
