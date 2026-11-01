# EdgeInference Architecture

## 1. System Overview

EdgeInference is a secure, self-hosted multimodal LLM inference service designed to run on Apple Silicon hardware (Apple M1 Max, 64GB unified memory, macOS). It provides a private, authenticated, rate-limited, and OpenAI-compatible API for text generation, reasoning, and image understanding workloads while coexisting with normal workstation tasks.

## 2. External Topology & Boundaries

```text
                       Client Application Backend
                                   |
                                   | HTTPS
                                   | CF-Access-Client-Id / CF-Access-Client-Secret
                                   | Authorization: Bearer <LLM_API_SECRET>
                                   v
                      +--------------------------+
                      |    Cloudflare Access     |
                      | (Edge Service Auth Gate) |
                      +--------------------------+
                                   |
                                   v
                      +--------------------------+
                      |    Cloudflare Tunnel     |
                      |   (cloudflared ingress)  |
                      |  (Access JWT Validation) |
                      +--------------------------+
                                   |
                                   v
 +-----------------------------------------------------------------------+
 | macOS Host (Apple M1 Max 64GB)                                         |
 |                                                                       |
 |    +-------------------------------------------------------------+    |
 |    | Nginx Reverse Proxy (127.0.0.1:8080)                        |    |
 |    | - Route allowlist (POST /v1/chat/completions only)          |    |
 |    | - Request rate limiting (6 req/min, burst 3)                |    |
 |    | - Client body size limit (12 MiB)                           |    |
 |    | - Disabled proxy buffering for streaming                    |    |
 |    +-------------------------------------------------------------+    |
 |                                   |                                   |
 |                                   v                                   |
 |    +-------------------------------------------------------------+    |
 |    | Fastify Inference Gateway (127.0.0.1:8765)                  |    |
 |    | 1. Timing-safe Bearer API secret authentication (onRequest) |    |
 |    | 2. Strict Zod schema & allowlist validation                 |    |
 |    | 3. Sharp image sanitization (decompression bomb protection) |    |
 |    | 4. SQLite atomic daily quota accounting (better-sqlite3)    |    |
 |    | 5. Process-local semaphore (1 active slot, 2 queue capacity)|    |
 |    | 6. Upstream Ollama invocation & chunked SSE streaming       |    |
 |    | 7. Guaranteed resource reclamation on disconnect or error   |    |
 |    +-------------------------------------------------------------+    |
 |                                   |                                   |
 |                                   v                                   |
 |    +-------------------------------------------------------------+    |
 |    | Ollama Engine (127.0.0.1:11434)                             |    |
 |    | - Model: qwen3.8:27b (Q4 quantized)                         |    |
 |    | - Apple Metal GPU accelerated execution                     |    |
 |    | - Loopback only (never bound to 0.0.0.0)                    |    |
 |    +-------------------------------------------------------------+    |
 +-----------------------------------------------------------------------+
```

## 3. Network & Port Allocation

| Component | Bind Address | Port | Access Scope |
|---|---|---|---|
| Nginx Reverse Proxy | `127.0.0.1` | `8080` | Localhost only (target of cloudflared) |
| Fastify Gateway | `127.0.0.1` | `8765` | Localhost only (upstream of Nginx) |
| Ollama Service | `127.0.0.1` | `11434` | Localhost only (upstream of Fastify Gateway) |

No services bind to `0.0.0.0` or open router ports. Remote access is mediated solely via an outbound Cloudflare Tunnel.

## 4. Internal Layered Architecture

The Fastify Gateway uses clean architectural layering with manual constructor dependency injection:

```text
HTTP / Presentation Layer
   - ChatCompletionController
   - Authentication Hook (BearerTokenAuthenticator)
   - Route Schemas & Serializers
        |
        v
Application Layer
   - InferenceService (Orchestrator)
   - QuotaService (Atomic quota checks & reservation)
   - AdmissionService (Semaphore & waiting queue)
        |
        v
Domain Contracts (Interfaces)
   - InferenceClient
   - ApiKeyAuthenticator
   - QuotaRepository
   - AdmissionController
   - ImageProcessor
   - Clock
   - MetricsRecorder
        ^
        |
Infrastructure Implementations
   - OllamaInferenceClient
   - BearerTokenAuthenticator (crypto.timingSafeEqual)
   - SqliteQuotaRepository (better-sqlite3 with WAL mode)
   - SemaphoreAdmissionController (in-memory async semaphore)
   - SharpImageProcessor (sharp)
   - SystemClock
   - StructuredMetricsRecorder
```

### Dependency Inversion Rule
Domain and Application layers depend exclusively on interfaces. No business logic directly imports Fastify, SQLite, Sharp, or Ollama clients.

## 5. Request Lifecycle & Resource Accounting

1. **Ingress Authorization**: Cloudflare Access validates edge service tokens before packets reach the local machine.
2. **Tunnel & Proxy Ingress**: Cloudflare Tunnel forwards to `127.0.0.1:8080`. Nginx verifies HTTP method (`POST`), path (`/v1/chat/completions`), enforces 12 MiB body limit, and rate limits requests.
3. **Gateway Pre-Parsing Authentication**: Fastify `onRequest` hook executes `BearerTokenAuthenticator` using constant-time comparison. Unauthenticated requests are rejected with HTTP 401 before body parsing or image decoding.
4. **Body Parsing & Schema Validation**: Fastify parses JSON; Zod validates fields, model allowlist (`qwen3.8:27b`), message sequence, and parameter bounds. Unsupported parameters are rejected.
5. **Image Normalization**: Sharp inspects image buffers, validates formats (JPEG, PNG, WebP), checks dimensions ($\le 20$ MP) and size ($\le 4$ MB), strips metadata, and normalizes pixels.
6. **Atomic Quota Reservation**: SQLite checks key quota under an atomic transaction; rejects with 429 if daily quota (100 requests) is exceeded.
7. **Admission & Queueing**: Request enters `AdmissionController`. If an active inference is underway, it queues up to queue capacity (2). If queue is full, immediate 429 is returned.
8. **Inference Execution**: `OllamaInferenceClient` dispatches to `127.0.0.1:11434` with an `AbortSignal`.
9. **Streaming / Delivery**: Tokens are written as Server-Sent Events (SSE) or aggregated for non-streaming.
10. **Resource Cleanup**: When inference completes, errors out, or client disconnects, `InferenceLease` is released immediately in a `finally` block.

