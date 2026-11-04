# EdgeInference

EdgeInference is a self-hosted, OpenAI-compatible gateway for models served by Ollama. It runs on macOS, Linux, and Windows with CPU, supported GPU, or mixed inference.

You choose the model, inference host, and client endpoint. Hardware requirements depend on the model, quantization, context length, image inputs, and concurrent requests.

For client and coding-agent instructions, see [LLM.md](LLM.md).

## Architecture

```text
Client application
  → Optional HTTPS tunnel and Cloudflare Access policy
  → Nginx reverse proxy
  → Fastify gateway
  → Ollama backend
```

The gateway provides model allowlisting, authentication, guest quotas, inference concurrency limits, image validation, and JSON or Server-Sent Events (SSE) responses.

The addresses below are application defaults for a local installation. They do not identify a deployed service.

| Component | Default address |
| --- | --- |
| Nginx API base URL | `http://127.0.0.1:8080/v1` |
| Gateway | `http://127.0.0.1:8765` |
| Ollama | `http://127.0.0.1:11434` |

Public URL examples use the placeholder `https://inference.example.com`. Replace it with a hostname you control. Model examples use `your-installed-model`, which you must replace with an installed model name.

## Requirements

- Node.js 24 or newer and the pnpm version specified in `package.json`.
- [Ollama](https://ollama.com/download) on your inference host.
- Nginx installed and available through `PATH` or `NGINX_BIN`.
- Enough RAM and disk space for your selected model. A GPU is optional.
- `cloudflared` if you choose tunnel access.

On Windows, use native Node.js and the [Nginx Windows distribution](https://nginx.org/en/docs/windows.html). On macOS or Linux, install dependencies through your preferred package manager. GPU compatibility depends on [Ollama's supported hardware and drivers](https://docs.ollama.com/gpu).

## Configure your installation

Install dependencies:

```text
pnpm install --frozen-lockfile
```

Copy `.env.example` to `.env`. Keep `.env` private and excluded from version control. Generate a secret:

```text
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Set these values in your private configuration:

| Variable | Purpose |
| --- | --- |
| `LLM_API_SECRET` | Required gateway secret. Use the generated random value. |
| `LLM_MODEL` | Exact name of a model installed on your Ollama host. |
| `ALLOWED_MODELS` | Optional comma-separated model allowlist. Defaults to `LLM_MODEL` when configured. |
| `OLLAMA_BASE_URL` | Ollama backend URL. Defaults to the loopback address listed above. |
| `LLM_BASE_URL` | Client API base URL, including `/v1`. |
| `HOST`, `PORT` | Gateway bind address and port. Keep the gateway on loopback behind the proxy. |
| `NODE_ENV` | Set to `production` for production deployments. |
| `LLM_API_SECRET_PREVIOUS` | Optional previous owner secret during rotation. Empty disables it. |
| `LLM_GUEST_API_KEYS` | Optional comma-separated secrets for guest clients. |
| `GUEST_DAILY_QUOTA` | Daily requests per guest key. Default: 10. |
| `GUEST_RATE_LIMIT_PER_MINUTE` | Requests per minute per guest key. Default: 3. |
| `MAX_ACTIVE_INFERENCE` | Active inference slots. Default: 1. |
| `MAX_QUEUE_CAPACITY` | Waiting inference slots. Default: 2. |
| `DATABASE_PATH` | SQLite quota database path. Default: `./data/gateway.db`. |

Missing, empty, or whitespace-only `LLM_API_SECRET` values prevent startup. A whitespace-only rotation secret also prevents startup. Production requires an owner secret of at least 64 characters. Length validation does not establish randomness, so generate the secret rather than choosing a phrase.

Pull your selected model on the inference host:

```text
ollama pull <model-name>
```

Replace `<model-name>` with your selection. Set `LLM_MODEL` and any explicit `ALLOWED_MODELS` entries to the exact installed names. Image requests require a model with vision support.

## Start and stop

Use these commands in PowerShell, Command Prompt, or a macOS/Linux terminal:

```text
pnpm verify:env
pnpm verify:model
pnpm start
```

Stop with Ctrl+C in the running terminal or from another terminal:

```text
pnpm stop
```

On macOS and Linux, `./run.sh` and `./kill.sh` provide the same start and stop operations. Stop commands affect processes managed by this checkout. A separately managed Ollama server stays running.

The runner detects your OS and CPU architecture, checks the Node runtime and native modules, and locates executables through `PATH` and standard installation directories. For custom paths, set `NGINX_BIN`, `OLLAMA_BIN`, or `CLOUDFLARED_BIN`.

The runner reuses a running Ollama backend. If a configured local loopback HTTP backend refuses the connection, it starts local Ollama. It does not replace an unavailable remote backend with a local server.

Startup loads each allowed model sequentially and reports the backend's CPU, GPU, or mixed allocation when available. Model-load failures stop startup. Successful readiness does not guarantee enough memory for every later context size or concurrent workload.

For remote inference, set `OLLAMA_BASE_URL` to a protected backend address. Model memory requirements apply to that host. Restrict direct access to Ollama.

## Authenticate requests

Clients send an HMAC-SHA256 signature or the SHA-256 digest of a configured secret. Raw application secrets are rejected, including when sent alongside valid credentials.

| Method | Request headers | Replay behavior |
| --- | --- | --- |
| HMAC-SHA256 | `X-Signature`, `X-Timestamp` | Reusable while its timestamp is within 300 seconds of server time. |
| SHA-256 token | `Authorization: Bearer <sha256-hex>` or `X-Hashed-Token` | Reusable until the underlying secret is removed or rotated. |

HMAC clients sign `timestamp:METHOD:/request/path`. The current implementation has no nonce tracking and does not bind the request body. Use HTTPS for remote access and protect digests and signatures as credentials.

Missing, empty, incorrect, malformed, expired, or raw application credentials return HTTP 401 for inference requests. `/` and `/health` are status routes that do not require application authentication.

Owner credentials bypass application request quotas. Guest credentials use per-key rate and daily limits. All inference requests share the admission controller. Keep owner secrets in trusted backend applications and issue guest credentials to other clients.

### Node.js client

Load your application's private environment before running this example. Configure `LLM_BASE_URL`, `LLM_MODEL`, and `LLM_API_SECRET`. The base URL includes `/v1`.

```typescript
import crypto from "node:crypto";
import OpenAI from "openai";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}

const client = new OpenAI({
  baseURL: requiredEnv("LLM_BASE_URL"),
  apiKey: crypto.createHash("sha256")
    .update(requiredEnv("LLM_API_SECRET")).digest("hex")
});

const response = await client.chat.completions.create({
  model: requiredEnv("LLM_MODEL"),
  messages: [{ role: "user", content: "Explain an idempotent operation." }],
  max_tokens: 128
});
console.log(response.choices[0]?.message.content);
```

For HMAC, Python, and streaming examples, see [LLM.md](LLM.md). Reusable helpers are in [cryptoAuth.ts](gateway/src/client/cryptoAuth.ts).

## API contract

Send JSON with `POST /v1/chat/completions`. Set `Content-Type: application/json` and provide valid authentication.

```json
{
  "model": "your-installed-model",
  "messages": [{ "role": "user", "content": "Explain a database transaction." }],
  "max_tokens": 128,
  "stream": false
}
```

| Field | Contract |
| --- | --- |
| `model` | Required installed model in the configured allowlist. |
| `messages` | Required array of 1 to 50 messages. Roles: `system`, `user`, `assistant`. |
| `messages[].content` | Text or an array of text and image parts. |
| `stream` | Optional boolean. Defaults to `false`. |
| `temperature` | Optional number from 0 to 2. Omission delegates to the backend. |
| `max_tokens` | Optional integer from 1 to 4096. Set it explicitly. Omission does not apply a gateway output cap. |

Text prompts are limited to 32,000 characters. Up to two images are accepted per request, with a default 4 MiB and 20-megapixel limit per image. Supply JPEG, PNG, or WebP images as Base64 data URLs. Remote image URLs are rejected. Image normalization strips metadata.

Non-streaming requests return OpenAI-compatible `choices` and optional token usage. Streaming requests return SSE `data:` chunks followed by `data: [DONE]`. The [request and response schemas](gateway/src/http/schemas/chatCompletion.ts) define the supported fields. Extra request fields are rejected.

Errors use an `error` object with `message`, `type`, `param`, and `code`. Authentication failures return 401, invalid input returns 400, blocked models return 404, body limits return 413, and quota or queue limits return 429.

## Optional remote access

Use a hostname you control, such as `inference.example.com`, and configure a Cloudflare Tunnel to the local Nginx address. Store its token in your private `.env` as `CLOUDFLARE_TUNNEL_TOKEN`.

```text
pnpm start:tunnel
```

A configured tunnel token or enabled tunnel flag also starts tunnel mode with `pnpm start`. Without a named tunnel token, tunnel mode requests a temporary Cloudflare URL. Use the URL reported by cloudflared for your installation.

A tunnel and a Cloudflare Access policy are separate settings. Configure the edge policy before exposing the API. To enable the gateway's service-token check, set `CF_ACCESS_ENABLED=true`, `CF_ACCESS_CLIENT_ID`, and `CF_ACCESS_CLIENT_SECRET`. Clients then supply the corresponding `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers in addition to application authentication. The raw-application-secret rejection policy does not replace Cloudflare's separate service-token protocol.

The launcher excludes application and tunnel secrets from cloudflared's inherited environment. It supplies a named tunnel token through cloudflared's token argument. Keep local process inspection and diagnostic output restricted.

Nginx's current rate-limit exemption uses the connection's loopback address and a client-provided guest header. Tunnel traffic often arrives over loopback. Do not rely on that rule as an authenticated owner check or as complete denial-of-service protection. Apply access controls and rate limits at the edge.

See [Cloudflare configuration](infra/cloudflare/README.md) and the [configuration template](.env.example) for related settings.

## Verification and performance

```text
pnpm typecheck
pnpm lint
pnpm build
pnpm test
pnpm audit --prod
```

Live integration tests require a running Ollama backend and an installed model. Run `pnpm flows` against your configured stack for text, image, and streaming checks. Use a vision model for image checks. The suite contains 214 tests across 30 files at this revision.

Measure latency and memory on your own deployment. Record model name, quantization, context length, hardware, backend version, cold-load time, time to first token, and generation speed. Choose client timeouts from those measurements. The gateway currently has no overall inference deadline.

Optional macOS service templates are in [infra/launchd](infra/launchd/README.md). Linux and Windows deployments should use their OS service manager with the portable runner.

## License

[MIT](LICENSE).
