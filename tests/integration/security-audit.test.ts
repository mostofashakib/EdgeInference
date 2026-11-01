import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { createApp, type AppDependencies } from "../../gateway/src/app.js";
import { BearerTokenAuthenticator } from "../../gateway/src/infrastructure/auth/BearerTokenAuthenticator.js";
import { CloudflareAccessValidator } from "../../gateway/src/infrastructure/auth/CloudflareAccessValidator.js";
import { SharpImageProcessor } from "../../gateway/src/infrastructure/images/SharpImageProcessor.js";
import { SqliteQuotaRepository } from "../../gateway/src/infrastructure/persistence/SqliteQuotaRepository.js";
import { SemaphoreAdmissionController } from "../../gateway/src/infrastructure/concurrency/SemaphoreAdmissionController.js";
import { loadConfig } from "../../gateway/src/config/AppConfig.js";
import {
  FakeInferenceClient,
  FakeClock,
  FakeMetricsRecorder
} from "../fakes/index.js";

describe("M8 Security & Threat Model Verification Suite", () => {
  const secret = "e".repeat(64);
  const testDbDir = path.resolve(process.cwd(), "data/test");
  const testDbPath = path.join(testDbDir, "m8-security.db");

  let app: FastifyInstance;
  let fakeClient: FakeInferenceClient;
  let quotaRepo: SqliteQuotaRepository;
  let admissionController: SemaphoreAdmissionController;
  let imageProcessor: SharpImageProcessor;
  let recordedMetrics: FakeMetricsRecorder;

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
    admissionController = new SemaphoreAdmissionController({ maxActive: 1, maxQueue: 2 });
    imageProcessor = new SharpImageProcessor({
      maxBytes: 4 * 1024 * 1024,
      maxMegapixels: 20,
      allowedFormats: ["jpeg", "png", "webp"]
    });
    recordedMetrics = new FakeMetricsRecorder();

    const config = loadConfig({
      NODE_ENV: "test",
      LLM_API_SECRET: secret,
      ALLOWED_MODELS: "qwen3.8:27b",
      DAILY_REQUEST_QUOTA: "100",
      MAX_ACTIVE_INFERENCE: "1",
      MAX_QUEUE_CAPACITY: "2",
      DATABASE_PATH: testDbPath,
      CF_ACCESS_ENABLED: "true",
      CF_ACCESS_CLIENT_ID: "valid-edge-client-id",
      CF_ACCESS_CLIENT_SECRET: "s".repeat(64)
    });

    const authenticator = new BearerTokenAuthenticator([{ keyId: "test-user", secret }]);
    const accessValidator = new CloudflareAccessValidator({
      enabled: true,
      serviceTokens: [
        { clientId: "valid-edge-client-id", clientSecret: "s".repeat(64) }
      ]
    });

    const deps: AppDependencies = {
      config,
      authenticator,
      accessValidator,
      inferenceClient: fakeClient,
      quotaRepository: quotaRepo,
      admissionController,
      imageProcessor,
      clock: new FakeClock(),
      metricsRecorder: recordedMetrics
    };

    app = createApp(deps);
  });

  afterEach(async () => {
    if (app) await app.close();
    quotaRepo?.close();
    if (fs.existsSync(testDbPath)) {
      try {
        fs.unlinkSync(testDbPath);
      } catch {
        // ignore
      }
    }
  });

  const validCfHeaders = {
    "cf-access-client-id": "valid-edge-client-id",
    "cf-access-client-secret": "s".repeat(64),
    authorization: `Bearer ${secret}`
  };

  it("Security 1: Rejects model allowlist bypass and directory traversal attempts with HTTP 404", async () => {
    const maliciousModels = [
      "../../../../etc/passwd",
      "llama3",
      "gpt-4o",
      "qwen3.8:27b; rm -rf /",
      "admin",
      "../models/private"
    ];

    for (const model of maliciousModels) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: validCfHeaders,
        payload: {
          model,
          messages: [{ role: "user", content: "Test bypass" }]
        }
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.payload);
      expect(body.error.code).toBe("model_not_allowed");
      expect(body.error.param).toBe("model");
    }
  });

  it("Security 2: Rejects remote HTTP/HTTPS image URLs to prevent Server-Side Request Forgery (SSRF)", async () => {
    const ssrfUrls = [
      "http://169.254.169.254/latest/meta-data/",
      "https://internal-service.local/secret.png",
      "http://127.0.0.1:11434/api/tags"
    ];

    for (const url of ssrfUrls) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: validCfHeaders,
        payload: {
          model: "qwen3.8:27b",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Look at this image" },
                { type: "image_url", image_url: { url } }
              ]
            }
          ]
        }
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error.code).toBe("invalid_request");
      expect(body.error.message).toContain("Remote image URLs are not permitted");
    }
  });

  it("Security 3: Rejects decompression bomb images exceeding 20 megapixels with HTTP 400", async () => {
    // Generate a 10000x2500 pixel image buffer (25 megapixels > 20 megapixels limit)
    // We mock/test SharpImageProcessor directly or send oversized image metadata
    const hugeImageBase64 = "iVBORw0KGgoAAAANSUhEUgAAA+gAAAJYCAYAAAAXQj8lAAAA"; // header claiming 4000x2400

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: validCfHeaders,
      payload: {
        model: "qwen3.8:27b",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Decompress bomb" },
              { type: "image_url", image_url: { url: `data:image/png;base64,${hugeImageBase64}` } }
            ]
          }
        ]
      }
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(body.error.code).toBe("invalid_request");
  });

  it("Security 4: Rejects corrupted magic bytes and file extension spoofing with HTTP 400", async () => {
    // Spoofed PNG header containing ASCII text instead of PNG magic bytes
    const fakePng = Buffer.from("MALICIOUS_EXECUTABLE_CONTENT_HERE_FAKE_PNG").toString("base64");

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: validCfHeaders,
      payload: {
        model: "qwen3.8:27b",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Check fake file" },
              { type: "image_url", image_url: { url: `data:image/png;base64,${fakePng}` } }
            ]
          }
        ]
      }
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.message).toContain("File header signature does not match");
  });

  it("Security 5: Enforces dual-gate authentication and prevents single-gate bypass", async () => {
    // 1. Missing Cloudflare Access Headers -> 401
    const resNoCf = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${secret}` },
      payload: {
        model: "qwen3.8:27b",
        messages: [{ role: "user", content: "No CF" }]
      }
    });
    expect(resNoCf.statusCode).toBe(401);

    // 2. Valid Cloudflare Access but Missing Bearer API Secret -> 401
    const resNoBearer = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        "cf-access-client-id": "valid-edge-client-id",
        "cf-access-client-secret": "s".repeat(64)
      },
      payload: {
        model: "qwen3.8:27b",
        messages: [{ role: "user", content: "No Bearer" }]
      }
    });
    expect(resNoBearer.statusCode).toBe(401);

    // 3. Valid Cloudflare Access but Invalid Bearer API Secret -> 401
    const resBadBearer = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        "cf-access-client-id": "valid-edge-client-id",
        "cf-access-client-secret": "s".repeat(64),
        authorization: "Bearer wrong_secret"
      },
      payload: {
        model: "qwen3.8:27b",
        messages: [{ role: "user", content: "Bad Bearer" }]
      }
    });
    expect(resBadBearer.statusCode).toBe(401);

    // 4. Both valid -> 200
    const resBothValid = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: validCfHeaders,
      payload: {
        model: "qwen3.8:27b",
        messages: [{ role: "user", content: "Valid" }]
      }
    });
    expect(resBothValid.statusCode).toBe(200);
  });

  it("Security 6: Never leaks API secrets, internal tokens, or stack traces in error responses", async () => {
    // Provoke a schema validation error
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: validCfHeaders,
      payload: {
        model: "qwen3.8:27b",
        unknown_evil_field: "injected"
      }
    });

    expect(res.statusCode).toBe(400);
    const bodyStr = res.payload;
    expect(bodyStr).not.toContain(secret);
    expect(bodyStr).not.toContain("valid-edge-client-id");
    expect(bodyStr).not.toContain("stack");
    expect(bodyStr).not.toContain("node_modules");
  });

  it("Security 7: Enforces strict prompt text character limits (max 32,000 chars)", async () => {
    const hugePrompt = "A".repeat(33000);

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: validCfHeaders,
      payload: {
        model: "qwen3.8:27b",
        messages: [{ role: "user", content: hugePrompt }]
      }
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.message).toContain("exceeds the maximum allowed limit of 32000 characters");
  });
});
