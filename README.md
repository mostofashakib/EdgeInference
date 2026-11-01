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
│  │   - Unbuffered SSE      │  (proxy_buffering off; chunked transfer)       │
│  +─────────────────────────+                                                │
│               │                                                             │
│               │ HTTP (127.0.0.1:8765)                                       │
│               ▼                                                             │
│  +─────────────────────────+                                                │
│  │     Fastify Gateway     │  127.0.0.1:8765                                │
│  │   - Dual-Gate Auth      │  (CF-Access-* + Bearer API secret in onRequest)│
│  │   - Strict Zod schema   │  (Unsupported parameter rejection)             │
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

## 2. Security & Credential Centralization (Zero-PII Policy)

> [!IMPORTANT]
> **This repository contains ZERO secrets, API keys, personal file paths, or PII.**  
> It is safe for public GitHub hosting. All credentials, authorization tokens, and target endpoints must reside exclusively in a local `.env` file, which is strictly excluded from version control via `.gitignore`.

### Centralized `.env` Configuration
To configure your local service and consuming applications, copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

The `.env` file centralizes all required configuration in one location:

```env
# ==============================================================================
# EdgeInference Local Environment Configuration
# All local secrets, credentials, and endpoints are centralized in this file.
# This file is strictly excluded from version control (.gitignore).
# ==============================================================================

# Server Environment & Network
NODE_ENV=development
PORT=8765
HOST=127.0.0.1

# Application Security (Private Gateway Bearer Secret)
# Cryptographically random 256-bit hex secret (e.g. openssl rand -hex 32)
# Passed in header: Authorization: Bearer <LLM_API_SECRET>
LLM_API_SECRET=your-64-character-hex-random-secret-here

# Optional: Secondary API Secret for zero-downtime rotation
# LLM_API_SECRET_PREVIOUS=

# Client Target Endpoint & Model (Used by consuming services & SDK clients)
LLM_BASE_URL=http://127.0.0.1:8080/v1
LLM_MODEL=qwen3.8:27b

# Cloudflare Access Service Token (Required only when accessing via Cloudflare Tunnel)
CF_ACCESS_ENABLED=false
CF_ACCESS_CLIENT_ID=your-service-token-client-id.access
CF_ACCESS_CLIENT_SECRET=your-service-token-client-secret

# Ollama Upstream Backend
OLLAMA_BASE_URL=http://127.0.0.1:11434
ALLOWED_MODELS=qwen3.8:27b

# Resource, Rate Limiting & Concurrency Management
DAILY_REQUEST_QUOTA=100
MAX_ACTIVE_INFERENCE=1
MAX_QUEUE_CAPACITY=2

# Multimodal & Payload Constraints
MAX_BODY_BYTES=12582912
MAX_IMAGE_BYTES=4194304
MAX_IMAGE_COUNT=2
MAX_IMAGE_MEGAPIXELS=20
MAX_PROMPT_CHARS=32000
MAX_OUTPUT_TOKENS=4096

# Local Persistence (SQLite WAL mode)
DATABASE_PATH=./data/gateway.db
```

Both the Fastify gateway and example SDK client automatically load this `.env` file on startup via Node's native `process.loadEnvFile()`.

---

## 3. Inference API Contract: Complete Input & Output Schemas

Any service consuming this endpoint (`POST /v1/chat/completions`) interacts with an OpenAI-compatible JSON or Server-Sent Events (SSE) interface.

### 3.1 Input Request Schema

#### Request Headers
```http
POST /v1/chat/completions HTTP/1.1
Host: 127.0.0.1:8080
Authorization: Bearer <LLM_API_SECRET>
Content-Type: application/json
Accept: application/json, text/event-stream
```
*Note: When accessing via an external Cloudflare Tunnel, also supply `CF-Access-Client-Id` and `CF-Access-Client-Secret`.*

#### TypeScript Request Type Definition
```typescript
interface ChatCompletionRequest {
  model: "qwen3.8:27b";
  messages: Array<{
    role: "system" | "user" | "assistant";
    content: string | Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    >;
  }>;
  stream?: boolean;       // Default: false. Set true for progressive SSE streaming.
  temperature?: number;   // Range: [0.0, 2.0]. Default: 0.7.
  max_tokens?: number;    // Range: [1, 4096]. Maximum tokens to generate.
}
```

#### Input Constraints & Validation Rules
- **Model allowlist**: Only models explicitly listed in `ALLOWED_MODELS` (default: `qwen3.8:27b`) are accepted. Any other model returns `HTTP 404 model_not_allowed`.
- **Strict schema**: Extra or unsupported parameters (e.g. `functions`, `tools`, `logit_bias`) are rejected with `HTTP 400 invalid_request`.
- **Message limit**: Maximum 50 messages per request. Total combined text prompt length cannot exceed 32,000 characters.
- **Image rules**: Maximum 2 images per request. Only Base64 data URLs (`data:image/png;base64,...`) are admitted. Remote HTTP/HTTPS URLs are rejected to prevent SSRF.
- **Image limits**: Maximum 4 MiB per image; maximum 20 megapixels; file header magic bytes must match JPEG, PNG, or WebP.

