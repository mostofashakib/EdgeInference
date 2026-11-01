# LLM Integration Guide for AI Coding Agents

> **Audience:** AI Coding Assistants, Autonomous Agents, and Developers integrating applications with this local inference gateway.
> **Standard:** OpenAI-Compatible Chat Completions API (`v1/chat/completions`)

---

## 1. Quick Reference & Service Topology

| Property | Value | Notes |
| :--- | :--- | :--- |
| **Local Base URL** | `http://127.0.0.1:8080/v1` | Reverse-proxied via Nginx with unbuffered SSE streaming |
| **Global Base URL** | `https://<tunnel-id>.trycloudflare.com/v1` | For access across all devices (mobile, other PCs, servers) via `./run.sh --tunnel` |
| **Direct Gateway URL** | `http://127.0.0.1:8765/v1` | Direct Fastify gateway (bypasses Nginx) |
| **Health Check** | `GET /health` | No authentication required; returns `{"status":"healthy"}` |
| **Chat Endpoint** | `POST /v1/chat/completions` | Standard OpenAI schema |
| **Primary Model** | `qwen3.8:27b` | Multimodal (Vision + Text), deep reasoning, coding |
| **Hardware Target** | Apple Silicon M1 Max (64GB unified memory) | 100% Metal GPU offload via MLX / Ollama |
| **Wire Protocol** | JSON (`application/json`) / SSE (`text/event-stream`) | UTF-8 encoded |

---

### 1.1 Global Multi-Device Access (Mobile, Other Laptops, Remote Servers)

To use this inference service from other devices (e.g., iPhone, Android, different laptops, or cloud services), start the stack with Cloudflare Tunnel enabled:

```bash
# Start with global encrypted HTTPS tunnel:
./run.sh --tunnel
# (or: pnpm start:tunnel)
```

The runner outputs your unique global HTTPS URL:
```text
  Global URL (All Devices) → https://your-tunnel-name.trycloudflare.com/v1/chat/completions
  Global Health Check      → https://your-tunnel-name.trycloudflare.com/health
```

**Configuring Apps on External Devices:**
1. Set the client `baseURL` or `ENDPOINT_URL` to `https://your-tunnel-name.trycloudflare.com/v1` (or your permanent custom domain if configured).
2. Set the client `apiKey` to `LLM_API_SECRET` (or pre-hash it using SHA-256).
3. The cryptographic authentication (HMAC-SHA256 and pre-hashed token) operates identically across local and global endpoints. Raw secrets are never transmitted.

---

## 2. Authentication: Zero-Plaintext-Secret Policy

To prevent secret leakage across log files, proxies, and network monitors, this service implements a **Zero-Plaintext-Secret** security policy.

The gateway checks credentials against `LLM_API_SECRET`. Matching this secret grants **Owner Status** (`role: "owner"`):
- **Unlimited request throughput** (exempt from Nginx rate limits).
- **Unlimited daily request quota** (exempt from SQLite daily quotas).
- **DDoS immunity** (never throttled even if guest callers flood the gateway).

### Authentication Method Comparison

| Method | Headers Sent | Replay-Safe? | Best For |
| :--- | :--- | :---: | :--- |
| **Method 1: Dynamic HMAC-SHA256 Signing** *(Recommended)* | `X-Signature: <hex>`<br>`X-Timestamp: <epoch_sec>` | **Yes** ($\pm 300\text{s}$ tolerance window) | Custom `fetch`/HTTP clients, microservices, backend apps |
| **Method 2: Pre-Hashed SHA-256 Token** | `Authorization: Bearer <sha256_hex>` | Yes (preimage resistant) | Official `openai` SDK drop-in replacement |
| **Method 3: Plaintext Bearer** *(Fallback)* | `Authorization: Bearer <raw_secret>` | No | Quick testing and CLI tools |

---

## 3. Copy-and-Paste Client Implementations

### 3.1 TypeScript / Node.js (Pattern A: Dynamic HMAC-SHA256 — Recommended)

Use this when writing backend code using native `fetch`:

