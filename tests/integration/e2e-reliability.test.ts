import { hashSecretSha256 } from "../../gateway/src/client/cryptoAuth.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";
import { createApp, type AppDependencies } from "../../gateway/src/app.js";
import { BearerTokenAuthenticator } from "../../gateway/src/infrastructure/auth/BearerTokenAuthenticator.js";
import { SqliteQuotaRepository } from "../../gateway/src/infrastructure/persistence/SqliteQuotaRepository.js";
import { SemaphoreAdmissionController } from "../../gateway/src/infrastructure/concurrency/SemaphoreAdmissionController.js";
import { loadConfig } from "../../gateway/src/config/AppConfig.js";
import {
  FakeInferenceClient,
  FakeImageProcessor,
  FakeClock,
  FakeMetricsRecorder
} from "../fakes/index.js";
import { UpstreamServiceError } from "../../gateway/src/domain/errors/index.js";

describe("M7 Reliability and End-to-End Testing", () => {
  const secret = "f".repeat(64);
  const testDbDir = path.resolve(process.cwd(), "data/test");
  const testDbPath = path.join(testDbDir, "m7-reliability.db");
  const testPort = 8799;
  const baseUrl = `http://127.0.0.1:${testPort}/v1`;

  let app: FastifyInstance | null = null;
  let fakeClient: FakeInferenceClient;
  let quotaRepo: SqliteQuotaRepository;
  let admissionController: SemaphoreAdmissionController;

  function buildTestApp(customDailyQuota = 10, maxActive = 1, maxQueue = 2): FastifyInstance {
    quotaRepo = new SqliteQuotaRepository(testDbPath);
    admissionController = new SemaphoreAdmissionController({
      maxActive,
      maxQueue
    });

    const config = loadConfig({
      NODE_ENV: "test",
      PORT: String(testPort),
      HOST: "127.0.0.1",
      LLM_API_SECRET: secret,
      ALLOWED_MODELS: "qwen3.8:27b",
      DAILY_REQUEST_QUOTA: String(customDailyQuota),
      GUEST_RATE_LIMIT_PER_MINUTE: "20",
      MAX_ACTIVE_INFERENCE: String(maxActive),
      MAX_QUEUE_CAPACITY: String(maxQueue),
      DATABASE_PATH: testDbPath
    });

    const authenticator = new BearerTokenAuthenticator([{ keyId: "test-client", secret }]);

    const deps: AppDependencies = {
      config,
      authenticator,
      inferenceClient: fakeClient,
      quotaRepository: quotaRepo,
      admissionController,
      imageProcessor: new FakeImageProcessor(),
      clock: new FakeClock(),
      metricsRecorder: new FakeMetricsRecorder()
    };

    return createApp(deps);
  }

  beforeEach(async () => {
    fs.mkdirSync(testDbDir, { recursive: true });
    if (fs.existsSync(testDbPath)) {
      try {
        fs.unlinkSync(testDbPath);
      } catch {
        // ignore
      }
    }

    fakeClient = new FakeInferenceClient();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
    quotaRepo?.close();
    if (fs.existsSync(testDbPath)) {
      try {
        fs.unlinkSync(testDbPath);
      } catch {
        // ignore
      }
    }
  });

  it("completes full OpenAI SDK chat completion (non-streaming)", async () => {
    app = buildTestApp();
    await app.listen({ port: testPort, host: "127.0.0.1" });

    fakeClient.setDefaultText("Autonomous systems require robust verification.");

    const client = new OpenAI({
      baseURL: baseUrl,
      apiKey: hashSecretSha256(secret)
    });

    const completion = await client.chat.completions.create({
      model: "qwen3.8:27b",
      messages: [{ role: "user", content: "What do autonomous systems require?" }],
      temperature: 0.2
    });

    expect(completion.id).toMatch(/(fake-)?chatcmpl-/);
    expect(completion.choices[0]?.message.content).toBe(
      "Autonomous systems require robust verification."
    );
    expect(completion.choices[0]?.finish_reason).toBe("stop");
    expect(completion.usage?.total_tokens).toBeGreaterThan(0);
  });

  it("completes progressive streaming using official OpenAI SDK async iterator", async () => {
    app = buildTestApp();
    await app.listen({ port: testPort, host: "127.0.0.1" });

    fakeClient.setStreamChunks(["Stream ", "token ", "streamed."]);

    const client = new OpenAI({
      baseURL: baseUrl,
      apiKey: hashSecretSha256(secret)
    });

    const stream = await client.chat.completions.create({
      model: "qwen3.8:27b",
      messages: [{ role: "user", content: "Stream this response" }],
      stream: true
    });

    const receivedChunks: string[] = [];
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta.content;
      if (content) {
        receivedChunks.push(content);
      }
    }

    expect(receivedChunks.join("")).toBe("Stream token streamed.");
  });

  it("handles multimodal image requests via OpenAI SDK", async () => {
    app = buildTestApp();
    await app.listen({ port: testPort, host: "127.0.0.1" });

    fakeClient.setDefaultText("I see a blue square and a red circle.");

    const client = new OpenAI({
      baseURL: baseUrl,
      apiKey: hashSecretSha256(secret)
    });

    const dummyDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    const completion = await client.chat.completions.create({
      model: "qwen3.8:27b",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe what is in this image" },
            { type: "image_url", image_url: { url: dummyDataUrl } }
          ]
        }
      ]
    });

    expect(completion.choices[0]?.message.content).toBe("I see a blue square and a red circle.");
  });

  it("recovers gracefully from temporary upstream Ollama failure without gateway restart", async () => {
    app = buildTestApp();
    await app.listen({ port: testPort, host: "127.0.0.1" });

    const client = new OpenAI({
      baseURL: baseUrl,
      apiKey: hashSecretSha256(secret)
    });

    // 1. Simulate upstream failure
    fakeClient.setShouldFail(true, new UpstreamServiceError("Ollama daemon temporarily unavailable"));

    let caughtError: unknown = null;
    try {
      await client.chat.completions.create({
        model: "qwen3.8:27b",
        messages: [{ role: "user", content: "Test failure" }]
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(OpenAI.APIError);
    expect((caughtError as { status?: number }).status).toBe(502);

    // 2. Upstream recovers — next request succeeds immediately
    fakeClient.setShouldFail(false);
    fakeClient.setDefaultText("Ollama is healthy again.");

    const successRes = await client.chat.completions.create({
      model: "qwen3.8:27b",
      messages: [{ role: "user", content: "Test recovery" }]
    });

    expect(successRes.choices[0]?.message.content).toBe("Ollama is healthy again.");
  });

  it("handles client cancellation (AbortController) and does not consume quota", async () => {
    app = buildTestApp(5, 1, 1);
    await app.listen({ port: testPort, host: "127.0.0.1" });

    // Hold the request open
    fakeClient.setResponseDelay(500);

    const client = new OpenAI({
      baseURL: baseUrl,
      apiKey: hashSecretSha256(secret)
    });

    const abortController = new AbortController();
    setTimeout(() => abortController.abort(), 50);

    let aborted = false;
    try {
      await client.chat.completions.create(
        {
          model: "qwen3.8:27b",
          messages: [{ role: "user", content: "Long task" }]
        },
        { signal: abortController.signal }
      );
    } catch (err: unknown) {
      if ((err as Error).name === "AbortError" || err instanceof OpenAI.APIUserAbortError) {
        aborted = true;
      }
    }

    expect(aborted).toBe(true);

    // Concurrency lease should be fully released
    expect(admissionController.getSnapshot().activeCount).toBe(0);
    expect(admissionController.getSnapshot().queueLength).toBe(0);

    // Quota should be rolled back so quota count remains 0
    const usedCount = quotaRepo.getUsedCount("test-client", new Date().toISOString().slice(0, 10));
    expect(usedCount).toBe(0);
  });

  it("rejects invalid API secret with OpenAI.AuthenticationError (401)", async () => {
    app = buildTestApp();
    await app.listen({ port: testPort, host: "127.0.0.1" });

    const client = new OpenAI({
      baseURL: baseUrl,
      apiKey: "completely_invalid_secret_key"
    });

    let caught401 = false;
    try {
      await client.chat.completions.create({
        model: "qwen3.8:27b",
        messages: [{ role: "user", content: "Unauthorized attempt" }]
      });
    } catch (err: unknown) {
      if (err instanceof OpenAI.AuthenticationError || (err as { status?: number }).status === 401) {
        caught401 = true;
      }
    }

    expect(caught401).toBe(true);
  });

  it("preserves persistent quota state across Gateway restart", async () => {
    // 1. Initial gateway instance with quota = 2
    app = buildTestApp(2);
    await app.listen({ port: testPort, host: "127.0.0.1" });

    const client = new OpenAI({
      baseURL: baseUrl,
      apiKey: hashSecretSha256(secret)
    });

    // Request 1 succeeds
    fakeClient.setDefaultText("Response 1");
    await client.chat.completions.create({
      model: "qwen3.8:27b",
      messages: [{ role: "user", content: "Req 1" }]
    });

    // Request 2 succeeds
    fakeClient.setDefaultText("Response 2");
    await client.chat.completions.create({
      model: "qwen3.8:27b",
      messages: [{ role: "user", content: "Req 2" }]
    });

    // 2. Shut down gateway instance
    await app.close();
    quotaRepo.close();
    app = null;

    // 3. Restart gateway pointing to same SQLite database
    app = buildTestApp(2);
    await app.listen({ port: testPort, host: "127.0.0.1" });

    // Request 3 must fail with 429 quota_exceeded
    let caughtQuotaExceeded = false;
    try {
      await client.chat.completions.create({
        model: "qwen3.8:27b",
        messages: [{ role: "user", content: "Req 3" }]
      });
    } catch (err: unknown) {
      if (err instanceof OpenAI.RateLimitError || (err as { status?: number }).status === 429) {
        caughtQuotaExceeded = true;
      }
    }

    expect(caughtQuotaExceeded).toBe(true);
  });

  it("handles concurrency queue saturation with 429 inference_busy", async () => {
    // 1 active slot, 1 queue slot => 3rd concurrent request rejected with 429
    app = buildTestApp(100, 1, 1);
    await app.listen({ port: testPort, host: "127.0.0.1" });

    fakeClient.setResponseDelay(200);

    const client = new OpenAI({
      baseURL: baseUrl,
      apiKey: hashSecretSha256(secret),
      maxRetries: 0
    });

    // Fire 3 simultaneous requests
    const p1 = client.chat.completions.create({
      model: "qwen3.8:27b",
      messages: [{ role: "user", content: "Concurrency req 1" }]
    });
    const p2 = client.chat.completions.create({
      model: "qwen3.8:27b",
      messages: [{ role: "user", content: "Concurrency req 2" }]
    });
    const p3 = client.chat.completions.create({
      model: "qwen3.8:27b",
      messages: [{ role: "user", content: "Concurrency req 3" }]
    });

    const results = await Promise.allSettled([p1, p2, p3]);

    const rejected = results.filter((r) => r.status === "rejected");
    const fulfilled = results.filter((r) => r.status === "fulfilled");

    expect(fulfilled.length).toBe(2); // 1 active + 1 queued
    expect(rejected.length).toBe(1); // 1 saturated

    const error = (rejected[0] as PromiseRejectedResult).reason as { status?: number };
    expect(error.status).toBe(429);
  });
});
