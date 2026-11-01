# ADR 0001: Technology Stack and Development Environment Isolation

## Status
Accepted

## Context
We need to build a secure, self-hosted multimodal LLM inference service on an Apple Silicon M1 Max MacBook Pro running macOS. The service must support text generation, complex reasoning, and image understanding using Ollama (`qwen3.8:27b`), exposed via an OpenAI-compatible API through a Cloudflare Tunnel and an Nginx reverse proxy. The service must coexist seamlessly with everyday developer workloads on the same laptop.

Key constraints:
- Node.js runtime with Apple Silicon native compatibility.
- Minimal framework overhead: no heavy DI frameworks (NestJS, Inversify) or cloud orchestration (Kubernetes, Redis).
- Reproducible, isolated development environment without polluting global package stores.
- Strict security controls (timing-safe bearer secret, edge service auth, rate limiting).
- Zero reliance on external network ports or port forwarding.

## Decision

1. **Runtime & Package Management**:
   - Pinned Node.js 24 LTS via Homebrew keg-only installation (`/opt/homebrew/opt/node@24/bin/node`), accompanied by `.node-version`.
   - Package manager: `pnpm` (v11.24.0) with local `node_modules` isolation. Pinned lockfile `pnpm-lock.yaml` tracked in Git.
2. **HTTP Server Framework**:
   - `Fastify` v5 with TypeScript strict mode. Fastify provides high-throughput request lifecycle hooks (`onRequest`, `preHandler`), native schema validation, and low overhead compared to Express or NestJS.
3. **Validation & Image Handling**:
   - `zod` for strict request payload parsing, model allowlist enforcement, and rejection of unrecognized parameters.
   - `sharp` for high-performance libvips image inspection, format verification, metadata stripping, and decompression bomb prevention.
4. **Persistence & Accounting**:
   - `better-sqlite3` embedded SQLite for atomic daily request quota reservations and audit records. Synchronous execution in WAL mode eliminates async race conditions for quota checks.
5. **Inference Backend**:
   - Local `Ollama` instance bound strictly to `127.0.0.1:11434`. Model: `qwen3.8:27b` (Q4 quantized) utilizing Apple Metal acceleration.
6. **Reverse Proxy & Ingress**:
   - `Nginx` (127.0.0.1:8080) for method/path allowlisting, request body enforcement (12 MiB), and rate limiting (6 req/min, burst 3).
   - `Cloudflare Tunnel` (`cloudflared`) and `Cloudflare Access` for zero-port-forwarding authenticated remote connectivity.
7. **Architectural Pattern**:
   - Layered architecture with manual constructor dependency injection and a composition root (`composition/createDependencies.ts`).
   - Domain contracts (interfaces) decouple application logic from concrete infrastructure, enabling comprehensive testing with lightweight test fakes.

## Consequences
- Testing can execute completely offline and in-memory using lightweight fakes for Ollama, SQLite, and network components.
- Native modules (`better-sqlite3`, `sharp`) must compile cleanly on Apple Silicon (arm64) and link against Node 24.
- Running dual Ollama daemons (Desktop app vs Homebrew service) must be avoided to prevent port collisions on 11434.
