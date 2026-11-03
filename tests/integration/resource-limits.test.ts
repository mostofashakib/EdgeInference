import { hashSecretSha256 } from "../../gateway/src/client/cryptoAuth.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
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

describe("M4 Resource Management: Quota, Concurrency, and Cancellation", () => {
  const secret = "c".repeat(64);
  const testDbDir = path.resolve(process.cwd(), "data/test");
  const testDbPath = path.join(testDbDir, "m4-resource.db");

  let app: FastifyInstance;
  let fakeClient: FakeInferenceClient;
  let quotaRepo: SqliteQuotaRepository;
  let admissionController: SemaphoreAdmissionController;

  beforeEach(() => {
    fs.mkdirSync(testDbDir, { recursive: true });
    if (fs.existsSync(testDbPath)) {
      try {
        fs.unlinkSync(testDbPath);
      } catch {
        // ignore
      }
    }

    fakeClient = new FakeInferenceClient();
    quotaRepo = new SqliteQuotaRepository(testDbPath);
    admissionController = new SemaphoreAdmissionController({
      maxActive: 1,
      maxQueue: 1
    });

    const config = loadConfig({
      NODE_ENV: "test",
      LLM_API_SECRET: secret,
      ALLOWED_MODELS: "qwen3.8:27b",
      DAILY_REQUEST_QUOTA: "2",
      MAX_ACTIVE_INFERENCE: "1",
      MAX_QUEUE_CAPACITY: "1",
      DATABASE_PATH: testDbPath
    });

    const authenticator = new BearerTokenAuthenticator([{ keyId: "user-1", secret }]);

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

    app = createApp(deps);
  });

  afterEach(async () => {
    if (app) await app.close();
    if (quotaRepo) quotaRepo.close();
    if (fs.existsSync(testDbPath)) {
      try {
        fs.unlinkSync(testDbPath);
      } catch {
        // ignore
      }
    }
  });

  it("enforces daily request quota and rejects excess requests with HTTP 429", async () => {
    // 1st request -> OK
    const res1 = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${hashSecretSha256(secret)}` },
      payload: {
        model: "qwen3.8:27b",
        messages: [{ role: "user", content: "Req 1" }]
      }
    });
    expect(res1.statusCode).toBe(200);

    // 2nd request -> OK
    const res2 = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${hashSecretSha256(secret)}` },
      payload: {
        model: "qwen3.8:27b",
        messages: [{ role: "user", content: "Req 2" }]
      }
    });
    expect(res2.statusCode).toBe(200);

    // 3rd request -> 429 Quota Exceeded
    const res3 = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${hashSecretSha256(secret)}` },
      payload: {
        model: "qwen3.8:27b",
        messages: [{ role: "user", content: "Req 3" }]
      }
    });
    expect(res3.statusCode).toBe(429);
    const body = JSON.parse(res3.payload);
    expect(body.error.code).toBe("quota_exceeded");
  });

  it("persists quota accounting across application restart", async () => {
    // Consume 2 requests in instance 1
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${hashSecretSha256(secret)}` },
        payload: {
          model: "qwen3.8:27b",
          messages: [{ role: "user", content: `Req ${i}` }]
        }
      });
      expect(res.statusCode).toBe(200);
    }

    // Close application and database connection
    await app.close();
    quotaRepo.close();

    // Restart application with new instance pointing to same SQLite database
    const newRepo = new SqliteQuotaRepository(testDbPath);
    const newConfig = loadConfig({
      NODE_ENV: "test",
      LLM_API_SECRET: secret,
      ALLOWED_MODELS: "qwen3.8:27b",
      DAILY_REQUEST_QUOTA: "2",
      DATABASE_PATH: testDbPath
    });

    const newApp = createApp({
      config: newConfig,
      authenticator: new BearerTokenAuthenticator([{ keyId: "user-1", secret }]),
      inferenceClient: fakeClient,
      quotaRepository: newRepo,
      admissionController: new SemaphoreAdmissionController({ maxActive: 1, maxQueue: 1 }),
      imageProcessor: new FakeImageProcessor(),
      clock: new FakeClock(),
      metricsRecorder: new FakeMetricsRecorder()
    });

    const restartRes = await newApp.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${hashSecretSha256(secret)}` },
      payload: {
        model: "qwen3.8:27b",
        messages: [{ role: "user", content: "Req after restart" }]
      }
    });

    expect(restartRes.statusCode).toBe(429);
    await newApp.close();
    newRepo.close();
  });

  it("enforces inference concurrency and bounded queue with HTTP 429", async () => {
    // Reconfigure app with ample daily quota to isolate concurrency/queue limits
    const concurrencyConfig = loadConfig({
      NODE_ENV: "test",
      LLM_API_SECRET: secret,
      ALLOWED_MODELS: "qwen3.8:27b",
      DAILY_REQUEST_QUOTA: "100",
      MAX_ACTIVE_INFERENCE: "1",
      MAX_QUEUE_CAPACITY: "1",
      DATABASE_PATH: testDbPath
    });

    const concurrencyApp = createApp({
      config: concurrencyConfig,
      authenticator: new BearerTokenAuthenticator([{ keyId: "user-1", secret }]),
      inferenceClient: fakeClient,
      quotaRepository: quotaRepo,
      admissionController,
      imageProcessor: new FakeImageProcessor(),
      clock: new FakeClock(),
      metricsRecorder: new FakeMetricsRecorder()
    });

    // Make fake client delay response to hold active slot
    let releaseDelayedInference: () => void = () => {};
    const delayPromise = new Promise<void>((resolve) => {
      releaseDelayedInference = resolve;
    });

    fakeClient.generate = async () => {
      await delayPromise;
      return fakeClient.cannedResponse;
    };

    // Dispatch Req 1: occupies active slot (1/1 active)
    const p1 = concurrencyApp.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${hashSecretSha256(secret)}` },
      payload: {
        model: "qwen3.8:27b",
        messages: [{ role: "user", content: "Active 1" }]
      }
    });

    // Wait a tick for Req 1 to acquire lease
    await new Promise((r) => setTimeout(r, 20));

    // Dispatch Req 2: occupies queue slot (1/1 queued)
    const p2 = concurrencyApp.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${hashSecretSha256(secret)}` },
      payload: {
        model: "qwen3.8:27b",
        messages: [{ role: "user", content: "Queued 2" }]
      }
    });

    await new Promise((r) => setTimeout(r, 20));

    // Dispatch Req 3: exceeds queue limit -> immediate 429
    const res3 = concurrencyApp.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${hashSecretSha256(secret)}` },
      payload: {
        model: "qwen3.8:27b",
        messages: [{ role: "user", content: "Overflow 3" }]
      }
    });

    const awaitedRes3 = await res3;
    expect(awaitedRes3.statusCode).toBe(429);
    const body3 = JSON.parse(awaitedRes3.payload);
    expect(body3.error.code).toBe("inference_busy");

    // Now release delayed inference for Req 1
    releaseDelayedInference();

    const res1 = await p1;
    const res2 = await p2;

    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);

    await concurrencyApp.close();
  });

  it("reclaims inference slot when upstream inference fails", async () => {
    // Configure fake client to throw on first call
    let throwError = true;
    fakeClient.generate = async () => {
      if (throwError) {
        throwError = false;
        throw new Error("Temporary Ollama crash");
      }
      return fakeClient.cannedResponse;
    };

    // 1st request fails
    const res1 = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${hashSecretSha256(secret)}` },
      payload: {
        model: "qwen3.8:27b",
        messages: [{ role: "user", content: "Fail" }]
      }
    });
    expect(res1.statusCode).toBe(500);

    // 2nd request succeeds, confirming the semaphore slot was not leaked
    const res2 = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${hashSecretSha256(secret)}` },
      payload: {
        model: "qwen3.8:27b",
        messages: [{ role: "user", content: "Recover" }]
      }
    });
    expect(res2.statusCode).toBe(200);
  });
});
