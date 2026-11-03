import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
const MODEL_NAME = process.env.LLM_MODEL || "qwen3.8:27b";

interface ChatCompletionResponse {
  id: string;
  choices: Array<{
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
}

describe("Portable Ollama Inference Integration", () => {
  beforeAll(async () => {
    // Verify Ollama is reachable
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
    expect(res.ok).toBe(true);
    const data = (await res.json()) as { models: Array<{ name: string }> };
    const hasModel = data.models.some((m) => m.name.includes(MODEL_NAME));
    if (!hasModel) {
      throw new Error(`Model ${MODEL_NAME} is not yet pulled or available in Ollama.`);
    }
  }, 30000);

  it("generates coherent text response", async () => {
    const res = await fetch(`${OLLAMA_BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL_NAME,
        messages: [{ role: "user", content: "Reply with exactly the word 'PONG'." }],
        temperature: 0.1,
        stream: false
      })
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as ChatCompletionResponse;
    expect(data.choices).toHaveLength(1);
    expect(data.choices[0]?.message.content.toUpperCase()).toContain("PONG");
  }, 45000);

  it("correctly answers a known-answer reasoning problem", async () => {
    const res = await fetch(`${OLLAMA_BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL_NAME,
        messages: [
          {
            role: "user",
            content:
              "A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How much does the ball cost? Give only the number in cents or dollars."
          }
        ],
        temperature: 0.1,
        stream: false
      })
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as ChatCompletionResponse;
    const content = data.choices[0]?.message.content.toLowerCase() || "";
    // Correct answer is 5 cents ($0.05 or 5)
    expect(content).toMatch(/\b5\b|5\s*cents?|0\.05|\$0\.05/);
  }, 45000);

  it("describes visual elements from an uploaded image", async () => {
    const imagePath = path.resolve(process.cwd(), "tests/fixtures/images/shapes.png");
    const imageBuffer = fs.readFileSync(imagePath);
    const dataUrl = `data:image/png;base64,${imageBuffer.toString("base64")}`;

    const res = await fetch(`${OLLAMA_BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL_NAME,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "What geometric shapes, colors, and text are in this image? Be specific."
              },
              { type: "image_url", image_url: { url: dataUrl } }
            ]
          }
        ],
        temperature: 0.1,
        stream: false
      })
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as ChatCompletionResponse;
    const content = data.choices[0]?.message.content.toLowerCase() || "";
    // shapes.png contains: red rectangle/square, blue circle, and text "EdgeInference Test"
    expect(content).toMatch(/red|square|rectangle/);
    expect(content).toMatch(/blue|circle/);
  }, 60000);

  it("streams output chunks progressively using SSE", async () => {
    const res = await fetch(`${OLLAMA_BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL_NAME,
        messages: [{ role: "user", content: "Count from 1 to 5 separated by spaces." }],
        stream: true
      })
    });

    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let chunkCount = 0;
    let fullText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split("\n").filter((l) => l.trim().startsWith("data:"));

      for (const line of lines) {
        const payload = line.replace(/^data:\s*/, "").trim();
        if (payload === "[DONE]") continue;

        try {
          const parsed = JSON.parse(payload);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            fullText += delta;
            chunkCount++;
          }
        } catch {
          // ignore keepalive or parse artifacts
        }
      }
    }

    expect(chunkCount).toBeGreaterThan(1);
    expect(fullText).toMatch(/1.*2.*3.*4.*5/);
  }, 45000);

  it("fails safely when requesting an unsupported/non-existent model", async () => {
    const res = await fetch(`${OLLAMA_BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "non-existent-model-xyz",
        messages: [{ role: "user", content: "Hello" }]
      })
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
  }, 10000);

  it("reports valid memory allocation for CPU, mixed, or GPU inference", async () => {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/ps`);
    expect(res.ok).toBe(true);
    const data = (await res.json()) as {
      models?: Array<{
        name: string;
        size: number;
        size_vram?: number;
        runner?: string;
      }>;
    };

    const activeModel = data.models?.find((m) => m.name.includes(MODEL_NAME));
    expect(activeModel).toBeDefined();
    expect(activeModel!.size).toBeGreaterThan(0);
    expect(activeModel!.size_vram ?? 0).toBeGreaterThanOrEqual(0);
    expect(activeModel!.size_vram ?? 0).toBeLessThanOrEqual(activeModel!.size);
  }, 15000);
});

