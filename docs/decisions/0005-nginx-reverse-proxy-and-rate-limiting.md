# ADR 0005: Nginx Reverse Proxy and Network-Level Protection

## Status
Accepted

## Context
In Milestone 5, we introduce Nginx as the local reverse proxy (`127.0.0.1:8080`) protecting the Fastify Gateway (`127.0.0.1:8765`).
Objectives:
- Enforce strict route and HTTP method allowlists before traffic touches Node.js.
- Enforce network-level request rate limiting (6 req/min with burst 3) using `$binary_remote_addr`.
- Enforce client request body size limit (12 MiB).
- Guarantee unbuffered streaming for Server-Sent Events (SSE) so tokens reach clients with minimum latency.
- Return structured OpenAI-compatible JSON error responses for network rejections (404, 405, 413, 429, 502).

## Decision

1. **Loopback Binding**:
   - Nginx strictly binds to `127.0.0.1:8080`, ensuring zero external exposure without the outbound Cloudflare Tunnel.
2. **Strict Route & Method Allowlist**:
   - Location `= /v1/chat/completions`: rejects non-POST requests with HTTP 405.
   - Location `= /health`: rejects non-GET requests with HTTP 405.
   - Location `/`: catch-all returning HTTP 404 for any other path.
3. **Leaky Bucket Rate Limiting**:
   - `limit_req_zone $binary_remote_addr zone=api_limit:10m rate=6r/m;`
   - `limit_req zone=api_limit burst=3 nodelay;` with `limit_req_status 429;`
   - Bursts up to 3 requests are serviced immediately without delay; further rapid requests receive immediate 429.
4. **Streaming & Buffering Controls**:
   - `proxy_buffering off;` and `proxy_cache off;` ensure streaming tokens are flushed immediately to clients without Nginx intermediary buffering.
   - Upstream connection keepalive (`keepalive 8;`, `Connection ""`, `proxy_http_version 1.1;`).
   - Extended read/send timeouts (`300s`) accommodate long reasoning generation cycles.
5. **Standardized Error Formatting**:
   - Custom `error_page` directives map 404, 405, 413, 429, and 502/503/504 to JSON error payloads adhering to OpenAI error conventions.

## Consequences
- Fastify Gateway is protected against burst traffic and malformed paths before Node.js event loop resources are spent.
- SSE chunks arrive progressively with low TTFT.

