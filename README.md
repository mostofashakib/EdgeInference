# EdgeInference

> **Secure, Self-Hosted Multimodal LLM Inference Service on Apple Silicon**

EdgeInference provides an OpenAI-compatible API gateway running `qwen3.8:27b` on Apple Silicon (M1 Max, 64GB unified memory) with 100% Metal GPU acceleration. It incorporates edge authorization, reverse-proxy rate limiting, atomic SQLite daily quotas, in-process concurrency management, Sharp-based multimodal image sanitization, and unbuffered SSE streaming.

---

## 1. System Architecture

```text
                           External Application Client
                                      │
                                      │ HTTPS (Cloudflare Access Service Token)
                                      ▼
                       +─────────────────────────────+
                       │      Cloudflare Access      │  (Edge Authentication)
                       +─────────────────────────────+
                                      │
                                      │ Encrypted Tunnel (Outbound TCP)
                                      ▼
                       +─────────────────────────────+
                       │      Cloudflare Tunnel      │  (Zero Open Inbound Ports)
                       +─────────────────────────────+
                                      │
                                      │ HTTP (127.0.0.1:8080)
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          MacBook Pro (Apple Silicon)                        │
│                                                                             │
│  +─────────────────────────+                                                │
│  │   Nginx Reverse Proxy   │  127.0.0.1:8080                                │
│  │   - Leaky-bucket limit  │  (6 req/min, burst 3 nodelay)                  │
│  │   - Route allowlisting  │  (POST /v1/chat/completions, GET /health only) │
│  │   - 12 MB body limit    │                                                │
│  │   - Unbuffered SSE      │                                                │
│  +─────────────────────────+                                                │
│               │                                                             │
│               │ HTTP (127.0.0.1:8765)                                       │
│               ▼                                                             │
│  +─────────────────────────+                                                │
│  │     Fastify Gateway     │  127.0.0.1:8765                                │
│  │   - Dual-Gate Auth      │  (CF-Access-* + Bearer API secret in onRequest)│
│  │   - Strict Zod schema   │                                                │
│  │   - Sharp sanitizer     │  (Magic bytes, 20 MP limit, metadata stripped) │
│  │   - SQLite WAL quota    │  (Atomic 100 req/day per key with rollback)    │
│  │   - Admission Semaphore │  (1 active, 2 queued, 429 on overflow)         │
│  +─────────────────────────+                                                │
│               │                                                             │
│               │ HTTP (127.0.0.1:11434)                                      │
│               ▼                                                             │
│  +─────────────────────────+                                                │
│  │      Ollama Engine      │  127.0.0.1:11434                               │
│  │   - Model: qwen3.8:27b  │  (27.8B parameters, nvfp4 quantized)           │
│  │   - Apple MLX Runner    │  (100% Metal GPU offload, ~20.09 GB VRAM)      │
│  +─────────────────────────+                                                │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Key Capabilities & Security Controls

| Category | Implementation | Security / Performance Guarantee |
| :--- | :--- | :--- |
| **Edge Authorization** | Cloudflare Access + Service Tokens | Blocks unauthorized public requests before reaching the host. |
| **App Authentication** | Timing-safe Bearer API Secret | Fixed-length SHA-256 + `crypto.timingSafeEqual` in Fastify `onRequest` hook. |
| **Reverse Proxy** | Nginx (`127.0.0.1:8080`) | 6 req/min rate limit (burst 3 nodelay), 12 MB max body, route & method allowlists. |
| **Image Sanitization** | Sharp Image Processor | Rejects images $> 20$ MP, $> 4$ MB, remote URLs (SSRF guard), and strips EXIF. |
| **Atomic Quota** | SQLite in WAL Mode | 100 requests/day persistent quota with rollback on queue rejection or abort. |
| **Concurrency Control** | In-Process Async Semaphore | 1 active inference slot, 2 bounded queue slots. Rejects excess with HTTP 429. |
| **Streaming Output** | Server-Sent Events (SSE) | Unbuffered chunk delivery (`proxy_buffering off; chunked_transfer_encoding on`). |
| **Inference Engine** | Ollama v0.40.13 (MLX Metal) | 100% Metal GPU execution, 20.09 GB VRAM footprint, zero CPU fallback. |

---

## 3. Technology Stack

- **Runtime**: Node.js 24 LTS (`/opt/homebrew/opt/node@24/bin/node` v24.22.2)
- **Package Manager**: pnpm pinned at v11.24.0
- **Language**: TypeScript strict mode (`ES2022`, `NodeNext`)
- **HTTP Gateway**: Fastify v5 with Zod validation
- **Image Processing**: sharp v0.35 (native libvips)
- **Persistence**: better-sqlite3 v13 with WAL mode and atomic immediate transactions
- **Reverse Proxy**: Nginx v1.29
- **Remote Ingress**: Cloudflare Tunnel (`cloudflared`) + Cloudflare Access
- **Testing**: Vitest with unit, integration, and live verification suites

---

## 4. Quick Start

### 4.1 Prerequisites
- Apple Silicon Mac with $\ge 32\text{ GB}$ unified memory (64 GB recommended).
- Ollama installed and running with `qwen3.8:27b`:
  ```bash
  ollama pull qwen3.8:27b
  ```
- Node.js 24 LTS and Nginx installed via Homebrew:
  ```bash
  brew install node@24 nginx cloudflared
  export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
  ```

### 4.2 Installation & Build
```bash
# Install dependencies
pnpm install

