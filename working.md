# Working State

## Project
Secure Local LLM Inference Service

## Current Milestone
M3 — Request Validation and Inference Gateway (COMPLETED) -> Transitioning to M4 (Quota, Concurrency, Cancellation, and Streaming)

## Milestone Status
M3_COMPLETED

## Overall Progress
- [x] M0: Environment and foundation
- [x] M1: Local model inference
- [x] M2: API skeleton, DI, and authentication
- [x] M3: Request validation and inference gateway
- [ ] M4: Resource management and streaming
- [ ] M5: Nginx and rate limiting
- [ ] M6: Cloudflare and external access
- [ ] M7: Reliability and end-to-end testing
- [ ] M8: Performance and security review

## Current Tasks (M3 Completed, M4 Active)
- [x] M3: Implement `SharpImageProcessor` with magic byte validation, decompression bomb guards, size limits (4 MiB, 20 MP), and metadata stripping.
- [x] M3: Implement `OllamaInferenceClient` with upstream protocol mapping, signal propagation, and zero secret leakage upstream.
- [x] M3: Enforce multimodal rules (max 2 images, data URLs only, remote URLs rejected, max 32k prompt chars).
- [x] M3: Connect live Fastify Gateway to real Ollama backend with full end-to-end tests.
- [x] M3: Authored ADR 0003 (`docs/decisions/0003-image-processing-and-ollama-gateway.md`).
- [ ] M4: Implement durable atomic SQLite quota repository (`SqliteQuotaRepository`) using `better-sqlite3` in WAL mode.
- [ ] M4: Implement in-process async semaphore admission controller (`SemaphoreAdmissionController`) with 1 active slot and 2 bounded queue slots.
- [ ] M4: Verify quota persistence and atomic accounting across process restarts.
- [ ] M4: Implement client cancellation propagation with guaranteed resource reclamation.
- [ ] M4: Verify backpressure and ordered SSE streaming under slow consumers.
- [ ] M4: Write comprehensive M4 unit and integration tests (concurrency, queue capacity overflow returning 429, daily quota exhaustion returning 429).
- [ ] M4: Verify M4 gate criteria.

## Completed Work
- **M0**: Environment audit, tooling, repository foundation, baseline tests committed (`42cc6b4`).
- **M1**: Model `qwen3.8:27b` downloaded; 100% Metal GPU acceleration verified; text, reasoning, image, and streaming integration tests passed (`d01e1d9`).
- **M2**: Application skeleton, dependency inversion, timing-safe Bearer authentication hook, fake dependencies committed (`4d481b6`).
- **M3**:
  - Implemented `SharpImageProcessor` (`gateway/src/infrastructure/images/SharpImageProcessor.ts`).
  - Implemented `OllamaInferenceClient` (`gateway/src/infrastructure/ollama/OllamaInferenceClient.ts`).
  - Integrated image sanitization and strict multimodal checks into `InferenceService`.
  - Added 21 new unit and integration tests across 3 test files (`image-processor.test.ts`, `ollama-client.test.ts`, `gateway-inference.test.ts`, `gateway-ollama-live.test.ts`).
  - Verified live text and multimodal completion with real Ollama `qwen3.8:27b`.
  - Total 60 tests passing cleanly across 8 test suites.

## Architecture Decisions
- ADR-0001: Technology Stack and Development Environment Isolation.
- ADR-0002: Service Coexistence and Ollama Instance Management.
- ADR-0003: Ollama MLX Runner & Metal Acceleration.
- ADR-0004: Composition Root, Dependency Inversion, and Early Authentication Hook.
- ADR-0005: Request Validation, Image Sanitization, and Inference Gateway — Strict schema rejection of unrecognized fields, rejection of remote image URLs, Sharp magic byte validation, decompression bomb protection (20 MP), and isolation of gateway secrets from upstream Ollama.

## Files Changed
- `docs/decisions/0003-image-processing-and-ollama-gateway.md`
- `gateway/src/application/InferenceService.ts`
- `gateway/src/composition/createDependencies.ts`
- `gateway/src/domain/interfaces/index.ts`
- `gateway/src/domain/models/types.ts`
- `gateway/src/infrastructure/images/SharpImageProcessor.ts`
- `gateway/src/infrastructure/ollama/OllamaInferenceClient.ts`
- `tests/integration/gateway-inference.test.ts`
- `tests/integration/gateway-ollama-live.test.ts`
- `tests/unit/image-processor.test.ts`
- `tests/unit/ollama-client.test.ts`
- `working.md`

## Tests Written
- `tests/unit/image-processor.test.ts` (6 tests)
- `tests/unit/ollama-client.test.ts` (5 tests)
- `tests/integration/gateway-inference.test.ts` (7 tests)
- `tests/integration/gateway-ollama-live.test.ts` (3 tests)
- Total tests in repository: 60 tests

## Tests Executed
- Command: `pnpm typecheck` (PASS - 0 errors)
- Command: `pnpm lint` (PASS - 0 errors)
- Command: `pnpm test` (PASS - 60/60 tests across 8 test files in 28.86s)

## Current Blockers
- None.

## Known Bugs
- None.

## Important Context
- Real Ollama inference is validated through the gateway.
- In M4, we implement SQLite persistence for quota and process semaphore for concurrency.

## Next Exact Action
- Implement M4: Develop `SqliteQuotaRepository` using better-sqlite3 with WAL mode, develop `SemaphoreAdmissionController`, write failing concurrency and quota tests.

## Last Verification
- All 60 tests passed across 8 test suites.
