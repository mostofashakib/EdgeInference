import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp, type AppDependencies } from "../../gateway/src/app.js";
import { BearerTokenAuthenticator } from "../../gateway/src/infrastructure/auth/BearerTokenAuthenticator.js";
import { loadConfig } from "../../gateway/src/config/AppConfig.js";
import {
  FakeInferenceClient,
  FakeQuotaRepository,
  FakeAdmissionController,
  FakeImageProcessor,
  FakeClock,
  FakeMetricsRecorder
} from "../fakes/index.js";

describe("M2 API Skeleton, Dependency Injection & Authentication", () => {
  const primarySecret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const secondarySecret = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

  let app: FastifyInstance;
  let fakeInference: FakeInferenceClient;
  let fakeQuota: FakeQuotaRepository;
  let fakeAdmission: FakeAdmissionController;
  let fakeClock: FakeClock;
  let fakeMetrics: FakeMetricsRecorder;
  let deps: AppDependencies;

  beforeEach(() => {
    fakeInference = new FakeInferenceClient();
    fakeQuota = new FakeQuotaRepository();
    fakeAdmission = new FakeAdmissionController();
    fakeClock = new FakeClock();
    fakeMetrics = new FakeMetricsRecorder();

    const config = loadConfig({
      NODE_ENV: "test",
      LLM_API_SECRET: primarySecret,
      LLM_API_SECRET_PREVIOUS: secondarySecret,
      ALLOWED_MODELS: "qwen3.8:27b",
      MAX_BODY_BYTES: "1024" // 1 KB for test body size verification
    });

    const authenticator = new BearerTokenAuthenticator([
      { keyId: "key-primary", secret: primarySecret },
      { keyId: "key-secondary", secret: secondarySecret }
    ]);

    deps = {
      config,
      authenticator,
      inferenceClient: fakeInference,
      quotaRepository: fakeQuota,
      admissionController: fakeAdmission,
      imageProcessor: new FakeImageProcessor(),
      clock: fakeClock,
      metricsRecorder: fakeMetrics
    };

    app = createApp(deps);
  });

  afterEach(async () => {
    await app.close();
  });

  describe("Authentication Gate (onRequest hook)", () => {
    it("returns HTTP 401 when Authorization header is missing", async () => {
      // Act
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: {
          model: "qwen3.8:27b",
          messages: [{ role: "user", content: "Hello" }]
        }
      });

      // Assert
      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.payload);
      expect(body.error.type).toBe("authentication_error");
      expect(body.error.code).toBe("unauthorized");
      // Verify inference client was never invoked
      expect(fakeInference.generateCallCount).toBe(0);
    });

    it("returns HTTP 401 when token is empty (Bearer without token)", async () => {
      // Act
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: "Bearer " },
        payload: {
          model: "qwen3.8:27b",
          messages: [{ role: "user", content: "Hello" }]
        }
      });

      // Assert
      expect(res.statusCode).toBe(401);
      expect(fakeInference.generateCallCount).toBe(0);
    });

    it("returns HTTP 401 when Authorization scheme is not Bearer", async () => {
      // Act
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Basic ${primarySecret}` },
        payload: {
          model: "qwen3.8:27b",
          messages: [{ role: "user", content: "Hello" }]
        }
      });

      // Assert
      expect(res.statusCode).toBe(401);
      expect(fakeInference.generateCallCount).toBe(0);
    });

    it("returns HTTP 401 when secret token is incorrect", async () => {
      // Act
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: "Bearer incorrect_api_secret_value" },
        payload: {
          model: "qwen3.8:27b",
          messages: [{ role: "user", content: "Hello" }]
        }
      });

      // Assert
      expect(res.statusCode).toBe(401);
      expect(fakeInference.generateCallCount).toBe(0);
    });

    it("ensures secret values never appear in response payloads", async () => {
      const badSecret = "secret_attempt_super_sensitive_token";
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${badSecret}` },
        payload: {
          model: "qwen3.8:27b",
          messages: [{ role: "user", content: "Hello" }]
        }
      });

      expect(res.statusCode).toBe(401);
      expect(res.payload).not.toContain(badSecret);
      expect(res.payload).not.toContain(primarySecret);
    });

    it("authenticates successfully with rotated/secondary secret", async () => {
      // Act
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${secondarySecret}` },
        payload: {
          model: "qwen3.8:27b",
          messages: [{ role: "user", content: "Hello secondary" }]
        }
      });

      // Assert
      expect(res.statusCode).toBe(200);
      expect(fakeInference.generateCallCount).toBe(1);
    });
  });

  describe("API Skeleton & Dependency Injection", () => {
    it("returns fake inference completion with valid credentials", async () => {
      // Act
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${primarySecret}` },
        payload: {
          model: "qwen3.8:27b",
          messages: [{ role: "user", content: "Ping" }]
        }
      });

      // Assert
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.id).toBe("fake-chatcmpl-123");
      expect(body.object).toBe("chat.completion");
      expect(body.choices[0].message.content).toBe("Hello from FakeInferenceClient!");
      expect(fakeInference.generateCallCount).toBe(1);
      expect(fakeAdmission.acquireCallCount).toBe(1);
      expect(fakeAdmission.activeLeases.length).toBe(0); // released in finally block!
    });

    it("verifies dependency implementations can be swapped without modifying app code", async () => {
      // Arrange: swap canned response on fake client
      fakeInference.cannedResponse = {
        id: "swapped-response-999",
        object: "chat.completion",
        created: 1730009999,
        model: "qwen3.8:27b",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Swapped dynamic response" },
            finish_reason: "stop"
          }
        ]
      };

      // Act
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${primarySecret}` },
        payload: {
          model: "qwen3.8:27b",
          messages: [{ role: "user", content: "Testing swap" }]
        }
      });

      // Assert
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.id).toBe("swapped-response-999");
      expect(body.choices[0].message.content).toBe("Swapped dynamic response");
    });

    it("streams chunked SSE responses when stream=true", async () => {
      // Act
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${primarySecret}` },
        payload: {
          model: "qwen3.8:27b",
          messages: [{ role: "user", content: "Stream me" }],
          stream: true
        }
      });

      // Assert
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/event-stream");
      expect(res.headers["x-accel-buffering"]).toBe("no");
      expect(res.payload).toContain("data: {\"id\":\"fake-chatcmpl-123\"");
      expect(res.payload).toContain("data: [DONE]");
      expect(fakeInference.streamCallCount).toBe(1);
    });

    it("allows unauthenticated access to /health", async () => {
      // Act
      const res = await app.inject({
        method: "GET",
        url: "/health"
      });

      // Assert
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.status).toBe("healthy");
      expect(body.timestamp).toBe("2026-11-01T12:00:00.000Z");
    });

    it("rejects unknown routes with HTTP 404", async () => {
      // Act
      const res = await app.inject({
        method: "GET",
        url: "/unknown/route",
        headers: { authorization: `Bearer ${primarySecret}` }
      });

      // Assert
      expect(res.statusCode).toBe(404);
    });

    it("rejects unsupported models with HTTP 404", async () => {
      // Act
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${primarySecret}` },
        payload: {
          model: "unsupported-model-v1",
          messages: [{ role: "user", content: "Hello" }]
        }
      });

      // Assert
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.payload);
      expect(body.error.code).toBe("model_not_allowed");
    });

    it("rejects payloads that exceed maximum body size with HTTP 413", async () => {
      // Arrange: create a payload > 1024 bytes (test configured limit)
      const bigMessage = "x".repeat(2048);

      // Act
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${primarySecret}` },
        payload: {
          model: "qwen3.8:27b",
          messages: [{ role: "user", content: bigMessage }]
        }
      });

      // Assert
      expect(res.statusCode).toBe(413);
    });
  });

  describe("Configuration & Startup Security Validation", () => {
    it("fails startup validation if production secret has less than 256 bits of entropy", () => {
      // Act & Assert
      expect(() => {
        loadConfig({
          NODE_ENV: "production",
          LLM_API_SECRET: "short_insecure_secret_123"
        });
      }).toThrow(/minimum 64 characters/i);
    });

    it("succeeds startup validation if production secret has at least 64 hex characters", () => {
      // Act
      const config = loadConfig({
        NODE_ENV: "production",
        LLM_API_SECRET: "a".repeat(64)
      });

      // Assert
      expect(config.primaryApiKey).toBe("a".repeat(64));
    });
  });
});