```typescript
import crypto from "node:crypto";

const ENDPOINT_URL = process.env.LLM_ENDPOINT || "http://127.0.0.1:8080";
const SECRET = process.env.LLM_API_SECRET!; // Raw secret stored ONLY in application's local .env

/**
 * Creates dynamic HMAC-SHA256 headers. Raw secret is never transmitted.
 */
function createHmacHeaders(secret: string, method = "POST", path = "/v1/chat/completions") {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const canonicalPayload = `${timestamp}:${method.toUpperCase()}:${path}`;
  const signature = crypto.createHmac("sha256", secret).update(canonicalPayload).digest("hex");

  return {
    "X-Signature": signature,
    "X-Timestamp": timestamp
  };
}

// 1. Text Generation
async function generateText(prompt: string) {
  const path = "/v1/chat/completions";
  const res = await fetch(`${ENDPOINT_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...createHmacHeaders(SECRET, "POST", path)
    },
    body: JSON.stringify({
      model: "qwen3.8:27b",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
      max_tokens: 1024
    })
  });

  if (!res.ok) throw new Error(`HTTP error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

// 2. Token-by-Token Streaming
async function streamText(prompt: string, onToken: (token: string) => void) {
  const path = "/v1/chat/completions";
  const res = await fetch(`${ENDPOINT_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...createHmacHeaders(SECRET, "POST", path)
    },
    body: JSON.stringify({
      model: "qwen3.8:27b",
      messages: [{ role: "user", content: prompt }],
      stream: true
    })
  });

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split("\n");

    for (const line of lines) {
      if (line.startsWith("data: ") && !line.includes("[DONE]")) {
        try {
          const parsed = JSON.parse(line.slice(6));
          const text = parsed.choices[0]?.delta?.content || "";
          if (text) onToken(text);
        } catch {
          // ignore partial parse
        }
      }
    }
  }
}
```

---

### 3.2 TypeScript / Node.js (Pattern B: Official OpenAI SDK with Pre-Hashed Token)

Use this when your application already uses the `openai` npm package:

```typescript
import OpenAI from "openai";
import crypto from "node:crypto";

const SECRET = process.env.LLM_API_SECRET!;
// Pre-hash the secret locally so the raw secret is never sent over the wire:
const hashedApiKey = crypto.createHash("sha256").update(SECRET).digest("hex");

const client = new OpenAI({
  baseURL: process.env.LLM_BASE_URL || "http://127.0.0.1:8080/v1",
  apiKey: hashedApiKey
});

// Non-streaming completion
const response = await client.chat.completions.create({
  model: "qwen3.8:27b",
  messages: [
    { role: "system", content: "You are an expert systems engineer." },
    { role: "user", content: "Explain Raft consensus." }
  ],
  temperature: 0.2
});
console.log(response.choices[0]?.message.content);

// Progressive streaming
const stream = await client.chat.completions.create({
  model: "qwen3.8:27b",
  messages: [{ role: "user", content: "Write a haiku about GPUs." }],
  stream: true
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || "");
}
```

---

### 3.3 Python Client (HMAC-SHA256 & Official OpenAI SDK)

```python
import os
import time
import hmac
import hashlib
import requests
from openai import OpenAI

ENDPOINT = os.getenv("LLM_ENDPOINT", "http://127.0.0.1:8080")
SECRET = os.getenv("LLM_API_SECRET", "")

# -------------------------------------------------------------
# Option 1: Native requests with HMAC-SHA256 Signing
# -------------------------------------------------------------
def generate_hmac(prompt: str) -> str:
    timestamp = str(int(time.time()))
    canonical = f"{timestamp}:POST:/v1/chat/completions"
    signature = hmac.new(SECRET.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256).hexdigest()

    res = requests.post(
        f"{ENDPOINT}/v1/chat/completions",
        headers={
            "Content-Type": "application/json",
            "X-Signature": signature,
            "X-Timestamp": timestamp
        },
        json={
            "model": "qwen3.8:27b",
            "messages": [{"role": "user", "content": prompt}]
        }
    )
    res.raise_for_status()
    return res.json()["choices"][0]["message"]["content"]

# -------------------------------------------------------------
# Option 2: Official OpenAI Python SDK (with Pre-Hashed Token)
# -------------------------------------------------------------
hashed_token = hashlib.sha256(SECRET.encode("utf-8")).hexdigest()

client = OpenAI(
    base_url=f"{ENDPOINT}/v1",
    api_key=hashed_token  # Raw secret is never transmitted!
)

stream = client.chat.completions.create(
    model="qwen3.8:27b",
    messages=[{"role": "user", "content": "Explain vector embeddings in 2 sentences."}],
    stream=True
)

for chunk in stream:
    token = chunk.choices[0].delta.content or ""
    print(token, end="", flush=True)
print()
```

---

### 3.4 cURL Command

```bash
# Using Pre-Hashed Secret:
HASHED_SECRET=$(echo -n "$LLM_API_SECRET" | shasum -a 256 | awk '{print $1}')

curl -s http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $HASHED_SECRET" \
  -d '{
    "model": "qwen3.8:27b",
    "messages": [{"role": "user", "content": "Ping"}]
  }'
```

---

## 4. Multimodal Image Analysis Guide

The service supports visual question answering, OCR, chart reading, and screenshot analysis.

### Strict Rules for Images:
1. **Base64 Data URLs Only**: Remote URLs (`http://`, `https://`) are **rejected** (`400 invalid_request_error`) to prevent SSRF and external bandwidth saturation.
2. **Format**: `data:<mime-type>;base64,<encoded-data>` (e.g. `data:image/png;base64,iVBORw0KGgo...`).
3. **Allowed Formats**: `image/jpeg`, `image/png`, `image/webp`.
4. **Limits**:
   - Maximum **2 images** per request.
   - Maximum **4 MB** per raw image buffer.
   - Maximum **20 megapixels** resolution (images are automatically normalized, stripped of EXIF metadata, and clamped to 2048px bounds).

