import type { InferenceClient } from "../../domain/interfaces/index.js";
import type {
  InferenceRequest,
  InferenceResponse,
  InferenceEvent
} from "../../domain/models/types.js";
import { UpstreamServiceError } from "../../domain/errors/index.js";

export class OllamaInferenceClient implements InferenceClient {
  constructor(private readonly baseUrl: string = "http://127.0.0.1:11434") {}

  private mapRequestPayload(request: InferenceRequest, stream: boolean) {
    return {
      model: request.model,
      messages: request.messages,
      stream,
      temperature: request.temperature,
      max_tokens: request.maxTokens
    };
  }

  private async dispatchUpstream(payload: unknown, signal?: AbortSignal): Promise<Response> {
    const url = `${this.baseUrl}/v1/chat/completions`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
          // Crucial: never forward gateway API secret to Ollama
        },
        body: JSON.stringify(payload),
        signal: signal ?? null
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw err;
      }
      throw new UpstreamServiceError(
        `Failed to reach upstream Ollama at ${this.baseUrl}: ${(err as Error).message}`
      );
    }

    if (!res.ok) {
      const errorText = await res.text().catch(() => "Unknown upstream error");
      throw new UpstreamServiceError(
        `Upstream Ollama returned HTTP ${res.status}: ${errorText}`
      );
    }

    return res;
  }

  async generate(request: InferenceRequest, signal?: AbortSignal): Promise<InferenceResponse> {
    const payload = this.mapRequestPayload(request, false);
    const res = await this.dispatchUpstream(payload, signal);

    try {
      return (await res.json()) as InferenceResponse;
    } catch (err) {
      throw new UpstreamServiceError(
        `Failed to parse upstream response JSON: ${(err as Error).message}`
      );
    }
  }

  async *stream(request: InferenceRequest, signal?: AbortSignal): AsyncIterable<InferenceEvent> {
    const payload = this.mapRequestPayload(request, true);
    const res = await this.dispatchUpstream(payload, signal);

    if (!res.body) {
      throw new UpstreamServiceError("Upstream Ollama returned empty response stream body");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        // Keep the last partial line in buffer
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;

          const dataStr = trimmed.slice(5).trim();
          if (dataStr === "[DONE]") {
            return;
          }

          try {
            const parsed = JSON.parse(dataStr) as InferenceEvent;
            yield parsed;
          } catch {
            // ignore non-json keepalive lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
