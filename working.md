# Working State

## Project
Secure Local LLM Inference Service

## Current Milestone
M1 — Local Model Inference (COMPLETED) -> Transitioning to M2 (API Skeleton, DI, and Authentication)

## Milestone Status
M1_COMPLETED

## Overall Progress
- [x] M0: Environment and foundation
- [x] M1: Local model inference
- [ ] M2: API skeleton, DI, and authentication
- [ ] M3: Request validation and inference gateway
- [ ] M4: Resource management and streaming
- [ ] M5: Nginx and rate limiting
- [ ] M6: Cloudflare and external access
- [ ] M7: Reliability and end-to-end testing
- [ ] M8: Performance and security review

## Current Tasks (M1 Completed, M2 Active)
- [x] M1: Audit Ollama runtime: server v0.40.13 running via `/Applications/Ollama.app` on `127.0.0.1:11434`.
- [x] M1: Download `qwen3.8:27b` (18 GB nvfp4 quantized, digest `47951e4a6661`).
- [x] M1: Create test image fixtures for multimodal testing (`shapes.png`, `shapes.jpg`, `corrupt.png`).
- [x] M1: Create M1 integration test suite in `tests/integration/ollama-inference.test.ts`.
- [x] M1: Create M1 verification script in `scripts/verify/verify-m1-inference.ts`.
- [x] M1: Verify text generation, vision, reasoning, streaming, invalid model handling, and 100% GPU Apple Metal acceleration.
- [x] M1: Benchmark cold/warm latency and update `docs/benchmarks.md`.
- [ ] M2: Define domain interfaces (`InferenceClient`, `ApiKeyAuthenticator`, `QuotaRepository`, `AdmissionController`, `ImageProcessor`, `Clock`, `MetricsRecorder`).
- [ ] M2: Implement domain errors and models.
- [ ] M2: Implement `BearerTokenAuthenticator` with constant-time comparison (`timingSafeEqualString`).
- [ ] M2: Implement Fastify route skeleton and `onRequest` authentication hook.
- [ ] M2: Implement fake infrastructure dependencies (`FakeInferenceClient`, etc.) for tests.
- [ ] M2: Implement composition root (`createDependencies.ts` and `createApp(dependencies)`).
- [ ] M2: Write comprehensive unit/integration tests for authentication, DI swapping, and route skeleton.
- [ ] M2: Verify M2 gate criteria.

## Completed Work
- **M0**: Environment audit, tooling, repository foundation, baseline tests committed (`42cc6b4`).
- **M1**:
  - Downloaded `qwen3.8:27b` (ID: `47951e4a6661`, 18 GB, Q4/nvfp4, 27.8B parameters).
  - Validated 100% GPU execution via Apple MLX runner with 20.09 GB allocated in VRAM.
  - Verified cold start latency (18,665 ms), warm start latency (5,175 ms), TTFT (1,816 ms).
  - Verified complex reasoning: correctly solved bat-and-ball problem (`$0.05`).
  - Verified vision analysis: correctly described shapes, colors, relative positions, and text from `shapes.png`.
  - Verified SSE streaming with progressive token delivery.
  - Verified invalid model request mapping (HTTP 404).
  - All 15 unit and integration tests passing in Vitest.

## Architecture Decisions
- ADR-0001: Technology Stack and Development Environment Isolation.
- ADR-0002: Service Coexistence and Ollama Instance Management.
- ADR-0003: Ollama MLX Runner & Metal Acceleration — Verified that Ollama utilizes Apple MLX framework on M1 Max for `qwen3.8:27b`, allocating 100% of layers directly into GPU VRAM.

## Files Changed
- `docs/api-contract.md`
- `docs/benchmarks.md`
- `scripts/setup/create-fixtures.ts`
- `scripts/verify/verify-m1-inference.ts`
- `tests/fixtures/images/corrupt.png`
- `tests/fixtures/images/shapes.jpg`
- `tests/fixtures/images/shapes.png`
- `tests/integration/ollama-inference.test.ts`
- `working.md`

## Tests Written
- `tests/unit/foundation.test.ts` (9 tests)
- `tests/integration/ollama-inference.test.ts` (6 tests):
  - `generates coherent text response`
  - `correctly answers a known-answer reasoning problem`
  - `describes visual elements from an uploaded image`
  - `streams output chunks progressively using SSE`
  - `fails safely when requesting an unsupported/non-existent model`
  - `verifies model is accelerated with GPU/Metal`

## Tests Executed
- Command: `pnpm tsx scripts/verify/verify-m1-inference.ts` (PASS - All 7 checks verified)
- Command: `pnpm test` (PASS - 15/15 tests across 2 files in 20.63s)
- Command: `pnpm typecheck` (PASS - 0 errors)
- Command: `pnpm lint` (PASS - 0 errors)

## Current Blockers
- None.

## Known Bugs
- None.

## Important Context
- Ollama is running `qwen3.8:27b` using MLX runner on 100% GPU with 20.09 GB VRAM.
- In M2, we build the application skeleton and authentication using injected fake dependencies; real Ollama is not required for M2 tests.

## Next Exact Action
- Implement M2: Define domain interfaces and models in `gateway/src/domain/`, implement `BearerTokenAuthenticator`, implement Fastify app with DI in `gateway/src/app.ts`, and write failing tests first (TDD).

## Last Verification
- Ran full test suite (`pnpm test`), typecheck (`pnpm typecheck`), and lint (`pnpm lint`) — all 15 tests passed.
