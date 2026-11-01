# EdgeInference API Specification

## 1. Supported Endpoint

### `POST /v1/chat/completions`
OpenAI-compatible chat completions endpoint supporting text and multimodal inputs (vision), complex reasoning, and unbuffered chunked Server-Sent Events (SSE) streaming.

### Request Headers
```http
POST /v1/chat/completions HTTP/1.1
Host: 127.0.0.1:8080
Authorization: Bearer <LLM_API_SECRET>
Content-Type: application/json
Accept: application/json, text/event-stream
```
*Note: When accessing through Cloudflare Tunnel with Access enabled, clients must also pass `CF-Access-Client-Id` and `CF-Access-Client-Secret`.*

---

## 2. Input Request Schema

Requests must strictly conform to the following schema. Any property not explicitly documented below is rejected with `HTTP 400 Bad Request` (`invalid_request`).

### TypeScript Interface
```typescript
export interface ChatCompletionRequest {
  model: "qwen3.8:27b";
  messages: Array<ChatMessage>;
  stream?: boolean;       // Default: false
  temperature?: number;   // Range: [0.0, 2.0], Default: 0.7
  max_tokens?: number;    // Range: [1, 4096]
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | Array<ChatMessageContentPart>;
}

export type ChatMessageContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };
```

### Request Parameter Specifications

| Parameter | Type | Required | Default | Bounds & Validation Rules |
| :--- | :--- | :--- | :--- | :--- |
| `model` | `string` | **Yes** | N/A | Must be in `ALLOWED_MODELS` allowlist (`qwen3.8:27b`). Non-allowlisted models return `404 model_not_allowed`. |
| `messages` | `Array<ChatMessage>` | **Yes** | N/A | Minimum 1, maximum 50 messages. Total text characters across all messages cannot exceed 32,000. |
| `stream` | `boolean` | No | `false` | When `true`, the response is streamed via Server-Sent Events (`text/event-stream`). |
| `temperature` | `number` | No | `0.7` | Float between `0.0` (deterministic) and `2.0` (creative). |
| `max_tokens` | `integer` | No | `4096` | Positive integer up to 4096 tokens. |

### Multimodal Image Rules
- **Maximum Images**: Up to 2 images per request.
- **Allowed Formats**: `image/jpeg`, `image/png`, `image/webp`. Verified via file header magic bytes.
- **Size Limits**: Maximum 4 MiB per image; maximum decoded resolution of 20 megapixels.
- **Transport**: Base64 data URLs only (`data:<mime>;base64,<encoded>`). Remote URLs (`http://`, `https://`) are strictly rejected with `HTTP 400` to prevent SSRF.
- **Sanitization**: EXIF metadata and GPS tags are stripped before reaching the inference engine.

---

## 3. Output Response Schemas

### 3.1 Non-Streaming Output Schema (`stream: false`)

HTTP Status: `200 OK`  
Content-Type: `application/json`

#### TypeScript Interface
```typescript
export interface ChatCompletionResponse {
  id: string;                                   // e.g. "chatcmpl-a1b2c3d4e5f6"
  object: "chat.completion";
  created: number;                              // Unix timestamp in seconds
  model: string;                                // e.g. "qwen3.8:27b"
  choices: Array<{
    index: number;                              // Always 0
    message: {
      role: "assistant";
      content: string;                          // Generated completion text
    };
    finish_reason: "stop" | "length" | "abort";
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}
```

#### JSON Response Example
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

### 3.2 Streaming Output Schema (`stream: true`)

HTTP Status: `200 OK`  
Content-Type: `text/event-stream; charset=utf-8`  
Cache-Control: `no-cache, no-transform`  
X-Accel-Buffering: `no`

#### TypeScript Chunk Interface
```typescript
export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: "assistant";
      content?: string;
    };
    finish_reason: "stop" | "length" | "abort" | null;
  }>;
}
```

#### SSE Stream Wire Format
```text
data: {"id":"chatcmpl-8f2e4c1a","object":"chat.completion.chunk","created":1730460000,"model":"qwen3.8:27b","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-8f2e4c1a","object":"chat.completion.chunk","created":1730460000,"model":"qwen3.8:27b","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-8f2e4c1a","object":"chat.completion.chunk","created":1730460000,"model":"qwen3.8:27b","choices":[{"index":0,"delta":{"content":" world!"},"finish_reason":null}]}

data: {"id":"chatcmpl-8f2e4c1a","object":"chat.completion.chunk","created":1730460000,"model":"qwen3.8:27b","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

---

## 4. Error Response Schema

All errors adhere to OpenAI structured error representation:

```json
{
  "error": {
    "message": "Human-readable sanitized error description.",
    "type": "authentication_error | invalid_request_error | rate_limit_error | server_error",
    "param": "field_name_or_null",
    "code": "machine_readable_code"
  }
}
```

### Complete Error Taxonomy

| HTTP Status | Error Type (`type`) | Error Code (`code`) | Cause |
| :--- | :--- | :--- | :--- |
| `400 Bad Request` | `invalid_request_error` | `invalid_request` | Malformed JSON, unrecognized parameter, remote image URLs, invalid magic bytes, prompt $> 32\text{k}$ characters. |
| `401 Unauthorized` | `authentication_error` | `unauthorized` | Missing, malformed, or invalid `Authorization: Bearer` secret or Cloudflare Access token. |
| `404 Not Found` | `invalid_request_error` | `model_not_allowed` | Model is not in `ALLOWED_MODELS`, or an unrecognized URL route was requested. |
| `405 Method Not Allowed` | `invalid_request_error` | `method_not_allowed` | Non-POST HTTP method requested on `/v1/chat/completions`. |
| `413 Payload Too Large` | `invalid_request_error` | `payload_too_large` | Request body exceeds 12 MiB, or image exceeds 4 MiB / 20 megapixels. |
| `429 Too Many Requests` | `rate_limit_error` | `rate_limit_exceeded` | Nginx leaky bucket rate limit exceeded ( $> 6\text{ req/min}$ per IP). |
| `429 Too Many Requests` | `rate_limit_error` | `inference_busy` | In-process concurrency queue full (1 active + 2 queued). Quota is rolled back. |
| `429 Too Many Requests` | `rate_limit_error` | `quota_exceeded` | Daily request quota (100 req/day) exhausted for this key. Resets at 00:00:00 UTC. |
| `502 Bad Gateway` | `server_error` | `upstream_service_error` | Upstream Ollama daemon unreachable, timed out, or returned an error. |
| `500 Internal Error` | `server_error` | `internal_error` | Unexpected internal server error (sanitized, zero secret leakage). |
