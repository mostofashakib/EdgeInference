import { hashSecretSha256 } from "../../gateway/src/client/cryptoAuth.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { createApp, type AppDependencies } from "../../gateway/src/app.js";
import { BearerTokenAuthenticator } from "../../gateway/src/infrastructure/auth/BearerTokenAuthenticator.js";
import { SharpImageProcessor } from "../../gateway/src/infrastructure/images/SharpImageProcessor.js";
import { loadConfig } from "../../gateway/src/config/AppConfig.js";
import {
  FakeInferenceClient,
  FakeQuotaRepository,
  FakeAdmissionController,
  FakeClock,
  FakeMetricsRecorder
} from "../fakes/index.js";

describe("M3 Gateway Request Validation & Multimodal Inference", () => {
  const secret = "a".repeat(64);
  let app: FastifyInstance;
  let fakeClient: FakeInferenceClient;
  let fakeQuota: FakeQuotaRepository;
  let fakeAdmission: FakeAdmissionController;
  let fakeClock: FakeClock;
  let fakeMetrics: FakeMetricsRecorder;
  let imageProcessor: SharpImageProcessor;

  const fixturesDir = path.resolve(process.cwd(), "tests/fixtures/images");
  const validPngBase64 = fs.readFileSync(path.join(fixturesDir, "shapes.png")).toString("base64");
  const corruptPngBase64 = fs.readFileSync(path.join(fixturesDir, "corrupt.png")).toString("base64");

  beforeEach(() => {
    fakeClient = new FakeInferenceClient();
    fakeQuota = new FakeQuotaRepository();
    fakeAdmission = new FakeAdmissionController();
    fakeClock = new FakeClock();
    fakeMetrics = new FakeMetricsRecorder();

    const config = loadConfig({
      NODE_ENV: "test",
      LLM_API_SECRET: secret,
      ALLOWED_MODELS: "qwen3.8:27b",
      MAX_IMAGE_BYTES: "4194304", // 4 MiB
      MAX_IMAGE_COUNT: "2",
      MAX_IMAGE_MEGAPIXELS: "20",
      MAX_PROMPT_CHARS: "32000"
    });

    imageProcessor = new SharpImageProcessor({
      maxBytes: 4 * 1024 * 1024,
      maxMegapixels: 20,
      allowedFormats: ["jpeg", "png", "webp"]
    });

    const authenticator = new BearerTokenAuthenticator([{ keyId: "test-key", secret }]);

    const deps: AppDependencies = {
      config,
      authenticator,
      inferenceClient: fakeClient,
      quotaRepository: fakeQuota,
      admissionController: fakeAdmission,
      imageProcessor,
      clock: fakeClock,
      metricsRecorder: fakeMetrics
    };

    app = createApp(deps);
  });

  afterEach(async () => {
    await app.close();
  });

  it("successfully processes valid text input through gateway", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${hashSecretSha256(secret)}` },
      payload: {
        model: "qwen3.8:27b",
        messages: [{ role: "user", content: "Tell me a haiku" }]
      }
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.choices[0].message.content).toBe("Hello from FakeInferenceClient!");
    expect(fakeClient.generateCallCount).toBe(1);
  });

  it("successfully validates and normalizes a multimodal input with Base64 image", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${hashSecretSha256(secret)}` },
      payload: {
        model: "qwen3.8:27b",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is this?" },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${validPngBase64}` }
              }
            ]
          }
        ]
      }
    });

    expect(res.statusCode).toBe(200);
    expect(fakeClient.generateCallCount).toBe(1);

    // Verify sanitized image was normalized and forwarded
    const forwardedMessages = fakeClient.lastRequest?.messages;
    expect(forwardedMessages).toBeDefined();
    const parts = forwardedMessages![0]!.content as Array<{ type: string; image_url?: { url: string } }>;
    expect(parts[1]?.image_url?.url).toMatch(/^data:image\/png;base64,/);
  });

  it("rejects corrupt image data with HTTP 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${hashSecretSha256(secret)}` },
      payload: {
        model: "qwen3.8:27b",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Analyze this image" },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${corruptPngBase64}` }
              }
            ]
          }
        ]
      }
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(body.error.code).toBe("invalid_request");
    expect(fakeClient.generateCallCount).toBe(0);
  });

  it("rejects remote image URLs (http:// or https://) with HTTP 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${hashSecretSha256(secret)}` },
      payload: {
        model: "qwen3.8:27b",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Check this image" },
              {
                type: "image_url",
                image_url: { url: "https://example.com/malicious.png" }
              }
            ]
          }
        ]
      }
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(body.error.message).toMatch(/remote image urls are not permitted/i);
    expect(fakeClient.generateCallCount).toBe(0);
  });

  it("rejects requests exceeding maximum allowed images count (max 2)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${hashSecretSha256(secret)}` },
      payload: {
        model: "qwen3.8:27b",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Three images" },
              { type: "image_url", image_url: { url: `data:image/png;base64,${validPngBase64}` } },
              { type: "image_url", image_url: { url: `data:image/png;base64,${validPngBase64}` } },
              { type: "image_url", image_url: { url: `data:image/png;base64,${validPngBase64}` } }
            ]
          }
        ]
      }
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(body.error.message).toMatch(/maximum of 2 images/i);
    expect(fakeClient.generateCallCount).toBe(0);
  });

  it("rejects unsupported API parameters with HTTP 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${hashSecretSha256(secret)}` },
      payload: {
        model: "qwen3.8:27b",
        messages: [{ role: "user", content: "Hi" }],
        unsupported_custom_param: 12345
      }
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(body.error.type).toBe("invalid_request_error");
    expect(fakeClient.generateCallCount).toBe(0);
  });

  it("rejects prompt text exceeding maximum characters limit", async () => {
    const longPrompt = "a".repeat(32001);
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${hashSecretSha256(secret)}` },
      payload: {
        model: "qwen3.8:27b",
        messages: [{ role: "user", content: longPrompt }]
      }
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(body.error.message).toMatch(/exceeds the maximum allowed limit/i);
  });
});

