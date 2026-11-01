# ADR 0007: Reliability, Process Supervision, and Client Lifecycle Management

## Status
Accepted

## Context
A self-hosted edge inference service running on macOS Apple Silicon must maintain high reliability and operational clarity without adding heavy orchestration tools (such as Kubernetes or Docker containers). The system must handle:
1. Automated background startup and crash recovery across host reboots.
2. Accurate detection of client disconnections/aborts so scarce Metal GPU inference slots and daily quota are immediately reclaimed.
3. Rapid recovery from upstream Ollama outages without requiring gateway process restarts.
4. Clean integration with standard LLM clients (e.g. the official OpenAI SDK).

## Decisions

### 1. Process Supervision via macOS Native `launchd`
- We use macOS user LaunchAgents (`~/Library/LaunchAgents/`) to manage the Fastify inference gateway (`com.edgeinference.gateway`) and Nginx reverse proxy (`com.edgeinference.nginx`).
- `KeepAlive: true` and `ThrottleInterval: 10` ensure processes restart automatically on crash without CPU-churning tight loops.
- Standard Out/Error streams are redirected to dedicated rotating log files in `data/logs/`.

### 2. Accurate Client Cancellation Detection
- In Node.js HTTP servers, the incoming request readable stream (`req.raw`) emits `close` and sets `req.raw.destroyed = true` immediately after reading the full POST body.
- Relying on `req.raw.on("close")` causes false positive aborts on valid completed bodies.
- Instead, client premature disconnection is monitored on the response writable stream: `reply.raw.on("close", () => { if (!reply.raw.writableEnded) abortController.abort(); })`.
- When an abort triggers:
  1. The inference lease is released immediately, freeing the active slot or dequeuing the request.
  2. The daily quota consumed during the speculative reservation is atomically rolled back via `quotaService.rollback()`.
  3. Upstream Ollama streams or HTTP calls abort via propagated `AbortSignal`.

### 3. Graceful Upstream Resilience
- If the upstream Ollama daemon is temporarily unreachable or crashes, the gateway catches the network fault and converts it to a standard `502 Bad Gateway` (`upstream_service_error`).
- When the Ollama daemon returns to service, subsequent incoming requests succeed immediately without requiring a restart or cache purge of the Fastify gateway.

### 4. Application Health & Readiness Protocol
- A lightweight readiness probe script (`scripts/verify/health-check.ts`) validates the three core pipeline stages (Ollama tags API, Fastify `/health`, and Nginx `/health`).
- The health endpoints bypass edge and bearer authentication, returning `200 OK` with JSON `{ "status": "healthy" }`.

## Consequences

- Zero third-party process managers (e.g. PM2, Docker) required; leverages macOS native subsystems.
- Client cancellations do not exhaust users' daily quotas or strand GPU compute slots.
- Integration tests confirm full compatibility with the official OpenAI SDK for text, multimodal vision, reasoning, streaming, and error states.

