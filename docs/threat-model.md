# EdgeInference Threat Model

## 1. System Asset Identification

1. **Host Workstation Stability & Resources**: The host is an Apple M1 Max laptop running developer workloads. Uncontrolled GPU memory usage or CPU exhaustion could hang the system or crash concurrent applications.
2. **Local Model & Inference Engine**: Ollama running locally at `127.0.0.1:11434`. Model management APIs (`/api/pull`, `/api/delete`, `/api/generate`) must never be reachable by unauthorized parties.
3. **Application API Secret**: The private Bearer token (`LLM_API_SECRET`) authorizing access to the inference gateway.
4. **Cloudflare Service Authentication Tokens**: `CF-Access-Client-Id` and `CF-Access-Client-Secret` securing the perimeter.
5. **Private Request and Image Content**: User prompts and uploaded image buffers.

## 2. Trust Boundaries & Attack Surfaces

```text
Untrusted Internet (Threat Actors)
  |
  |  [Boundary 1: Cloudflare Edge]
  v
Cloudflare Access (Requires valid Service Token)
  |
  |  [Boundary 2: Outbound Encrypted Tunnel (cloudflared)]
  v
Loopback Interface (127.0.0.1) on macOS Host
  |
  |  [Boundary 3: Nginx Reverse Proxy (Port 8080)]
  |  - Drops any path other than POST /v1/chat/completions
  |  - Drops request bodies > 12 MiB
  |  - Rate limits requests to 6 req/min (burst 3)
  v
Fastify Inference Gateway (Port 8765)
  |  [Boundary 4: Timing-Safe Application Bearer Authentication]
  |  - Evaluated in onRequest hook prior to JSON parsing or image decoding
  |  [Boundary 5: Input Validation & Image Decompression Guard]
  |  - Zod structural validation
  |  - Sharp pixel dimensions/decompression bomb checks
  |  [Boundary 6: Concurrency & Daily Quota Governor]
  |  - Atomic SQLite quota counter (100 req/day)
  |  - 1-slot semaphore, 2-slot waiting queue
  v
Ollama Backend (Port 11434)
```

## 3. Threat Scenarios & Mitigations

| Threat | Impact | Mitigation Strategy | Residual Risk |
|---|---|---|---|
| **Public Port Discovery / Port Scanning** | Direct bypass of authentication, unauthorized model access | Services strictly bind to loopback (`127.0.0.1`). No public router ports or firewall holes. External traffic enters exclusively through outbound Cloudflare Tunnel. | Host malware with local loopback access could reach Ollama if host is compromised. |
| **Missing / Forged Cloudflare Access Headers** | Bypass of edge controls to origin | Cloudflare Tunnel validates Access JWTs. Application independently enforces Bearer secret regardless of edge status. | Misconfigured tunnel ingress rules. |
| **Brute-Force API Secret Attack** | Unauthorized inference, GPU resource consumption | Cryptographically random 256-bit secret. Nginx rate limiting (6 req/min, burst 3). Constant-time comparison (`crypto.timingSafeEqual`) prevents timing side-channels. Generic 401 response. | Denial of service on rate limiter if attacker spams requests (prevented by Cloudflare Access). |
| **Denial of Service via Heavy Model Inference** | Starvation of host memory and GPU, workstation lockup | Strict concurrency limit: exactly 1 active inference slot and bounded queue of 2. Excess requests return HTTP 429 immediately. Hard timeout on inference requests. | Single long-running prompt occupies the 1 slot until timeout or cancellation. |
| **Decompression Bomb / Malicious Image Upload** | Gateway OOM, process crash | Maximum body size enforced at Nginx (12 MiB) and Fastify (12 MiB). Image decoding handled through Sharp with strict dimension checks ($\le 20$ megapixels, $\le 4$ MB decoded buffer). Non-image content rejected via header and magic byte validation. | CPU consumption during initial header parsing. |
| **Administrative Ollama API Manipulation** | Attacker deletes models, pulls unauthorized weights, lists files | Nginx and Fastify route allowlist exposes only `POST /v1/chat/completions`. Ollama port 11434 is isolated on localhost and not proxied directly. | None via external ingress. |
| **Secret Leakage in Logs / Metrics** | Compromised credentials via log collection | Authorization headers and API keys are redacted before logging. Error handlers return structured sanitized JSON without stack traces in production. Logging framework configured with explicit redaction paths. | Developer intentionally printing environment variables. |
| **Client Disconnect Resource Leak** | Zombie Ollama processes consuming GPU cycles after client aborts | AbortSignal propagated from Fastify request through to Ollama client. `InferenceLease` released in `finally` blocks upon abort or error. | Upstream Ollama version responsiveness to cancellation signals. |
| **Daily Quota Exhaustion / Cost Runaway** | Excessive inference usage draining daily allowance | Atomic daily quota tracking in SQLite (better-sqlite3). Reservations are checked before admitting request to queue. | Clock skew or tampering with system time (mitigated by system clock monotonic guarantees). |

## 4. Residual Risks & Operational Acceptances

1. **Host Compromise**: If an attacker gains local user execution on the macOS host, they can access loopback listeners directly. Host security (macOS FileVault, user permissions) is an external dependency.
2. **MacBook Sleep State**: If the host sleeps during an inference request, active network connections terminate. Handled by client retry policies and graceful tunnel reconnection on wake.