### Multimodal Request Payload Example:

```json
{
  "model": "qwen3.8:27b",
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "What components are shown in this architecture diagram?"
        },
        {
          "type": "image_url",
          "image_url": {
            "url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
          }
        }
      ]
    }
  ],
  "max_tokens": 512
}
```

---

## 5. Input Constraints & Validation Matrix

| Parameter | Type | Default | Constraint / Limit |
| :--- | :--- | :---: | :--- |
| `model` | `string` | *(Required)* | Must match allowlist: `["qwen3.8:27b"]` |
| `messages` | `array` | *(Required)* | 1 to 100 messages; total prompt length $\le 32,000$ characters |
| `messages[].role` | `string` | *(Required)* | `"system"`, `"user"`, or `"assistant"` |
| `messages[].content`| `string \| array` | *(Required)* | Text string or array of `{type:"text", text}` and `{type:"image_url", image_url}` |
| `stream` | `boolean` | `false` | When `true`, returns SSE event stream; when `false`, returns single JSON object |
| `temperature` | `number` | `0.7` | Value between `0.0` and `2.0` |
| `max_tokens` | `integer` | `4096` | Max completion tokens to generate |
| Request Body Size | HTTP Body | N/A | Maximum `12 MB` (enforced at both Nginx and Fastify) |

---

## 6. Error Codes & Agent Retry Strategy

When writing agent logic, use this matrix to decide whether to retry:

| Status | Error Code | Error Type | Cause | Agent Action |
| :---: | :--- | :--- | :--- | :--- |
| `400` | `invalid_request_error` | `invalid_request_error` | Schema failure, remote image URL, prompt $> 32\text{k}$ chars, model not in allowlist | **Do NOT retry.** Fix the payload format. |
| `401` | `unauthorized` | `authentication_error` | Missing credentials, invalid HMAC signature, timestamp skewed $> 300\text{s}$ | **Do NOT retry.** Check `LLM_API_SECRET` and clock sync. |
| `404` | `not_found` | `invalid_request_error` | Route not recognized | **Do NOT retry.** Endpoint is strictly `/v1/chat/completions`. |
| `405` | `method_not_allowed` | `invalid_request_error` | HTTP method is not `POST` | **Do NOT retry.** Use `POST`. |
| `413` | `payload_too_large` | `invalid_request_error` | Body $> 12\text{MB}$ or image $> 4\text{MB}$ | **Do NOT retry.** Compress images or shorten prompt. |
| `429` | `rate_limit_exceeded` | `rate_limit_error` | Non-owner guest exceeded 3 req/min | Wait 60 seconds or use owner secret. |
| `429` | `quota_exceeded` | `rate_limit_error` | Non-owner guest exceeded daily quota | Use owner secret (`LLM_API_SECRET`). |
| `429` | `inference_busy` | `rate_limit_error` | Concurrency admission queue full (1 active, 2 queued) | **Retry with exponential backoff** (e.g. 500ms, 1s, 2s). |
| `502` | `bad_gateway` | `server_error` | Nginx cannot reach gateway or Ollama is starting up | **Retry with exponential backoff** (Ollama cold start takes ~18s). |
| `500` | `internal_error` | `server_error` | Unhandled error in inference service | Retry once after 1 second. |

### Canonical Error Response Schema:
```json
{
  "error": {
    "message": "Description of what went wrong",
    "type": "invalid_request_error",
    "param": "messages",
    "code": "invalid_request_error"
  }
}
```

---

## 7. Performance Profiles & Latency Budgets

When designing timeouts in client applications, assume the following bounds on Apple Silicon (M1 Max):

- **Warm Text Generation**:
  - Time-To-First-Token (TTFT): **~130 ms**
  - Generation Speed: **~35 to 45 tokens/second**
  - Recommended Client Timeout: **60 seconds**
- **Multimodal Image Analysis**:
  - Image Validation & Sharp Normalization: **~15 ms**
  - Vision Encoding & Inference: **~2.8 seconds**
  - Recommended Client Timeout: **90 seconds**
- **Cold Start (First Request after Boot)**:
  - Weight Loading (20.09 GB into Unified Memory) + Metal Shader Compilation: **~18.5 seconds**
  - Recommended Timeout for First Request: **120 seconds**
- **Long-Form Reasoning**:
  - Deep chain-of-thought with 2,000+ output tokens: **~50 to 90 seconds**
  - Use `stream: true` to avoid intermediate HTTP gateway timeouts!

---

## 8. Verified Test Runner for Agents

To verify that your local environment or client application can successfully reach and interface with the inference stack, run the built-in diagnostic and user-flow suite:

```bash
# 1. Start all services (if not already running)
./run.sh

# 2. Run all interactive end-to-end flows
pnpm flows

# 3. Stop all services gracefully
./kill.sh
```

