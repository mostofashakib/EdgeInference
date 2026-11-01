import fs from "node:fs";
import path from "node:path";
import { createApp } from "../../gateway/src/app.js";
import { BearerTokenAuthenticator } from "../../gateway/src/infrastructure/auth/BearerTokenAuthenticator.js";
import { OllamaInferenceClient } from "../../gateway/src/infrastructure/ollama/OllamaInferenceClient.js";
import { SharpImageProcessor } from "../../gateway/src/infrastructure/images/SharpImageProcessor.js";
import { SqliteQuotaRepository } from "../../gateway/src/infrastructure/persistence/SqliteQuotaRepository.js";
import { SemaphoreAdmissionController } from "../../gateway/src/infrastructure/concurrency/SemaphoreAdmissionController.js";
import { SystemClock } from "../../gateway/src/infrastructure/observability/SystemClock.js";
import { StructuredMetricsRecorder } from "../../gateway/src/infrastructure/observability/StructuredMetricsRecorder.js";
import { loadConfig } from "../../gateway/src/config/AppConfig.js";

// Centralize local configuration: automatically load .env if present
const envPath = path.resolve(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const TEST_SECRET = process.env.LLM_API_SECRET || "b".repeat(64);
const OLLAMA_URL = "http://127.0.0.1:11434";
const GATEWAY_URL = "http://127.0.0.1:8765";
const NGINX_URL = "http://127.0.0.1:8080";
const MODEL_NAME = "qwen3.8:27b";

interface BenchmarkResult {
  target: string;
  scenario: string;
  durationMs: number;
  ttftMs?: number;
  tokensGenerated?: number;
  tokensPerSec?: number;
  overheadMs?: number;
}

async function measureStreaming(
  url: string,
  headers: Record<string, string>,
  prompt: string
): Promise<{ durationMs: number; ttftMs: number; totalTokens: number; text: string }> {
  const start = performance.now();
  const res = await fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      model: MODEL_NAME,
      messages: [{ role: "user", content: prompt }],
      stream: true,
      max_tokens: 50
    })
  });

  if (!res.ok) {
    throw new Error(`Request to ${url} failed with ${res.status}: ${await res.text()}`);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let ttftMs = 0;
  let chunkCount = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split("\n").filter((l) => l.trim().startsWith("data:"));

    for (const line of lines) {
      const dataStr = line.replace(/^data:\s*/, "").trim();
      if (dataStr === "[DONE]") continue;

      try {
        const parsed = JSON.parse(dataStr);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) {
          if (ttftMs === 0) {
            ttftMs = performance.now() - start;
          }
          text += delta;
          chunkCount++;
        }
      } catch {
        // ignore
      }
    }
  }

  const durationMs = performance.now() - start;
  // Estimate tokens based on words/chunks
  const totalTokens = Math.max(chunkCount, Math.round(text.split(/\s+/).length * 1.3));
  return { durationMs, ttftMs, totalTokens, text };
}

