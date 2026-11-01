# Working State

## Project
Secure Local LLM Inference Service

## Current Milestone
M0 — Environment and Project Foundation

## Milestone Status
COMPLETED

## Overall Progress
- [x] M0: Environment and foundation
- [ ] M1: Local model inference
- [ ] M2: API skeleton, DI, and authentication
- [ ] M3: Request validation and inference gateway
- [ ] M4: Resource management and streaming
- [ ] M5: Nginx and rate limiting
- [ ] M6: Cloudflare and external access
- [ ] M7: Reliability and end-to-end testing
- [ ] M8: Performance and security review

## Current Tasks
- [x] Inspect macOS, Apple Silicon architecture, disk space, and memory.
- [x] Identify existing listeners on proposed ports (8080, 8765, 11434) and service conflicts.
- [x] Install missing prerequisites (Homebrew node@24, cloudflared).
- [x] Create repository foundation (.gitignore, .node-version, directory structure).
- [x] Configure pnpm workspace/project, strict TypeScript, ESLint, and Vitest.
- [x] Document initial architecture decisions (ADR) and threat model.
- [x] Create and run M0 verification tests (diagnostic port inspection script, typecheck, lint, unit test).
- [x] Verify clean installation from frozen lockfile (`pnpm install --frozen-lockfile`).
- [x] Produce M0 milestone review.

## Completed Work
- Audited system environment:
  - OS: macOS 26.5.2 (Darwin 25.5.0 arm64)
  - Hardware: Apple M1 Max with 64GB unified memory (68,719,476,736 bytes)
  - Available storage: 274 GiB free on root data volume
  - Git initialized on branch `main`
  - Homebrew: installed at `/opt/homebrew/bin/brew`
  - Nginx: installed at `/opt/homebrew/bin/nginx` (v1.29.6)
  - Cloudflared: installed at `/opt/homebrew/bin/cloudflared` (v2026.10.7)
  - Node.js 24 LTS: installed via Homebrew keg-only at `/opt/homebrew/opt/node@24/bin/node` (v24.22.2)
  - pnpm: v11.24.0 with isolated virtual store and committed lockfile
  - TypeScript: pinned to 5.8.3 for typescript-eslint compatibility
- Conflict identified & documented:
  - Port 11434 is currently held by macOS desktop app `/Applications/Ollama.app` (PID 79054). The Homebrew service `homebrew.mxcl.ollama` was in error state as a consequence. We will manage Ollama consistently through a single process.
  - Ports 8080 (Nginx) and 8765 (Gateway) are completely free.
- Native modules verified on Apple Silicon arm64:
  - `better-sqlite3` compiles and executes in-memory SQLite transactions in WAL mode.
  - `sharp` compiles and measures image buffers natively.
- Documentation created:
  - `docs/architecture.md` (External topology, port allocation, layered architecture, request lifecycle)
  - `docs/threat-model.md` (Assets, trust boundaries, threat scenarios, mitigations, residual risks)
  - `docs/decisions/0001-stack-and-isolation.md` (ADR for runtime, dependencies, and testing approach)
- Tooling and Quality Gates configured:
  - Strict `tsconfig.json` (strict flags, NodeNext module resolution)
  - Modern `eslint.config.js` with TypeScript support
  - `vitest.config.ts` for fast unit and integration tests
  - `scripts/verify/audit-environment.ts` for automated diagnostic port and system inspection
  - Unit tests in `tests/unit/foundation.test.ts` (9 tests passing)

## Architecture Decisions
- ADR-0001: Technology Stack and Development Environment Isolation — Node.js 24 LTS keg-only, pnpm package manager with approved native build scripts, strict TypeScript, better-sqlite3 with WAL mode, Sharp for image sanitization, and constructor-injected layered architecture.

## Files Changed
- `.env.example`
- `.gitignore`
- `.node-version`
- `docs/architecture.md`
- `docs/threat-model.md`
- `docs/decisions/0001-stack-and-isolation.md`
- `eslint.config.js`
- `gateway/src/domain/utils/timingSafe.ts`
- `package.json`
- `pnpm-lock.yaml`
- `pnpm-workspace.yaml`
- `scripts/verify/audit-environment.ts`
- `tests/unit/foundation.test.ts`
- `tsconfig.json`
- `vitest.config.ts`
- `working.md`

## Tests Written
- `tests/unit/foundation.test.ts`:
  - `System Environment & Hardware -> runs on Apple Silicon arm64 architecture`
  - `System Environment & Hardware -> runs on Node.js 24 LTS runtime`
  - `System Environment & Hardware -> has at least 32GB unified system memory`
  - `Native Modules Compatibility -> initializes SQLite in WAL mode and executes atomic operations`
  - `Native Modules Compatibility -> processes and measures image dimensions with sharp`
  - `Domain Utility: timingSafeEqualString -> returns true for matching strings`
  - `Domain Utility: timingSafeEqualString -> returns false for non-matching strings of equal length`
  - `Domain Utility: timingSafeEqualString -> returns false for non-matching strings of different lengths`
  - `Domain Utility: timingSafeEqualString -> returns false for non-string inputs`

## Tests Executed
- Command: `pnpm typecheck`
  - Result: 0 errors
  - Evidence: `$ tsc --noEmit` exited with code 0
- Command: `pnpm lint`
  - Result: 0 errors, 0 warnings
  - Evidence: `$ eslint .` exited with code 0
- Command: `pnpm test`
  - Result: 9 passed across 1 test file (duration 372ms)
  - Evidence: All 9 assertions verified with Vitest v5.0.5
- Command: `pnpm verify:env`
  - Result: Diagnostic Status: PASS
  - Evidence:
    - Architecture: arm64
    - Node.js Version: v24.22.2
    - Unified Memory: 64 GiB
    - Native Modules: OK
    - Port 8080: FREE
    - Port 8765: FREE
    - Port 11434: IN USE (Ollama running on 127.0.0.1)
- Command: `pnpm install --frozen-lockfile`
  - Result: Clean resolution from lockfile in 268ms

## Current Blockers
- None for M0.

## Known Bugs
- Ollama desktop app (`/Applications/Ollama.app`) is running while Homebrew Ollama service is in error state due to port 11434 collision. Handled by documenting that desktop Ollama will serve as the engine or Homebrew service should be stopped/disabled before M1.

## Important Context
- Node 24 is keg-only in Homebrew (`/opt/homebrew/opt/node@24/bin`); shell commands must prepend this directory to PATH (`export PATH="/opt/homebrew/opt/node@24/bin:$PATH"`).

## Next Exact Action
- Wait for user authorization to proceed to M1 (Local Ollama Inference with qwen3.8:27b).

## Last Verification
- Ran `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm verify:env`, and `pnpm install --frozen-lockfile` — all passed cleanly with 100% success.
