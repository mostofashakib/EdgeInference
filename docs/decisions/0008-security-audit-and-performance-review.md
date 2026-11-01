# ADR 0008: Security Audit, Threat Verification, and Performance Bounds

## Status
Accepted

## Context
Production deployment of a self-hosted multimodal LLM service on a local workstation requires absolute verification of two core dimensions:
1. **Security & Isolation**: Ensuring that exposing the model endpoint over Cloudflare Tunnel cannot lead to local system compromise, denial of service, resource starvation, data tampering, or unauthorized model querying.
2. **Performance & Resource Bounds**: Ensuring that the security, validation, proxying, and persistence layers do not introduce measurable latency degradation on top of the underlying Metal GPU inference engine, and that hardware memory consumption remains strictly bounded.

## Decisions

### 1. Dual-Gate Authentication Boundary
- External requests must traverse two independent gates:
  - Gate 1 (Edge): Cloudflare Access validates client ID and secret before passing traffic through the outbound tunnel.
  - Gate 2 (Application): Fastify `onRequest` hook validates the Bearer API secret using SHA-256 fixed-length timing-safe comparison (`crypto.timingSafeEqual`).
- Neither gate can bypass or substitute the other.

### 2. Multi-Vector Threat Mitigations
- **SSRF Prevention**: All remote URLs (`http://`, `https://`) in `image_url` fields are rejected with HTTP 400. Images must be passed exclusively as Base64 data URLs.
- **Decompression Bomb Protection**: Sharp checks image pixel dimensions before full decode; images exceeding 20 megapixels are rejected immediately.
- **Magic Bytes Validation**: File header signatures are inspected directly; files with spoofed extensions or corrupted headers are rejected with HTTP 400.
- **Model Isolation**: Model names are checked against a strict in-memory allowlist (`qwen3.8:27b`); path traversal strings or alternate models return HTTP 404.
- **Port Isolation**: Ports 8080 (Nginx), 8765 (Fastify), and 11434 (Ollama) bind strictly to `127.0.0.1`.

### 3. Performance Budgets & Empirical Overhead
- Fastify Gateway processing overhead is bounded to **under 25 ms** per request.
- Nginx reverse proxy overhead is bounded to **under 40 ms** on non-streaming requests.
- Server-Sent Events (SSE) streaming operates in unbuffered mode (`proxy_buffering off; chunked_transfer_encoding on;`), ensuring TTFT latency of ~130 ms is preserved from Ollama to the client.

## Consequences
- Comprehensive security test suite (`tests/integration/security-audit.test.ts`) verifies 100% adherence to the threat model.
- Production dependencies are verified via `pnpm audit --prod` with zero known vulnerabilities.
- MacBook Pro M1 Max maintains stable performance with 100% Metal GPU offload (~20.09 GB unified memory) and zero idle CPU usage.

