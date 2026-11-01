# ADR 0003: Request Validation, Image Sanitization, and Inference Gateway

## Status
Accepted

## Context
In Milestone 3, the Gateway must accept multimodal chat completion requests and forward validated payloads to local Ollama (`qwen3.8:27b`).
Security and operational constraints:
- Attackers or users might submit malicious, corrupted, or oversized images (decompression bombs).
- Arbitrary remote URLs (`http://`, `https://`) pose SSRF and network exfiltration risks.
- The gateway's internal private API secret must never be leaked upstream to Ollama.
- Parameter tampering: OpenAI clients often submit optional or vendor-specific flags. Unsupported parameters must be rejected explicitly rather than silently ignored.
- Images must have metadata (EXIF/GPS/ICC) stripped to ensure privacy and minimal token overhead while preserving spatial resolution needed for OCR and detail extraction.

## Decision

1. **Strict Multimodal Request Validation**:
   - `ChatCompletionRequestSchema` enforces `.strict()` parsing, rejecting unallowed keys.
   - Total prompt characters are capped at 32,000 characters.
   - Remote image URLs (`http://`, `https://`) are rejected with HTTP 400. Images must be submitted as Base64 data URLs (`data:image/<type>;base64,...`).
   - Image quantity is capped at 2 images per request.
2. **Sharp Image Sanitization Pipeline**:
   - `SharpImageProcessor` validates magic bytes (`FF D8 FF` for JPEG, `89 50 4E 47 0D 0A 1A 0A` for PNG, `RIFF...WEBP` for WebP).
   - Enforces 4 MiB buffer limit and 20 megapixel maximum dimensions (`limitInputPixels: 20_000_000`) to prevent memory exhaustion and decompression bombs.
   - Strips all EXIF, GPS, and color profile metadata during re-encoding (`.png()`, `.jpeg({ quality: 90 })`, `.webp({ quality: 90 })`).
3. **Ollama Client Protocol Isolation**:
   - `OllamaInferenceClient` communicates with local Ollama (`127.0.0.1:11434`) via HTTP POST `/v1/chat/completions`.
   - Never sends the incoming bearer secret upstream.
   - Propagates `AbortSignal` for cancellation.
   - Parses streaming Server-Sent Events (SSE) line-by-line, forwarding structured chunks.
   - Maps network connection errors and upstream 5xx errors to `UpstreamServiceError` (HTTP 502).

## Consequences
- Image uploads are fully sanitized before entering the Ollama vision pipeline.
- Workstation memory is protected against decompression attacks.
- Upstream Ollama failures return clean, predictable 502 responses without crashing the gateway.

