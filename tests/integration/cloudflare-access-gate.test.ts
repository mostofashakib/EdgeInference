import { hashSecretSha256 } from "../../gateway/src/client/cryptoAuth.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp, type AppDependencies } from "../../gateway/src/app.js";
import { BearerTokenAuthenticator } from "../../gateway/src/infrastructure/auth/BearerTokenAuthenticator.js";
import { CloudflareAccessValidator } from "../../gateway/src/infrastructure/auth/CloudflareAccessValidator.js";
import { loadConfig } from "../../gateway/src/config/AppConfig.js";
import {
  FakeInferenceClient,
  FakeQuotaRepository,
  FakeAdmissionController,
  FakeImageProcessor,
  FakeClock,
  FakeMetricsRecorder
} from "../fakes/index.js";

describe("M6 Cloudflare Access & Dual-Authentication Gate", () => {
  const validCfClientId = "cf-id-test-123456789";
  const validCfClientSecret = "cf-secret-test-9876543210abcdef9876543210abcdef";
  const validApiSecret = "a".repeat(64);

  let app: FastifyInstance;
  let fakeClient: FakeInferenceClient;

  beforeEach(() => {
    fakeClient = new FakeInferenceClient();

    const config = loadConfig({
      NODE_ENV: "test",
      LLM_API_SECRET: validApiSecret,
      ALLOWED_MODELS: "qwen3.8:27b",
      CF_ACCESS_ENABLED: "true",
      CF_ACCESS_CLIENT_ID: validCfClientId,
      CF_ACCESS_CLIENT_SECRET: validCfClientSecret
    });

    const authenticator = new BearerTokenAuthenticator([
      { keyId: "test-user", secret: validApiSecret }
    ]);

    const accessValidator = new CloudflareAccessValidator({
      enabled: true,
      serviceTokens: [
        { clientId: validCfClientId, clientSecret: validCfClientSecret }
      ]
    });

    const deps: AppDependencies = {
      config,
      authenticator,
      accessValidator,
      inferenceClient: fakeClient,
      quotaRepository: new FakeQuotaRepository(),
      admissionController: new FakeAdmissionController(),
      imageProcessor: new FakeImageProcessor(),
      clock: new FakeClock(),
      metricsRecorder: new FakeMetricsRecorder()
    };

    app = createApp(deps);
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  // Test Matrix from M6 Requirements:
  it("[State 1] Invalid CF credentials + Invalid API secret -> Denied", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        "cf-access-client-id": "wrong-cf-id",
        "cf-access-client-secret": "wrong-cf-secret",
        "authorization": "Bearer wrong_api_secret"
      },
      payload: {
        model: "qwen3.8:27b",
        messages: [{ role: "user", content: "Hi" }]
      }
    });

    expect(res.statusCode).toBe(401);
    expect(fakeClient.generateCallCount).toBe(0);
  });

  it("[State 2] Valid CF credentials + Missing API secret -> 401 from Gateway", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        "cf-access-client-id": validCfClientId,
        "cf-access-client-secret": validCfClientSecret
        // No Authorization header
      },
      payload: {
        model: "qwen3.8:27b",
        messages: [{ role: "user", content: "Hi" }]
      }
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.payload);
    expect(body.error.code).toBe("unauthorized");
    expect(fakeClient.generateCallCount).toBe(0);
  });

  it("[State 3] Valid CF credentials + Incorrect API secret -> 401 from Gateway", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        "cf-access-client-id": validCfClientId,
        "cf-access-client-secret": validCfClientSecret,
        "authorization": "Bearer incorrect_gateway_secret"
      },
      payload: {
        model: "qwen3.8:27b",
        messages: [{ role: "user", content: "Hi" }]
      }
    });

    expect(res.statusCode).toBe(401);
    expect(fakeClient.generateCallCount).toBe(0);
  });

  it("[State 4] Valid CF credentials + Correct API secret -> Inference Allowed (HTTP 200)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        "cf-access-client-id": validCfClientId,
        "cf-access-client-secret": validCfClientSecret,
        "authorization": `Bearer ${hashSecretSha256(validApiSecret)}`
      },
      payload: {
        model: "qwen3.8:27b",
        messages: [{ role: "user", content: "Hello authenticated world" }]
      }
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.choices[0].message.content).toBe("Hello from FakeInferenceClient!");
    expect(fakeClient.generateCallCount).toBe(1);
  });

  it("[State 5] Missing CF credentials + Correct API secret -> Denied by Cloudflare Validator", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        // Missing cf-access headers
        "authorization": `Bearer ${hashSecretSha256(validApiSecret)}`
      },
      payload: {
        model: "qwen3.8:27b",
        messages: [{ role: "user", content: "Hi" }]
      }
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.payload);
    expect(body.error.message).toMatch(/cloudflare access/i);
    expect(fakeClient.generateCallCount).toBe(0);
  });

  it("[State 6] Revoked CF credentials + Correct API secret -> Denied", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        "cf-access-client-id": "revoked-client-id",
        "cf-access-client-secret": "revoked-client-secret",
        "authorization": `Bearer ${hashSecretSha256(validApiSecret)}`
      },
      payload: {
        model: "qwen3.8:27b",
        messages: [{ role: "user", content: "Hi" }]
      }
    });

    expect(res.statusCode).toBe(401);
    expect(fakeClient.generateCallCount).toBe(0);
  });

  it("verifies health check is allowed without Cloudflare Access credentials for local monitoring", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/health"
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.status).toBe("healthy");
  });
});

