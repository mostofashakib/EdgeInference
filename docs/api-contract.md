# EdgeInference API Specification

## 1. Supported Endpoint

### `POST /v1/chat/completions`
OpenAI-compatible chat completions endpoint supporting text and multimodal inputs (vision), reasoning, and chunked streaming.

### Request Headers
```http
POST /v1/chat/completions HTTP/1.1
Host: 127.0.0.1:8765
Authorization: Bearer <LLM_API_SECRET>
Content-Type: application/json
Accept: application/json, text/event-stream
```

### Request Parameters (Strict Subset)
Any property not explicitly documented below is rejected with `HTTP 400 Bad Request`.

| Parameter | Type | Required | Description / Bounds |
|---|---|---|---|
| `model` | `string` | Yes | Must be in allowlist: `["qwen3.8:27b"]`. Other models rejected. |
| `messages` | `Array<ChatMessage>` | Yes | Array of 1 to 50 message objects. System/user/assistant roles. |
| `stream` | `boolean` | No | Defaults to `false`. When `true`, streams SSE chunks. |
| `temperature` | `number` | No | Float between `0.0` and `2.0`. Defaults to `0.7`. |
| `max_tokens` | `integer` | No | Positive integer $\le 4096$. |

### Message Content Types
Messages support either standard text strings or multimodal content parts:

```json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "What is shown in this diagram?" },
    {
      "type": "image_url",
      "image_url": {
        "url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg..."
      }
    }
  ]
}
```

#### Image Rules
- Maximum images per request: 2
- Allowed formats: `image/jpeg`, `image/png`, `image/webp`
- Maximum decoded size: 4 MiB per image
- Maximum dimensions: 20 megapixels
- Remote URLs (`http://`, `https://`) are strictly rejected. Only Base64 `data:` URIs are admitted.

## 2. Response Formats

### Non-Streaming Response (JSON)
```json
{
  "id": "chatcmpl-a1b2c3d4",
  "object": "chat.completion",
  "created": 1730460000,
  "model": "qwen3.8:27b",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "The ball costs 5 cents."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 35,
    "completion_tokens": 8,
    "total_tokens": 43
  }
}
```

### Streaming Response (Server-Sent Events)
```text
data: {"id":"chatcmpl-a1b2c3d4","object":"chat.completion.chunk","created":1730460000,"model":"qwen3.8:27b","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"chatcmpl-a1b2c3d4","object":"chat.completion.chunk","created":1730460000,"model":"qwen3.8:27b","choices":[{"index":0,"delta":{"content":"The"},"finish_reason":null}]}

data: [DONE]
```

## 3. Error Responses
All error responses adhere to standard structured format:

```json
{
  "error": {
    "message": "Generic human-readable error description.",
    "type": "authentication_error | invalid_request_error | rate_limit_error | server_error",
    "param": "field_name_or_null",
    "code": "unauthorized | model_not_allowed | quota_exceeded | inference_busy | invalid_image"
  }
}
```

| HTTP Status | Error Type | Cause |
|---|---|---|
| `400 Bad Request` | `invalid_request_error` | Malformed JSON, unrecognized parameter, invalid image format or dimensions, prompt exceeds 32k chars. |
| `401 Unauthorized` | `authentication_error` | Missing, malformed, or invalid `Authorization: Bearer` token. |
| `404 Not Found` | `invalid_request_error` | Requested model is not available or path is not allowed. |
| `413 Payload Too Large` | `invalid_request_error` | Request body exceeds 12 MiB. |
| `429 Too Many Requests` | `rate_limit_error` | Daily quota exceeded (100 req/day) or concurrent inference queue full (1 active + 2 queued). |
| `500 Internal Error` | `server_error` | Upstream Ollama failure or unexpected internal exception. |

