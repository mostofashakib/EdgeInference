import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { OllamaInferenceClient } from "../../gateway/src/infrastructure/ollama/OllamaInferenceClient.js";
import { UpstreamServiceError } from "../../gateway/src/domain/errors/index.js";

describe("OllamaInferenceClient", () => {
  let server: http.Server;
  let serverPort: number;
  let lastHeaders: http.IncomingHttpHeaders;
  let lastRequestBody: unknown;

  beforeEach(async () => {
    // Spin up lightweight mock upstream server
    server = http.createServer((req, res) => {
      lastHeaders = req.headers;
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        try {
          lastRequestBody = JSON.parse(body);
        } catch {
          lastRequestBody = body;
        }

        if (req.url === "/v1/chat/completions") {
          const parsed = lastRequestBody as { stream?: boolean; model?: string };
          if (parsed.model === "failing-model") {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: "Internal Ollama GPU failure" } }));
            return;
          }

          if (parsed.stream) {
            res.writeHead(200, { "Content-Type": "text/event-stream" });
            res.write('data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\n');
            res.write('data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":" there"}}]}\n\n');
            res.write("data: [DONE]\n\n");
            res.end();
          } else {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                id: "chatcmpl-mock",
                object: "chat.completion",
                created: 1730000000,
                model: "qwen3.8:27b",
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: "Mock response text" },
                    finish_reason: "stop"
                  }
                ],
                usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }
              })
            );
          }
        } else {
          res.writeHead(404);
          res.end("Not Found");
        }
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (typeof addr === "object" && addr) {
          serverPort = addr.port;
        }
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("sends request without forwarding any application authorization header", async () => {
    const client = new OllamaInferenceClient(`http://127.0.0.1:${serverPort}`);

    await client.generate({
      model: "qwen3.8:27b",
      messages: [{ role: "user", content: "Hello" }]
    });

    // Verify upstream never received authorization header
    expect(lastHeaders["authorization"]).toBeUndefined();
    expect(lastRequestBody).toMatchObject({
      model: "qwen3.8:27b",
      messages: [{ role: "user", content: "Hello" }]
    });
  });

  it("handles non-streaming response correctly", async () => {
    const client = new OllamaInferenceClient(`http://127.0.0.1:${serverPort}`);

    const res = await client.generate({
      model: "qwen3.8:27b",
      messages: [{ role: "user", content: "Hello" }]
    });

    expect(res.id).toBe("chatcmpl-mock");
    expect(res.choices[0]?.message.content).toBe("Mock response text");
  });

  it("streams SSE events cleanly", async () => {
    const client = new OllamaInferenceClient(`http://127.0.0.1:${serverPort}`);

    const chunks: string[] = [];
    for await (const evt of client.stream({
      model: "qwen3.8:27b",
      messages: [{ role: "user", content: "Hello" }],
      stream: true
    })) {
      const content = evt.choices[0]?.delta.content;
      if (content) chunks.push(content);
    }

    expect(chunks).toEqual(["Hi", " there"]);
  });

  it("maps upstream server error (500) to UpstreamServiceError", async () => {
    const client = new OllamaInferenceClient(`http://127.0.0.1:${serverPort}`);

    await expect(
      client.generate({
        model: "failing-model",
        messages: [{ role: "user", content: "Hello" }]
      })
    ).rejects.toThrow(UpstreamServiceError);
  });

  it("maps connection failure (offline port) to UpstreamServiceError", async () => {
    // Unused port that will fail connection
    const client = new OllamaInferenceClient("http://127.0.0.1:59999");

    await expect(
      client.generate({
        model: "qwen3.8:27b",
        messages: [{ role: "user", content: "Hello" }]
      })
    ).rejects.toThrow(UpstreamServiceError);
  });
});
