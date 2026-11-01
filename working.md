# Working State

## Project
Secure Local LLM Inference Service

## Current Milestone
M2 — API Skeleton, Dependency Injection, and Authentication (COMPLETED) -> Transitioning to M3 (Request Validation and Inference Gateway)

## Milestone Status
M2_COMPLETED

## Overall Progress
- [x] M0: Environment and foundation
- [x] M1: Local model inference
- [x] M2: API skeleton, DI, and authentication
- [ ] M3: Request validation and inference gateway
- [ ] M4: Resource management and streaming
- [ ] M5: Nginx and rate limiting
- [ ] M6: Cloudflare and external access
- [ ] M7: Reliability and end-to-end testing
- [ ] M8: Performance and security review

## Current Tasks (M2 Completed, M3 Active)
- [x] M2: Define domain interfaces (`InferenceClient`, `ApiKeyAuthenticator`, `QuotaRepository`, `AdmissionController`, `ImageProcessor`, `Clock`, `MetricsRecorder`).
- [x] M2: Implement domain models and structured error hierarchy (`DomainError`, `UnauthorizedError`, `InvalidRequestError`, etc.).
- [x] M2: Implement `BearerTokenAuthenticator` using timing-safe fixed-length SHA-256 comparison (`timingSafeEqualString`).
- [x] M2: Implement Fastify application factory (`createApp`) with `onRequest` authentication hook, route skeleton, and log redaction.
- [x] M2: Implement fake infrastructure dependencies in `tests/fakes/` for testing DI without external dependencies.
- [x] M2: Implement composition root (`createDependencies`) supporting clean dependency injection and overrides.
- [x] M2: Write comprehensive tests in `tests/unit/authenticator.test.ts` and `tests/integration/api-skeleton.test.ts` (24 new tests, 39 total).
- [ ] M3: Implement Sharp image validation and normalization in `gateway/src/infrastructure/images/SharpImageProcessor.ts`.
- [ ] M3: Enforce image security bounds ($\le 2$ images, $\le 20$ MP, $\le 4$ MB decoded, valid JPEG/PNG/WebP magic bytes, decompression bomb protection).
- [ ] M3: Implement real `OllamaInferenceClient` in `gateway/src/infrastructure/ollama/OllamaInferenceClient.ts`.
- [ ] M3: Map OpenAI-compatible messages to Ollama native formats with base64 images.
- [ ] M3: Integrate real Ollama client into the gateway composition root.
- [ ] M3: Write comprehensive M3 unit and integration tests (failing tests first).
- [ ] M3: Verify M3 gate criteria.

## Completed Work
- **M0**: Environment audit, tooling, repository foundation, baseline tests committed (`42cc6b4`).
- **M1**: Model `qwen3.8:27b` downloaded; 100% Metal GPU acceleration verified; text, reasoning, image, and streaming integration tests passed (`d01e1d9`).
- **M2**:
  - Implemented domain contracts in `gateway/src/domain/interfaces/index.ts`.
  - Implemented domain models and errors in `gateway/src/domain/models/types.ts` and `gateway/src/domain/errors/index.ts`.
  - Implemented `BearerTokenAuthenticator` with support for primary and secondary rotated secrets and constant-time equality check.
  - Implemented `QuotaService` and `InferenceService` with resource lease tracking in `finally` blocks.
  - Implemented `ChatCompletionController` and Fastify application factory `createApp(dependencies)`.
  - Configured logger redaction to prevent secret exposure.
  - Implemented comprehensive fake dependencies in `tests/fakes/`.
  - Authored ADR 0002 (`docs/decisions/0002-composition-and-authentication.md`).
  - Added 24 new unit and integration tests across 2 test files; all 39 tests passing cleanly.

## Architecture Decisions
- ADR-0001: Technology Stack and Development Environment Isolation.
- ADR-0002: Service Coexistence and Ollama Instance Management.
- ADR-0003: Ollama MLX Runner & Metal Acceleration.
- ADR-0004: Composition Root, Dependency Inversion, and Early Authentication Hook — Authentication strictly runs in `onRequest` before request body parsing, using timing-safe comparison with stable internal key IDs for rotation.

## Files Changed
- `docs/decisions/0002-composition-and-authentication.md`
- `gateway/src/app.ts`
- `gateway/src/application/InferenceService.ts`
- `gateway/src/application/QuotaService.ts`
- `gateway/src/composition/createDependencies.ts`
- `gateway/src/config/AppConfig.ts`
- `gateway/src/domain/errors/index.ts`
- `gateway/src/domain/interfaces/index.ts`
- `gateway/src/domain/models/types.ts`
- `gateway/src/http/controllers/ChatCompletionController.ts`
- `gateway/src/http/schemas/chatCompletion.ts`
- `gateway/src/infrastructure/auth/BearerTokenAuthenticator.ts`
- `gateway/src/infrastructure/observability/StructuredMetricsRecorder.ts`
- `gateway/src/infrastructure/observability/SystemClock.ts`
- `gateway/src/main.ts`
- `tests/fakes/index.ts`
- `tests/integration/api-skeleton.test.ts`
- `tests/unit/authenticator.test.ts`
- `working.md`

## Tests Written
- `tests/unit/authenticator.test.ts` (9 tests)
- `tests/integration/api-skeleton.test.ts` (15 tests)
- `tests/unit/foundation.test.ts` (9 tests)
- `tests/integration/ollama-inference.test.ts` (6 tests)
- Total: 39 tests

## Tests Executed
- Command: `pnpm typecheck` (PASS - 0 errors)
- Command: `pnpm lint` (PASS - 0 errors)
- Command: `pnpm test` (PASS - 39/39 tests across 4 test files)

## Current Blockers
- None.

## Known Bugs
- None.

## Important Context
- M2 passes completely with isolated fake dependencies.
- Next step M3 connects real `OllamaInferenceClient` and `SharpImageProcessor`.

## Next Exact Action
- Implement M3: Develop `SharpImageProcessor`, implement `OllamaInferenceClient`, map OpenAI schemas to Ollama, write failing integration tests for valid/invalid text and image requests.

## Last Verification
- All 39 tests passed in 17.73s across 4 test suites.