async function measureVision(
  url: string,
  headers: Record<string, string>,
  imagePath: string,
  prompt: string
): Promise<{ durationMs: number; text: string }> {
  const imageBuffer = fs.readFileSync(imagePath);
  const dataUrl = `data:image/png;base64,${imageBuffer.toString("base64")}`;

  const start = performance.now();
  const res = await fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      model: MODEL_NAME,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: dataUrl } }
          ]
        }
      ],
      max_tokens: 50
    })
  });

  if (!res.ok) {
    throw new Error(`Vision request to ${url} failed with ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const durationMs = performance.now() - start;
  return {
    durationMs,
    text: data.choices?.[0]?.message?.content || ""
  };
}

async function main(): Promise<void> {
  console.log("==========================================================");
  console.log("  EdgeInference M8 End-to-End Performance Benchmark Suite ");
  console.log("==========================================================");
  console.log(`Model: ${MODEL_NAME}`);
  console.log(`Target Matrix: Direct Ollama (11434) vs Fastify Gateway (8765) vs Nginx (8080)`);

  const dbPath = path.resolve(process.cwd(), "data/benchmark.db");
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

  // Spin up Fastify Gateway
  const config = loadConfig({
    NODE_ENV: "production",
    PORT: "8765",
    HOST: "127.0.0.1",
    LLM_API_SECRET: TEST_SECRET,
    ALLOWED_MODELS: MODEL_NAME,
    DAILY_REQUEST_QUOTA: "1000",
    MAX_ACTIVE_INFERENCE: "1",
    MAX_QUEUE_CAPACITY: "2",
    DATABASE_PATH: dbPath
  });

  const authenticator = new BearerTokenAuthenticator([{ keyId: "bench-key", secret: TEST_SECRET }]);
  const quotaRepo = new SqliteQuotaRepository(dbPath);
  const admission = new SemaphoreAdmissionController({ maxActive: 1, maxQueue: 2 });
  const imageProc = new SharpImageProcessor({
    maxBytes: 4 * 1024 * 1024,
    maxMegapixels: 20,
    allowedFormats: ["jpeg", "png", "webp"]
  });
  const inferenceClient = new OllamaInferenceClient(OLLAMA_URL);

  const app = createApp({
    config,
    authenticator,
    inferenceClient,
    quotaRepository: quotaRepo,
    admissionController: admission,
    imageProcessor: imageProc,
    clock: new SystemClock(),
    metricsRecorder: new StructuredMetricsRecorder()
  });

  await app.listen({ port: 8765, host: "127.0.0.1" });
  console.log("✓ Fastify Gateway listening on 127.0.0.1:8765\n");

  const results: BenchmarkResult[] = [];
  const testPrompt = "Explain in one sentence what software verification accomplishes.";
  const imagePath = path.resolve(process.cwd(), "tests/fixtures/images/shapes.png");

  try {
    // 1. Direct Ollama Streaming Benchmark
    console.log("[1/3] Benchmarking Direct Ollama (127.0.0.1:11434)...");
    const ollamaStream = await measureStreaming(OLLAMA_URL, {}, testPrompt);
    const ollamaTokSec = Number((ollamaStream.totalTokens / (ollamaStream.durationMs / 1000)).toFixed(1));
    results.push({
      target: "Raw Ollama (11434)",
      scenario: "Streaming Text",
      durationMs: Math.round(ollamaStream.durationMs),
      ttftMs: Math.round(ollamaStream.ttftMs),
      tokensGenerated: ollamaStream.totalTokens,
      tokensPerSec: ollamaTokSec,
      overheadMs: 0
    });
    console.log(`      Duration: ${Math.round(ollamaStream.durationMs)}ms | TTFT: ${Math.round(ollamaStream.ttftMs)}ms | Rate: ${ollamaTokSec} tok/s`);

    // 2. Gateway Streaming Benchmark
    console.log("\n[2/3] Benchmarking Fastify Gateway (127.0.0.1:8765)...");
    const gatewayStream = await measureStreaming(
      GATEWAY_URL,
      { Authorization: `Bearer ${TEST_SECRET}` },
      testPrompt
    );
    const gatewayTokSec = Number((gatewayStream.totalTokens / (gatewayStream.durationMs / 1000)).toFixed(1));
    const gatewayOverhead = Math.round(gatewayStream.durationMs - ollamaStream.durationMs);
    results.push({
      target: "Fastify Gateway (8765)",
      scenario: "Streaming Text",
      durationMs: Math.round(gatewayStream.durationMs),
      ttftMs: Math.round(gatewayStream.ttftMs),
      tokensGenerated: gatewayStream.totalTokens,
      tokensPerSec: gatewayTokSec,
      overheadMs: gatewayOverhead
    });
    console.log(`      Duration: ${Math.round(gatewayStream.durationMs)}ms | TTFT: ${Math.round(gatewayStream.ttftMs)}ms | Rate: ${gatewayTokSec} tok/s | Overhead: ${gatewayOverhead}ms`);

    // 3. Nginx Reverse Proxy Streaming Benchmark
    console.log("\n[3/3] Benchmarking Nginx -> Gateway -> Ollama (127.0.0.1:8080)...");
    const nginxStream = await measureStreaming(
      NGINX_URL,
      { Authorization: `Bearer ${TEST_SECRET}` },
      testPrompt
    );
    const nginxTokSec = Number((nginxStream.totalTokens / (nginxStream.durationMs / 1000)).toFixed(1));
    const nginxOverhead = Math.round(nginxStream.durationMs - ollamaStream.durationMs);
    results.push({
      target: "Nginx -> Gateway (8080)",
      scenario: "Streaming Text",
      durationMs: Math.round(nginxStream.durationMs),
      ttftMs: Math.round(nginxStream.ttftMs),
      tokensGenerated: nginxStream.totalTokens,
      tokensPerSec: nginxTokSec,
      overheadMs: nginxOverhead
    });
    console.log(`      Duration: ${Math.round(nginxStream.durationMs)}ms | TTFT: ${Math.round(nginxStream.ttftMs)}ms | Rate: ${nginxTokSec} tok/s | Overhead: ${nginxOverhead}ms`);

    // 4. Multimodal Vision Benchmark
    console.log("\n[4] Benchmarking Multimodal Vision through Nginx Reverse Proxy (8080)...");
    const visionBench = await measureVision(
      NGINX_URL,
      { Authorization: `Bearer ${TEST_SECRET}` },
      imagePath,
      "Identify the shapes and colors."
    );
    console.log(`      Vision Duration: ${Math.round(visionBench.durationMs)}ms`);
    results.push({
      target: "Nginx -> Gateway (8080)",
      scenario: "Multimodal Vision",
      durationMs: Math.round(visionBench.durationMs),
      overheadMs: 0
    });

    console.log("\n==========================================================");
    console.log("                 BENCHMARK SUMMARY TABLE                  ");
    console.log("==========================================================");
    console.table(results);
    console.log("==========================================================");
  } finally {
    await app.close();
    quotaRepo.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  }
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