# Verify environment readiness
pnpm verify:env

# Compile TypeScript
pnpm build
```

### 4.3 Configuration
Copy `.env.example` to `.env` and configure your API secrets:
```bash
cp .env.example .env
```

Ensure `.env` contains:
```env
NODE_ENV=production
PORT=8765
HOST=127.0.0.1
LLM_API_SECRET="your-64-character-hex-secret-here"
ALLOWED_MODELS="qwen3.8:27b"
DAILY_REQUEST_QUOTA=100
MAX_ACTIVE_INFERENCE=1
MAX_QUEUE_CAPACITY=2
```

### 4.4 Start Services

1. **Start Nginx Reverse Proxy**:
   ```bash
   ./scripts/setup/manage-nginx.sh start
   ```
2. **Start Fastify Gateway**:
   ```bash
   pnpm tsx gateway/src/main.ts
   ```
3. **Verify Pipeline Readiness**:
   ```bash
   pnpm tsx scripts/verify/health-check.ts
   ```

---

## 5. API Reference

The service implements an OpenAI-compatible chat completions interface at `POST /v1/chat/completions`.

### 5.1 Chat Completion Request (Non-Streaming)
```bash
curl -s http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $LLM_API_SECRET" \
  -d '{
    "model": "qwen3.8:27b",
    "messages": [
      { "role": "system", "content": "You are a concise engineering assistant." },
      { "role": "user", "content": "Explain idempotent operations in 1 sentence." }
    ],
    "temperature": 0.2
  }'
```

### 5.2 Progressive Streaming (SSE)
```bash
curl -N -s http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $LLM_API_SECRET" \
  -d '{
    "model": "qwen3.8:27b",
    "messages": [{ "role": "user", "content": "Count from 1 to 5." }],
    "stream": true
  }'
```

### 5.3 Multimodal Image Analysis
```bash
BASE64_IMG=$(base64 -i tests/fixtures/images/shapes.png | tr -d '\n')

curl -s http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $LLM_API_SECRET" \
  -d '{
    "model": "qwen3.8:27b",
    "messages": [
      {
        "role": "user",
        "content": [
          { "type": "text", "text": "Describe the shapes and colors in this image." },
          { "type": "image_url", "image_url": { "url": "data:image/png;base64,'"$BASE64_IMG"'" } }
        ]
      }
    ]
  }'
```

### 5.4 Official OpenAI SDK Client Example
EdgeInference works natively with the official `openai` Node.js / Python SDKs. See `examples/openai-client.ts`:
```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:8080/v1",
  apiKey: process.env.LLM_API_SECRET
});

const completion = await client.chat.completions.create({
  model: "qwen3.8:27b",
  messages: [{ role: "user", content: "Hello from OpenAI SDK!" }]
});
```

---

## 6. Background Process Management (macOS launchd)

EdgeInference uses macOS `launchd` for automatic startup, crash recovery, and logging without third-party process managers:

- Gateway plist: `infra/launchd/com.edgeinference.gateway.plist`
- Nginx plist: `infra/launchd/com.edgeinference.nginx.plist`

```bash
# Install and start user LaunchAgents
cp infra/launchd/*.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.edgeinference.gateway.plist
launchctl load ~/Library/LaunchAgents/com.edgeinference.nginx.plist
```

For full operations and disaster recovery procedures, see [docs/runbook.md](docs/runbook.md).

---

## 7. Performance Benchmarks

Measured on Apple M1 Max (64GB RAM):

- **Cold Start Latency**: 18,665 ms (loads 20.09 GB into VRAM and compiles Metal shaders)
- **Warm Start Text Latency**: 1,887 ms
- **Time to First Token (TTFT)**: 131 ms
- **Multimodal Vision Latency**: 2,819 ms
- **Gateway Pipeline Overhead**: $\le 25\text{ ms}$
- **Nginx Proxy Overhead**: $\le 40\text{ ms}$ (unbuffered SSE streaming)
- **VRAM Footprint**: 20.09 GB (100% Metal GPU offload via MLX runner)

For full benchmark telemetry, see [docs/benchmarks.md](docs/benchmarks.md).

---

## 8. Verification & Testing

EdgeInference maintains a comprehensive test suite across unit, integration, and security vectors:

```bash
# Typecheck
pnpm typecheck

# Linting
pnpm lint

# Full test suite (109 tests across 16 suites)
pnpm test

# Run security audit suite
pnpm vitest run tests/integration/security-audit.test.ts

# Production dependency audit
pnpm audit --prod
```

---

## 9. Architecture Decisions & Documentation Index

- [Architecture Overview](docs/architecture.md)
- [Threat Model & Mitigations](docs/threat-model.md)
- [Operations Runbook](docs/runbook.md)
- [API Contract Specification](docs/api-contract.md)
- [Performance Benchmarks](docs/benchmarks.md)
- [Cloudflare Tunnel & Access Setup](infra/cloudflare/README.md)
- [Architecture Decision Records (ADRs)](docs/decisions/)

