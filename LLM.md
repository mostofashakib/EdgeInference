# LLM integration guide

Use this guide when connecting an application or coding agent to an EdgeInference installation. The API follows the supported subset of OpenAI Chat Completions defined in [the schemas](gateway/src/http/schemas/chatCompletion.ts).

## Deployment configuration

Read connection details from your application's environment. Do not infer a live endpoint, model, or credential from this repository.

| Variable | Required value |
| --- | --- |
| `LLM_BASE_URL` | Your API base URL, including `/v1`. |
| `LLM_MODEL` | An installed model accepted by the deployment's `ALLOWED_MODELS`. |
| `LLM_API_SECRET` | A configured owner or guest secret held by your trusted backend client. |

`http://127.0.0.1:8080/v1` is the default API base URL for a local installation. `https://inference.example.com/v1` is a placeholder for a remote deployment. Neither is a published service endpoint. Replace `your-installed-model` in payload examples with your selected model.

The gateway runs on macOS, Linux, and Windows. Ollama selects CPU, supported GPU, or mixed inference. Model memory and driver requirements apply to the Ollama host. Image requests require a vision model.

## Authentication

Compute credentials locally before sending requests:

| Method | Headers | Behavior |
| --- | --- | --- |
| HMAC-SHA256 | `X-Signature`, `X-Timestamp` | Sign `timestamp:METHOD:/request/path` using the configured secret. |
| SHA-256 digest | `Authorization: Bearer <sha256-hex>` | Use the digest as the OpenAI SDK API key. |

The gateway rejects raw application secrets with HTTP 401, including mixed-header requests that also contain valid credentials. Missing, empty, incorrect, malformed, or expired authentication also returns 401.

HMAC timestamps must be within 300 seconds of server time. A valid signature remains reusable within that window. The current implementation does not track nonces or sign the request body. SHA-256 digests remain reusable until the underlying secret is removed or rotated. Protect both forms as credentials and use HTTPS for remote traffic.

Missing, empty, or whitespace-only server-side `LLM_API_SECRET` prevents gateway startup. A whitespace-only `LLM_API_SECRET_PREVIOUS` also prevents startup. An empty previous secret disables rotation.

Owner credentials bypass application quotas. Guest credentials use configured rate and daily quotas. Do not switch to an owner credential to evade a guest limit. Keep secrets and digests out of browser bundles, prompts, source control, URLs, and logs.

Cloudflare service tokens are separate from application authentication. If the deployment enables its Access check, supply `CF-Access-Client-Id` and `CF-Access-Client-Secret` alongside the HMAC or SHA-256 credential. Obtain these through the deployment operator's approved configuration channel.

## TypeScript with the OpenAI SDK

Load the private environment before running this code. All three variables are required.

```typescript
import crypto from "node:crypto";
import OpenAI from "openai";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}

const model = requiredEnv("LLM_MODEL");
const client = new OpenAI({
  baseURL: requiredEnv("LLM_BASE_URL"),
  apiKey: crypto.createHash("sha256")
    .update(requiredEnv("LLM_API_SECRET")).digest("hex")
});

const response = await client.chat.completions.create({
  model,
  messages: [{ role: "user", content: "Explain a database transaction." }],
  max_tokens: 128
});
console.log(response.choices[0]?.message.content);

const stream = await client.chat.completions.create({
  model,
  messages: [{ role: "user", content: "Explain a database transaction." }],
  max_tokens: 128,
  stream: true
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || "");
}
```

## TypeScript with HMAC

This example signs the timestamp, method, and path. Reusable helpers are in [cryptoAuth.ts](gateway/src/client/cryptoAuth.ts).

```typescript
import crypto from "node:crypto";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}

const baseURL = requiredEnv("LLM_BASE_URL").replace(/\/+$/, "");
const target = new URL(`${baseURL}/chat/completions`);
const secret = requiredEnv("LLM_API_SECRET");
const timestamp = String(Math.floor(Date.now() / 1000));
const canonical = `${timestamp}:POST:${target.pathname}`;
const signature = crypto.createHmac("sha256", secret).update(canonical).digest("hex");

const response = await fetch(target, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Signature": signature,
    "X-Timestamp": timestamp
  },
  body: JSON.stringify({
    model: requiredEnv("LLM_MODEL"),
    messages: [{ role: "user", content: "Explain a database transaction." }],
    max_tokens: 128
  })
});
if (!response.ok) throw new Error(`Inference request failed: HTTP ${response.status}`);
console.log(await response.json());
```