#### Request Example (Text Generation)
```json
{
  "model": "qwen3.8:27b",
  "messages": [
    { "role": "system", "content": "You are a concise engineering assistant." },
    { "role": "user", "content": "Explain what an idempotent operation is in 1 sentence." }
  ],
  "temperature": 0.2,
  "max_tokens": 128,
  "stream": false
}
```

#### Request Example (Multimodal Image Understanding)
```json
{
  "model": "qwen3.8:27b",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "Describe the shapes, colors, and text in this screenshot." },
        { "type": "image_url", "image_url": { "url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg..." } }
      ]
    }
  ]
}
```

---

### 3.2 Output Schema: Non-Streaming (`stream: false`)

When `stream` is omitted or set to `false`, the service returns `HTTP 200 OK` with `Content-Type: application/json`.

#### TypeScript Response Type Definition
```typescript
interface ChatCompletionResponse {
  id: string;                                   // Unique ID, e.g. "chatcmpl-a1b2c3d4e5f6"
  object: "chat.completion";                    // Constant object descriptor
  created: number;                              // Unix timestamp in seconds
  model: string;                                // Generating model, e.g. "qwen3.8:27b"
  choices: Array<{
    index: number;                              // Zero-based choice index (always 0)
    message: {
      role: "assistant";                        // Role of response author
      content: string;                          // Generated response text
    };
    finish_reason: "stop" | "length" | "abort"; // Termination reason
  }>;
  usage?: {
    prompt_tokens: number;                      // Evaluated input tokens
    completion_tokens: number;                  // Generated output tokens
    total_tokens: number;                       // Total tokens consumed
  };
}
```

#### Non-Streaming Response Example
```json
{
  "id": "chatcmpl-8f2e4c1a-5b3d-4e9a-8c7f-1d2e3f4a5b6c",
  "object": "chat.completion",
  "created": 1730460000,
  "model": "qwen3.8:27b",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "An idempotent operation produces the exact same result whether executed once or repeatedly."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 34,
    "completion_tokens": 18,
    "total_tokens": 52
  }
}
```

---

### 3.3 Output Schema: Progressive Streaming (`stream: true`)

When `stream: true`, the service returns `HTTP 200 OK` with `Content-Type: text/event-stream; charset=utf-8` using Server-Sent Events (SSE). Chunks are unbuffered.

#### TypeScript Chunk Type Definition
```typescript
interface ChatCompletionChunk {
  id: string;                       // Consistent completion ID across all chunks
  object: "chat.completion.chunk";  // Constant chunk descriptor
  created: number;                  // Unix timestamp in seconds
  model: string;                    // Generating model, e.g. "qwen3.8:27b"
  choices: Array<{
    index: number;                  // Zero-based choice index (0)
    delta: {
      role?: "assistant";           // Present on initial chunk
      content?: string;             // Incremental token string
    };
    finish_reason: "stop" | "length" | "abort" | null; // null during generation; 'stop' on last chunk
  }>;
}
```

#### Streaming Wire Protocol Example
Each event is prefixed with `data: ` and terminated by double newlines (`\n\n`). The stream ends with `data: [DONE]\n\n`:

```text
data: {"id":"chatcmpl-8f2e4c1a","object":"chat.completion.chunk","created":1730460000,"model":"qwen3.8:27b","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-8f2e4c1a","object":"chat.completion.chunk","created":1730460000,"model":"qwen3.8:27b","choices":[{"index":0,"delta":{"content":"An"},"finish_reason":null}]}

data: {"id":"chatcmpl-8f2e4c1a","object":"chat.completion.chunk","created":1730460000,"model":"qwen3.8:27b","choices":[{"index":0,"delta":{"content":" idempotent"},"finish_reason":null}]}

data: {"id":"chatcmpl-8f2e4c1a","object":"chat.completion.chunk","created":1730460000,"model":"qwen3.8:27b","choices":[{"index":0,"delta":{"content":" operation"},"finish_reason":null}]}

data: {"id":"chatcmpl-8f2e4c1a","object":"chat.completion.chunk","created":1730460000,"model":"qwen3.8:27b","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

---

### 3.4 Error Response Schema

All errors across reverse proxy, authentication, schema validation, rate limiting, and inference failure return standard structured JSON:

#### TypeScript Error Type Definition
```typescript
interface ErrorResponse {
  error: {
    message: string;          // Human-readable, sanitized error description
    type: string;             // "authentication_error" | "invalid_request_error" | "rate_limit_error" | "server_error"
    param: string | null;     // Offending field or parameter name (if applicable)
    code: string;             // Machine-readable error code
  };
}
```

#### Error Response Example
```json
{
  "error": {
    "message": "Inference service is at capacity. Please try again shortly.",
    "type": "rate_limit_error",
    "param": null,
    "code": "inference_busy"
  }
}
```

#### Complete Error Taxonomy Table

| HTTP Status | Error Type (`type`) | Error Code (`code`) | Trigger Condition |
| :--- | :--- | :--- | :--- |
| `400 Bad Request` | `invalid_request_error` | `invalid_request` | Malformed JSON, extra fields, remote image URLs, corrupt magic bytes, prompt $> 32\text{k}$ chars. |
| `401 Unauthorized` | `authentication_error` | `unauthorized` | Missing or invalid `Authorization: Bearer` secret, or missing/invalid Cloudflare Access service token. |
| `404 Not Found` | `invalid_request_error` | `model_not_allowed` | Requested model is not in `ALLOWED_MODELS`, or an invalid URL path was requested. |
| `405 Method Not Allowed`| `invalid_request_error` | `method_not_allowed` | Non-POST HTTP method attempted on `/v1/chat/completions`. |
| `413 Payload Too Large`| `invalid_request_error` | `payload_too_large` | Request body exceeds 12 MiB, or image exceeds 4 MiB / 20 megapixels. |
| `429 Too Many Requests`| `rate_limit_error` | `rate_limit_exceeded`| Nginx leaky-bucket limit exceeded ( $> 6\text{ req/min}$ per IP). |
| `429 Too Many Requests`| `rate_limit_error` | `inference_busy` | Concurrency admission queue full (1 active + 2 queued). Rollback ensures quota is not consumed. |
| `429 Too Many Requests`| `rate_limit_error` | `quota_exceeded` | Daily request quota (100 req/day) exhausted for this API key. Resets at 00:00:00 UTC. |
| `502 Bad Gateway` | `server_error` | `upstream_service_error`| Upstream Ollama daemon unreachable, timed out, or returned an error. |
| `500 Internal Error` | `server_error` | `internal_error` | Unexpected internal exception (stack traces and secrets sanitized). |

---

## 4. Consuming the Service: Client SDK Integration

Consuming services can use the standard OpenAI Node.js or Python SDK without custom adapters. All credentials are read automatically from your local `.env`.

### Node.js / TypeScript Example (Official OpenAI SDK)
```typescript
import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";

