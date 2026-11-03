import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { createApp, type AppDependencies } from "../../gateway/src/app.js";
import { BearerTokenAuthenticator } from "../../gateway/src/infrastructure/auth/BearerTokenAuthenticator.js";
import { loadConfig } from "../../gateway/src/config/AppConfig.js";
import { createHmacAuthHeaders, hashSecretSha256 } from "../../gateway/src/client/cryptoAuth.js";
import {
  FakeInferenceClient,
  FakeQuotaRepository,
  FakeAdmissionController,
  FakeImageProcessor,
  FakeClock,
  FakeMetricsRecorder
} from "../fakes/index.js";

describe("End-to-End User Flows & DDoS Abuse Defense", () => {
  const ownerSecret = "1111111111111111111111111111111111111111111111111111111111111111";
  const guestSecret = "2222222222222222222222222222222222222222222222222222222222222222";

  let app: FastifyInstance;
  let fakeInference: FakeInferenceClient;
  let fakeQuota: FakeQuotaRepository;
  let fakeAdmission: FakeAdmissionController;
  let fakeClock: FakeClock;
  let fakeMetrics: FakeMetricsRecorder;
  let fakeImageProcessor: FakeImageProcessor;

  const fixturesDir = path.resolve(process.cwd(), "tests/fixtures/images");
  const testPngBase64 = fs.readFileSync(path.join(fixturesDir, "shapes.png")).toString("base64");

  beforeEach(() => {
    fakeInference = new FakeInferenceClient();
    fakeQuota = new FakeQuotaRepository();
    fakeAdmission = new FakeAdmissionController();
    fakeClock = new FakeClock();
    fakeMetrics = new FakeMetricsRecorder();
    fakeImageProcessor = new FakeImageProcessor();

    const config = loadConfig({
      NODE_ENV: "test",
      LLM_API_SECRET: ownerSecret,
      LLM_GUEST_API_KEYS: guestSecret,
      GUEST_RATE_LIMIT_PER_MINUTE: "3",
      GUEST_DAILY_QUOTA: "5",
      ALLOWED_MODELS: "qwen3.8:27b",
      MAX_BODY_BYTES: "1048576" // 1 MB
    });

    const authenticator = new BearerTokenAuthenticator([
      { keyId: "owner-primary", secret: ownerSecret, role: "owner" },
      { keyId: "guest-user", secret: guestSecret, role: "guest" }
    ]);

    const deps: AppDependencies = {
      config,
      authenticator,
      inferenceClient: fakeInference,
      quotaRepository: fakeQuota,
      admissionController: fakeAdmission,
      imageProcessor: fakeImageProcessor,
      clock: fakeClock,
      metricsRecorder: fakeMetrics
    };

    app = createApp(deps);
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  // FLOW 1: Owner Interactive Chat Flow
  it("Flow 1: Owner Multi-Turn Interactive Chat Flow succeeds with standard schema", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${hashSecretSha256(ownerSecret)}`
      },
      payload: {
        model: "qwen3.8:27b",
        messages: [
          { role: "system", content: "You are an expert AI assistant." },
          { role: "user", content: "Hello! What is edge inference?" }
        ],
        temperature: 0.7,
        max_tokens: 500
      }
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("qwen3.8:27b");
    expect(body.choices).toHaveLength(1);
    expect(body.choices[0].message.role).toBe("assistant");
    expect(body.choices[0].message.content).toBe("Hello from FakeInferenceClient!");
    expect(body.usage).toBeDefined();
    expect(body.usage.total_tokens).toBe(15);
    expect(fakeInference.generateCallCount).toBe(1);
  });

  // FLOW 2: Owner Multimodal Image Understanding Flow
  it("Flow 2: Owner Multimodal Vision Flow processes Base64 images", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${hashSecretSha256(ownerSecret)}`
      },
      payload: {
        model: "qwen3.8:27b",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What shapes are in this image?" },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${testPngBase64}` }
              }
            ]
          }
        ]
      }
    });

    expect(res.statusCode).toBe(200);
    expect(fakeImageProcessor.validateCallCount).toBe(1);
    const body = JSON.parse(res.payload);
    expect(body.choices[0].message.content).toBe("Hello from FakeInferenceClient!");
  });

  // FLOW 3: Owner Complex Reasoning Flow
  it("Flow 3: Owner Complex Reasoning Flow delivers structured completion", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${hashSecretSha256(ownerSecret)}`
      },
      payload: {
        model: "qwen3.8:27b",
        messages: [
          {
            role: "user",
            content: "Solve: If Alice has 3 apples and Bob gives her 5 times as many as Charlie has (Charlie has 2), how many does Alice have?"
          }
        ],
        temperature: 0.1
      }
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.choices[0].finish_reason).toBe("stop");
  });

  // FLOW 4: Owner Real-Time Unbuffered Streaming Flow
  it("Flow 4: Owner Real-Time Streaming Flow streams SSE tokens and terminates with [DONE]", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${hashSecretSha256(ownerSecret)}`
      },
      payload: {
        model: "qwen3.8:27b",
        messages: [{ role: "user", content: "Count from 1 to 5 progressively." }],
        stream: true
      }
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.payload).toContain("data: {\"id\":\"fake-chatcmpl-123\"");
    expect(res.payload).toContain("data: [DONE]");
    expect(fakeInference.streamCallCount).toBe(1);
  });

  // FLOW 5: Non-Owner Burst / DDoS Rate Limiting Defense
  it("Flow 5: Non-Owner DDoS Defense strictly limits guests to 3 req/min with HTTP 429", async () => {
    const guestHeaders = {
      "content-type": "application/json",
      authorization: `Bearer ${hashSecretSha256(guestSecret)}`
    };

    const makeRequest = (i: number) =>
      app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: guestHeaders,
        payload: {
          model: "qwen3.8:27b",
          messages: [{ role: "user", content: `Guest flood attempt ${i}` }]
        }
      });

    // Request 1: Allowed (1/3)
    const r1 = await makeRequest(1);
    expect(r1.statusCode).toBe(200);

    // Request 2: Allowed (2/3)
    const r2 = await makeRequest(2);
    expect(r2.statusCode).toBe(200);

    // Request 3: Allowed (3/3)
    const r3 = await makeRequest(3);
    expect(r3.statusCode).toBe(200);

    // Request 4 (exceeds 3 req/min): Rejected with HTTP 429
    const r4 = await makeRequest(4);
    expect(r4.statusCode).toBe(429);
    const body4 = JSON.parse(r4.payload);
    expect(body4.error.code).toBe("rate_limit_exceeded");
    expect(body4.error.type).toBe("rate_limit_error");
    expect(body4.error.message).toContain("Rate limit exceeded");

    // Request 5 (excess flood): Still blocked
    const r5 = await makeRequest(5);
    expect(r5.statusCode).toBe(429);
  });

  // FLOW 6: Owner Immunity During Non-Owner DDoS Attack
  it("Flow 6: Owner remains completely unthrottled even while non-owners are blocked by DDoS limits", async () => {
    const guestHeaders = {
      "content-type": "application/json",
      authorization: `Bearer ${hashSecretSha256(guestSecret)}`
    };
    const ownerHeaders = {
      "content-type": "application/json",
      authorization: `Bearer ${hashSecretSha256(ownerSecret)}`
    };

    // 1. Guest exhausts their rate limit
    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: guestHeaders,
        payload: {
          model: "qwen3.8:27b",
          messages: [{ role: "user", content: `Guest request ${i}` }]
        }
      });
    }

    // Guest is now blocked
    const guestBlocked = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: guestHeaders,
      payload: {
        model: "qwen3.8:27b",
        messages: [{ role: "user", content: "Guest request when blocked" }]
      }
    });
    expect(guestBlocked.statusCode).toBe(429);

    // 2. Owner sends multiple rapid requests immediately afterwards
    for (let i = 0; i < 10; i++) {
      const ownerRes = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: ownerHeaders,
        payload: {
          model: "qwen3.8:27b",
          messages: [{ role: "user", content: `Owner uninterrupted request ${i}` }]
        }
      });
      expect(ownerRes.statusCode).toBe(200);
    }
  });

  // FLOW 7: Non-Owner Daily Quota Protection
  it("Flow 7: Non-Owner Daily Quota Protection triggers HTTP 429 when daily budget is exhausted", async () => {
    const guestHeaders = {
      "content-type": "application/json",
      authorization: `Bearer ${hashSecretSha256(guestSecret)}`
    };

    // Simulate quota repository returning exhausted quota
    fakeQuota.shouldGrant = false;

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: guestHeaders,
      payload: {
        model: "qwen3.8:27b",
        messages: [{ role: "user", content: "Daily quota check" }]
      }
    });

    expect(res.statusCode).toBe(429);
    const body = JSON.parse(res.payload);
    expect(body.error.code).toBe("quota_exceeded");
  });

  // FLOW 8: Unauthorized / Malicious Access Rejection
  it("Flow 8: Unauthenticated requests or invalid secrets are immediately rejected with HTTP 401", async () => {
    // Missing Authorization header
    const r1 = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "content-type": "application/json" },
      payload: {
        model: "qwen3.8:27b",
        messages: [{ role: "user", content: "Unauthenticated" }]
      }
    });
    expect(r1.statusCode).toBe(401);

    // Invalid secret
    const r2 = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer invalid_secret_attack"
      },
      payload: {
        model: "qwen3.8:27b",
        messages: [{ role: "user", content: "Attack" }]
      }
    });
    expect(r2.statusCode).toBe(401);
  });

  // FLOW 9: Multi-Application HMAC-SHA256 Cryptographic Request Signing Flow
  it("Flow 9: Client application authenticates via dynamic HMAC-SHA256 signature without transmitting raw secret", async () => {
    // Generate signature using client helper matching clock; raw secret never goes over HTTP
    const hmacHeaders = createHmacAuthHeaders({
      secret: ownerSecret,
      method: "POST",
      path: "/v1/chat/completions",
      timestamp: Math.floor(fakeClock.now().getTime() / 1000)
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        "content-type": "application/json",
        ...hmacHeaders
      },
      payload: {
        model: "qwen3.8:27b",
        messages: [
          { role: "user", content: "Authenticate securely via HMAC-SHA256." }
        ]
      }
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.choices[0].message.content).toBe("Hello from FakeInferenceClient!");
    expect(fakeInference.generateCallCount).toBe(1);
  });

  // FLOW 10: Multi-Application Pre-Hashed SHA-256 Token Flow
  it("Flow 10: Client application authenticates via pre-hashed SHA-256 token without transmitting raw secret", async () => {
    // Client pre-hashes secret locally; raw secret is never transmitted
    const hashedSecret = hashSecretSha256(ownerSecret);

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${hashedSecret}`
      },
      payload: {
        model: "qwen3.8:27b",
        messages: [
          { role: "user", content: "Authenticate securely via pre-hashed token." }
        ]
      }
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.choices[0].message.content).toBe("Hello from FakeInferenceClient!");
  });
});