## Python with the OpenAI SDK

Export your private configuration into the process environment before running this example.

```python
import hashlib
import os
from openai import OpenAI


def required_env(name: str) -> str:
    value = os.environ.get(name, "")
    if not value.strip():
        raise RuntimeError(f"{name} is required")
    return value


client = OpenAI(
    base_url=required_env("LLM_BASE_URL"),
    api_key=hashlib.sha256(required_env("LLM_API_SECRET").encode("utf-8")).hexdigest(),
)
response = client.chat.completions.create(
    model=required_env("LLM_MODEL"),
    messages=[{"role": "user", "content": "Explain a database transaction."}],
    max_tokens=128,
)
print(response.choices[0].message.content)
```

## Request contract

Send `POST /v1/chat/completions` with JSON and valid authentication. Visiting the chat URL in a browser sends GET and returns 405 through Nginx. Use `GET /health` to check service status. Status routes do not require application authentication and expose the configured model allowlist.

```json
{
  "model": "your-installed-model",
  "messages": [{ "role": "user", "content": "Explain a database transaction." }],
  "max_tokens": 128,
  "stream": false
}
```

| Field | Constraint |
| --- | --- |
| `model` | Required and present in the deployment's allowlist. |
| `messages` | 1 to 50 messages. Roles: `system`, `user`, `assistant`. |
| `messages[].content` | Nonempty text or an array of text/image parts. |
| `stream` | Optional boolean. Defaults to `false`. |
| `temperature` | Optional number between 0 and 2. Omission delegates to the backend. |
| `max_tokens` | Optional integer from 1 to 4096. Set it explicitly, since omission does not apply a gateway output cap. |

Extra request fields are rejected. The default prompt limit is 32,000 characters. Nginx and the gateway default to a 12 MiB request-body limit. JSON responses contain `choices` and optional token usage. SSE responses contain `data:` JSON chunks and end with `data: [DONE]`. Use an SSE parser that preserves partial events between network chunks, or use the SDK's streaming iterator.

For images, supply content parts in this format:

```json
{
  "type": "image_url",
  "image_url": { "url": "data:image/png;base64,<base64-image-data>" }
}
```

Replace `<base64-image-data>` with your encoded image bytes. Remote image URLs are rejected. The gateway accepts JPEG, PNG, and WebP, verifies file signatures, and strips metadata during normalization. Defaults are two images per request, 4 MiB per image, and 20 megapixels per image.

## Error handling

| Status | Meaning | Client action |
| --- | --- | --- |
| 400 | Invalid input or unsupported field. | Correct the request before retrying. |
| 401 | Missing, incorrect, malformed, raw, or expired credentials. | Check private configuration and clock synchronization. |
| 404 | Unknown route or model outside the allowlist. | Check the path and configured model. |
| 405 | Wrong HTTP method at the proxy. | Use POST for inference. |
| 413 | Request body exceeds the configured limit. | Reduce the payload. |
| 429 | Guest rate limit, daily quota, or inference queue limit. | Inspect `error.code`. Back off for rate/queue limits and wait for quota reset for daily limits. |
| 502 | Proxy or upstream service failure. | Retry with bounded exponential backoff. |
| 500 | Internal failure. | Use a bounded retry policy and report persistent failures. |

Errors contain `error.message`, `error.type`, `error.param`, and `error.code`. Do not log authentication headers when diagnosing failures.

## Deployment checks

```text
pnpm verify:env
pnpm verify:model
pnpm start
```

Use `pnpm flows` against your configured stack to exercise text, images, and streaming. Stop managed services with `pnpm stop`. See [README.md](README.md) for OS requirements, model selection, and optional tunnel setup.

Measure cold-load time, time to first token, generation speed, and memory on your deployment. Select client timeouts for that model and hardware. The gateway has no overall inference deadline, so streaming does not replace a client timeout or cancellation policy.