// 1. Automatically load .env if present
const envPath = path.resolve(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

// 2. Initialize official client using environment variables
const client = new OpenAI({
  baseURL: process.env.LLM_BASE_URL || "http://127.0.0.1:8080/v1",
  apiKey: process.env.LLM_API_SECRET
});

// 3. Text Generation
const textCompletion = await client.chat.completions.create({
  model: process.env.LLM_MODEL || "qwen3.8:27b",
  messages: [{ role: "user", content: "Explain software idempotency." }]
});
console.log(textCompletion.choices[0]?.message.content);

// 4. Progressive Streaming
const stream = await client.chat.completions.create({
  model: process.env.LLM_MODEL || "qwen3.8:27b",
  messages: [{ role: "user", content: "Count from 1 to 5." }],
  stream: true
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta.content || "");
}
```

A complete client covering 8 scenarios (text, vision, reasoning, streaming, 401 handling, 429 handling, upstream recovery, and client abort) is available in [`examples/openai-client.ts`](examples/openai-client.ts).

---

## 5. Quick Start & Running Services

### 5.1 One-Command Runner (`run.sh` & `kill.sh`)
Start or stop the entire stack with a single command (modeled after Forge):

```bash
# Start all services (clears conflicting ports, verifies Ollama, boots Gateway and Nginx with colorized logs)
./run.sh
# (or: pnpm start)

# Gracefully stop everything: press Ctrl+C in the running terminal, or run:
./kill.sh
# (or: pnpm stop)
```

### 5.2 Prerequisites
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

### 5.3 Manual Step-by-Step Execution
If you prefer running components individually:

1. **Install Dependencies & Build**:
   ```bash
   pnpm install
   pnpm build
   ```
2. **Start Nginx Reverse Proxy**:
   ```bash
   ./scripts/setup/manage-nginx.sh start
   ```
3. **Start Fastify Gateway**:
   ```bash
   pnpm tsx gateway/src/main.ts
   ```
4. **Verify Pipeline Readiness**:
   ```bash
   pnpm tsx scripts/verify/health-check.ts
   ```

---

## 6. Background Process Management (macOS launchd)

EdgeInference uses macOS `launchd` for automatic startup, crash recovery, and logging without third-party process managers:

- Gateway plist: [`infra/launchd/com.edgeinference.gateway.plist`](infra/launchd/com.edgeinference.gateway.plist)
- Nginx plist: [`infra/launchd/com.edgeinference.nginx.plist`](infra/launchd/com.edgeinference.nginx.plist)

```bash
# Install user LaunchAgents (automatically substitutes your project path)
sed "s|/path/to/EdgeInference|$(pwd)|g" infra/launchd/com.edgeinference.gateway.plist > ~/Library/LaunchAgents/com.edgeinference.gateway.plist
sed "s|/path/to/EdgeInference|$(pwd)|g" infra/launchd/com.edgeinference.nginx.plist > ~/Library/LaunchAgents/com.edgeinference.nginx.plist

# Load services into launchd
launchctl load ~/Library/LaunchAgents/com.edgeinference.gateway.plist
launchctl load ~/Library/LaunchAgents/com.edgeinference.nginx.plist
```

For full operations, backups, and disaster recovery procedures, see [docs/runbook.md](docs/runbook.md).

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

# Full test suite (115 tests across 17 suites)
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
